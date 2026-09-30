import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { providerComplete } from "../helper-model/llm";
import { meteredQuery } from "../usage/metered-query";
import { HELPER_MODEL } from "@synapse/shared";
import { loadPrompt } from "../prompts/index";
import type { HostSettings, HostSettingsStore } from "../store/host-settings";
import { log } from "../util/log";
import type { RuleCard, StaticResult } from "./types";

export type CompilerCall = (input: string) => Promise<unknown>;

const EMPTY_TARGETS = { paths: [], hosts: [], domains: [], recipients: [], channels: [], repos: [] };

export function ruleHash(text: string, behavior: "allow" | "ask"): string {
  return createHash("sha256").update(`${behavior}\n${text}`).digest("hex").slice(0, 16);
}

export function ruleCards(s: HostSettings): RuleCard[] {
  const make = (text: string, i: number, behavior: "allow" | "ask"): RuleCard => {
    const id = `${behavior === "allow" ? "A" : "K"}${i + 1}`;
    const compiled = s.autoReviewCompiled[ruleHash(text, behavior)] as Partial<RuleCard> | undefined;
    return {
      id, text, behavior,
      surfaces: compiled?.surfaces ?? ["any"], services: compiled?.services ?? [], verbs: compiled?.verbs ?? [],
      targets: { ...EMPTY_TARGETS, ...(compiled?.targets ?? {}) }, conditions: compiled?.conditions ?? [], breadth: compiled?.breadth ?? "broad",
    };
  };
  return [
    ...s.autoReviewInstructions.allowInstructions.map((t, i) => make(t, i, "allow")),
    ...s.autoReviewInstructions.blockInstructions.map((t, i) => make(t, i, "ask")),
  ];
}

export async function compileRule(rule: { id: string; behavior: "allow" | "ask"; text: string }, run: CompilerCall): Promise<RuleCard> {
  try {
    const out = (await run(JSON.stringify(rule))) as Partial<RuleCard>;
    return { ...rule, surfaces: out.surfaces ?? ["any"], services: out.services ?? [], verbs: out.verbs ?? [], targets: { ...EMPTY_TARGETS, ...(out.targets ?? {}) }, conditions: out.conditions ?? [], breadth: out.breadth ?? "broad" };
  } catch (e) {
    log.warn("rule compile failed; using the conservative reading", { id: rule.id, error: String(e) });
    return { ...rule, surfaces: ["any"], services: [], verbs: [], targets: { ...EMPTY_TARGETS }, conditions: [], breadth: "broad" };
  }
}

/** Compiles every rule that has no stored reading yet, then drops readings of deleted rules. */
export async function compileAll(settings: HostSettingsStore, run: CompilerCall): Promise<void> {
  const s = settings.get();
  const next: Record<string, unknown> = {};
  const lists: [string[], "allow" | "ask", string][] = [[s.autoReviewInstructions.allowInstructions, "allow", "A"], [s.autoReviewInstructions.blockInstructions, "ask", "K"]];
  for (const [list, behavior, prefix] of lists) {
    for (const [i, text] of list.entries()) {
      const h = ruleHash(text, behavior);
      next[h] = s.autoReviewCompiled[h] ?? (await compileRule({ id: `${prefix}${i + 1}`, behavior, text }, run));
    }
  }
  settings.setCompiled(next);
}

const RULE_CARD_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["surfaces", "services", "verbs", "targets", "conditions", "breadth"],
  properties: {
    surfaces: { type: "array", items: { enum: ["box_shell", "host_shell", "computer", "mcp", "subagent", "cloud_agent", "automation_write", "any"] } },
    services: { type: "array", items: { type: "string" } },
    verbs: { type: "array", items: { enum: ["read", "run", "create", "update", "delete", "send", "post", "publish", "share", "purchase", "install", "click", "type", "schedule"] } },
    targets: {
      type: "object", additionalProperties: false, required: ["paths", "hosts", "domains", "recipients", "channels", "repos"],
      properties: Object.fromEntries(["paths", "hosts", "domains", "recipients", "channels", "repos"].map((k) => [k, { type: "array", items: { type: "string" } }])),
    },
    conditions: { type: "array", items: { type: "string" } },
    breadth: { enum: ["narrow", "moderate", "broad"] },
  },
};

/** One-shot, tool-less Haiku call with structured output (ORIG-01 §01.5). */
export function sdkCompilerCall(o: { env: Record<string, string>; pathToClaudeCodeExecutable?: string; cwd: string }): CompilerCall {
  return async (input) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      for await (const m of meteredQuery({ purpose: "rule-compile", botId: null }, {
        prompt: input,
        options: {
          model: HELPER_MODEL, systemPrompt: loadPrompt("orig/rule-compiler.md"), settingSources: [], mcpServers: {}, tools: [],
          thinking: { type: "disabled" }, // same default-thinking latency as the reviewer (§01.9)
          maxTurns: 2, persistSession: false, cwd: o.cwd, env: { ...o.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
          pathToClaudeCodeExecutable: o.pathToClaudeCodeExecutable, abortController: ac,
          outputFormat: { type: "json_schema", schema: RULE_CARD_SCHEMA },
        },
      })) {
        const r = m as { type: string; structured_output?: unknown; is_error?: boolean };
        if (r.type === "result") {
          if (r.is_error || !r.structured_output) throw new Error("rule compiler returned no structured output");
          return r.structured_output;
        }
      }
      throw new Error("rule compiler ended without a result");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** ORIG-01 §01.4: tier 0 and no Ask-first rule touches the command. */
export function fastPathAllowed(req: { surface: string; staticResult: StaticResult; paths: string[] }, cards: RuleCard[]): boolean {
  const dev = req.staticResult.devFastPath === true; // S1: an engineering Bot's build/test/commit command
  if (!(req.staticResult.readOnly || dev) || req.staticResult.tierHint !== 0) return false;
  for (const c of cards) {
    if (c.behavior !== "ask") continue;
    const surfaceHit = c.surfaces.includes("any") || c.surfaces.includes(req.surface);
    // A dev command also writes (build output, git add/commit), so an Ask-first rule on create/update covers it too.
    const verbHit = c.verbs.length === 0 || c.verbs.includes("read") || c.verbs.includes("run") || (dev && (c.verbs.includes("create") || c.verbs.includes("update")));
    // speed-fastpath: a shell call's paths are its cwd and the files its reads open (approval-gate). A folder that
    // CONTAINS the rule's target counts too: a recursive read from it (`grep -r x .`) reaches the target.
    // Fix round 1: the rule's folder is compared by its text and by its real path (the gate passes both for the reads).
    const pathHit = c.targets.paths.length === 0 || req.paths.some((p) => c.targets.paths.some((t) => {
      const rp = path.resolve(p);
      return [path.resolve(t), realOr(t)].some((rt) => rp.startsWith(rt) || rt.startsWith(`${rp}/`));
    }));
    if (surfaceHit && verbHit && pathHit) return false;
  }
  return true;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** Spec §7a row 3: the rule compiler on a provider's (qualified) reviewer model. */
/** The rule compiler on Claude through the Messages adapter (no Agent SDK): the SDK call's prompt and schema, as is. */
export function claudeMessagesCompilerCall(ref: string = HELPER_MODEL): CompilerCall {
  return async (input) => {
    const r = await providerComplete({ purpose: "rule-compile", botId: null, ref, system: loadPrompt("orig/rule-compiler.md"), user: input, schema: RULE_CARD_SCHEMA, timeoutMs: 30_000, maxTokens: 1_000 });
    return r.json;
  };
}

export function providerCompilerCall(ref: string): CompilerCall {
  return async (input) => {
    const r = await providerComplete({ purpose: "rule-compile", botId: null, ref, system: `${loadPrompt("orig/rule-compiler.md")}\n\nReply with one JSON object only.`, user: input, schema: RULE_CARD_SCHEMA, timeoutMs: 30_000, maxTokens: 1_000 });
    return r.json;
  };
}


// ---------------------------------------------------------------------------------------------------------------
// Safety v2: the same rule compiler, asked for the v2 matcher (shared/safety-rules.ts). It is asked only when the
// deterministic grammar can't read a rule, and its answer is checked strictly (validateModelRule): anything it didn't
// read goes in `unmatched`, and anything unmatched or unknown rejects the rule. Never a guess.
// ---------------------------------------------------------------------------------------------------------------

export const RULE_V2_SCHEMA = {
  type: "object", additionalProperties: false, required: ["clean", "unmatched", "type", "kinds", "scope", "limits"],
  properties: {
    clean: { type: "boolean" },
    unmatched: { type: "string" },
    type: { enum: ["allow", "ask", "never"] },
    kinds: { type: "array", items: { enum: ["send", "delete", "pay", "upload", "fetch-run", "git", "sudo", "global-install", "app-write", "access", "command", "file-write", "browse", "mac", "any"] } },
    scope: {
      type: "object", additionalProperties: false, required: ["bots", "apps", "accounts", "paths", "people", "domains"],
      properties: Object.fromEntries(["bots", "apps", "accounts", "paths", "people", "domains"].map((k) => [k, { type: "array", items: { type: "string" } }])),
    },
    limits: {
      type: "object", additionalProperties: false, required: ["overAmount", "perHour", "between"],
      properties: {
        overAmount: { type: ["number", "null"] },
        perHour: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["max", "per"], properties: { max: { type: "integer" }, per: { enum: ["bot", "all"] } } }] },
        between: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } }] },
      },
    },
  },
};

export const RULE_V2_PROMPT = `You turn one plain-English safety rule into an exact matcher. Input: {"text": the rule, "bots": [{id, name}]}.
Output JSON only, with these fields:
- type: "allow" (always allow / don't ask), "ask" (ask first), or "never" (never / don't / block / at most N).
- kinds: what actions it covers, from: send, delete, pay, upload, fetch-run, git, sudo, global-install, app-write, access, command, file-write, browse, mac, any.
- scope: bots (ids from the input only), apps (gmail, calendar, drive, slack, notion, github, linear, discord, telegram, whatsapp, messages, twitter, jira, trello, asana, dropbox, s3, stripe, shopify, outlook, mac, box, browser, docs, sheets), accounts (email addresses the action is sent FROM), paths (absolute or ~/ folders), people (email addresses), domains (site or email domains like example.com). Use [] for any.
- limits: overAmount (a number, for "over $50"), perHour ({max, per: "bot" | "all"} for "at most N an hour"), between ({from, to} as HH:MM 24-hour, for a time window). null when absent.
- unmatched: every word of the rule you could NOT express exactly with the fields above (a person named without an address, "important", "risky", "my boss", "big"). "" when everything was expressed.
- clean: true only when unmatched is "" and every field is exact. Never guess an address, a site, a folder or an amount.`;

/** The v2 compile call on the reviewer's model, by the same transport the rule compiler uses. */
export function ruleV2Call(run: { kind: "sdk"; env: Record<string, string>; pathToClaudeCodeExecutable?: string; cwd: string } | { kind: "messages"; ref?: string } | { kind: "provider"; ref: string }): (input: string) => Promise<unknown> {
  if (run.kind === "sdk") {
    return async (input) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        for await (const m of meteredQuery({ purpose: "rule-compile", botId: null }, {
          prompt: input,
          options: {
            model: HELPER_MODEL, systemPrompt: RULE_V2_PROMPT, settingSources: [], mcpServers: {}, tools: [], thinking: { type: "disabled" },
            maxTurns: 2, persistSession: false, cwd: run.cwd, env: { ...run.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
            pathToClaudeCodeExecutable: run.pathToClaudeCodeExecutable, abortController: ac, outputFormat: { type: "json_schema", schema: RULE_V2_SCHEMA },
          },
        })) {
          const r = m as { type: string; structured_output?: unknown; is_error?: boolean };
          if (r.type === "result") {
            if (r.is_error || !r.structured_output) throw new Error("rule compiler returned no structured output");
            return r.structured_output;
          }
        }
        throw new Error("rule compiler ended without a result");
      } finally {
        clearTimeout(timer);
      }
    };
  }
  const ref = run.kind === "messages" ? (run.ref ?? HELPER_MODEL) : run.ref;
  const system = run.kind === "provider" ? `${RULE_V2_PROMPT}\n\nReply with one JSON object only.` : RULE_V2_PROMPT;
  return async (input) => (await providerComplete({ purpose: "rule-compile", botId: null, ref, system, user: input, schema: RULE_V2_SCHEMA, timeoutMs: 30_000, maxTokens: 1_000 })).json;
}
