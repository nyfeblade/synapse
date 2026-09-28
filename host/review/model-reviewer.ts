import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HELPER_MODEL, LIMITS } from "@synapse/shared";
import { loadPrompt } from "../prompts/index";
import { meteredQuery, type Meter } from "../usage/metered-query";
import { authGeneration } from "../auth/auth-env";
import { AsyncQueue } from "../util/async-queue";
import type { Verdict } from "./types";

/**
 * The verdict, analysis fields first: with no written walkthrough (speed plan #2) the model fills the ask-first
 * match, floor category, allow match, injection flag and tier before it writes the decision.
 */
export const VERDICT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["matched_ask_rule_ids", "floor_category", "matched_allow_rule_ids", "injection_suspected", "risk_tier", "decision", "confidence", "reason", "proposed_allow_rule"],
  properties: {
    matched_ask_rule_ids: { type: "array", items: { type: "string", pattern: "^K([1-9]|1[0-9]|20)$" } },
    floor_category: { type: ["string", "null"], enum: [null, "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"] },
    matched_allow_rule_ids: { type: "array", items: { type: "string", pattern: "^A([1-9]|1[0-9]|20)$" } },
    injection_suspected: { type: "boolean" },
    risk_tier: { type: "integer", minimum: 0, maximum: 4 },
    decision: { enum: ["allow", "block"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    // Speed plan #2 fix round 1: sized so a full block verdict fits the 256-token cap (reason ≤ 240, proposal ≤ 160).
    reason: { type: "string", maxLength: 240 },
    proposed_allow_rule: { type: ["string", "null"], maxLength: 160 },
  },
};

/**
 * Speed plan #2: the whole verdict rides in ONE tool parameter. The CLI's StructuredOutput tool spends ~20 output
 * tokens per top-level parameter (measured: 9 top-level fields ≈ 250 tokens, the same fields nested ≈ 170).
 */
export const OUTPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: VERDICT_SCHEMA } };

/** Said after the input, where it is read last: the prompt alone still let a written walkthrough through. */
const REPLY_NUDGE = "Reply with the StructuredOutput call only. No text.";

/**
 * The host's own check of the verdict's shape, whatever the CLI validated: a verdict that doesn't match
 * VERDICT_SCHEMA exactly (types, enums, id patterns, lengths, no extra keys) is an error, never a verdict.
 */
export function checkVerdict(v: unknown): Verdict {
  const bad = (why: string): never => { throw new Error(`reviewer verdict is malformed: ${why}`); };
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("not an object");
  const o = v as Record<string, unknown>;
  const keys = Object.keys(VERDICT_SCHEMA.properties);
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`unexpected field ${k}`);
  for (const k of VERDICT_SCHEMA.required) if (!(k in o)) bad(`missing ${k}`);
  if (o.decision !== "allow" && o.decision !== "block") bad("decision");
  if (!Number.isInteger(o.risk_tier) || (o.risk_tier as number) < 0 || (o.risk_tier as number) > 4) bad("risk_tier");
  if (!(VERDICT_SCHEMA.properties.floor_category.enum as unknown[]).includes(o.floor_category)) bad("floor_category");
  const ids = (x: unknown, re: RegExp) => Array.isArray(x) && x.every((i) => typeof i === "string" && re.test(i));
  if (!ids(o.matched_ask_rule_ids, /^K([1-9]|1[0-9]|20)$/)) bad("matched_ask_rule_ids");
  if (!ids(o.matched_allow_rule_ids, /^A([1-9]|1[0-9]|20)$/)) bad("matched_allow_rule_ids");
  if (typeof o.injection_suspected !== "boolean") bad("injection_suspected");
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) bad("confidence");
  if (typeof o.reason !== "string" || o.reason.length > VERDICT_SCHEMA.properties.reason.maxLength) bad("reason");
  if (o.proposed_allow_rule !== null && (typeof o.proposed_allow_rule !== "string" || o.proposed_allow_rule.length > VERDICT_SCHEMA.properties.proposed_allow_rule.maxLength)) bad("proposed_allow_rule");
  return o as unknown as Verdict;
}

/** `botId`: the Bot whose tool call is reviewed, for usage accounting (null for the startup probe). */
export interface ModelReviewer { review(input: Record<string, unknown>, signal: AbortSignal, botId?: string | null): Promise<Verdict> }

interface Warm { input: AsyncQueue<SDKUserMessage>; q: Query; startedAt: number; meter: Meter; authGen: number }

/** S6: one-shot, tool-less Haiku call with structured output; a prewarm pool hides CLI start-up (§01.9). */
export class SdkModelReviewer implements ModelReviewer {
  private pool: Warm[] = [];

  /** `prewarm`: pool size, read on every refill so it can change live (TTFT war room review: the conformance flag
   *  and SYNAPSE_PREWARM kill switch, and 0 while a voice call is live). Each pooled process answers ONE review. */
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; prewarm: number | (() => number) }) {
    this.refill();
  }

  private target(): number {
    return typeof this.o.prewarm === "function" ? this.o.prewarm() : this.o.prewarm;
  }

  /** Idle prewarmed processes right now (they count against the Supervisor's warm budget). */
  warmCount(): number {
    return this.pool.length;
  }

  private open(): Warm {
    const input = new AsyncQueue<SDKUserMessage>();
    const meter: Meter = { purpose: "review", botId: null }; // a warm pooled call learns its Bot when used
    const q = meteredQuery(meter, {
      prompt: input,
      options: {
        model: HELPER_MODEL, systemPrompt: loadPrompt("orig/reviewer.md"), settingSources: [], mcpServers: {}, tools: [],
        thinking: { type: "disabled" }, // the CLI enables extended thinking by default; it blew the 15 s budget (§01.9)
        maxTurns: 2, persistSession: false, cwd: this.o.cwd,
        // Speed plan #2: a hard output cap per verdict. At the cap the CLI would ask again ("Output token limit
        // hit. Resume directly…"); review() refuses that second request, so an overrun fails closed.
        env: { ...this.o.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(LIMITS.reviewerMaxOutputTokens) },
        pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable, outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
    });
    return { input, q, startedAt: Date.now(), meter, authGen: authGeneration() };
  }

  /** Re-applies the pool target now (the host calls it when a voice call starts or ends). */
  resize(): void {
    this.refill();
  }

  private refill(): void {
    const t = Date.now();
    // A process warmed before a sign-in change (auth/auth-env.ts) is recycled like an old one.
    const fresh = (x: Warm) => t - x.startedAt <= LIMITS.reviewerPoolRecycleMs && x.authGen === authGeneration();
    for (const w of this.pool.filter((x) => !fresh(x))) { w.input.end(); w.q.close(); }
    this.pool = this.pool.filter(fresh);
    const want = this.target();
    for (const w of this.pool.splice(want)) { w.input.end(); w.q.close(); } // the target dropped (a call went live)
    try {
      while (this.pool.length < want) this.pool.push(this.open());
    } catch { /* no usable sign-in right now (API-key mode, no key): review() reports it */ }
  }

  async review(input: Record<string, unknown>, signal: AbortSignal, botId: string | null = null): Promise<Verdict> {
    this.refillStale();
    const w = this.pool.shift() ?? this.open();
    w.meter.botId = botId;
    queueMicrotask(() => this.refill());
    const onAbort = () => w.q.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      w.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: JSON.stringify(input) }, { type: "text", text: REPLY_NUDGE }] } });
      w.input.end();
      // Speed plan #2: one verdict = one model request. A second one (the CLI's output-cap continuation, or its retry
      // after a schema miss) is an error, never a verdict: it fails closed and costs no more time.
      const requests = new Set<string>();
      for await (const m of w.q) {
        const r = m as { type: string; message?: { id?: string }; structured_output?: unknown; is_error?: boolean };
        if (r.type === "assistant" && r.message?.id) {
          requests.add(r.message.id);
          if (requests.size > 1) throw new Error("reviewer made more than one model request");
        }
        if (r.type === "result") {
          const out = r.structured_output as { verdict?: Verdict } | undefined;
          if (r.is_error || !out?.verdict) throw new Error("reviewer returned no structured output");
          return checkVerdict(out.verdict);
        }
      }
      throw new Error(signal.aborted ? "reviewer timed out" : "reviewer ended without a result");
    } finally {
      signal.removeEventListener("abort", onAbort);
      w.q.close();
    }
  }

  private refillStale(): void {
    const g = authGeneration();
    for (const w of this.pool.filter((x) => x.authGen !== g)) { w.input.end(); w.q.close(); }
    this.pool = this.pool.filter((x) => x.authGen === g);
  }

  dispose(): void {
    for (const w of this.pool.splice(0)) { w.input.end(); w.q.close(); }
  }
}

/** FUZZ / E2E stand-in: deterministic, never calls Claude. */
export class StubModelReviewer implements ModelReviewer {
  async review(input: Record<string, unknown>): Promise<Verdict> {
    const target = JSON.stringify(input.risk_target ?? {});
    const risky = /\brm\b|curl|wget|send_message|delete|publish/.test(target);
    return {
      decision: risky ? "block" : "allow", risk_tier: risky ? 3 : 1, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: [],
      injection_suspected: false, confidence: 0.9,
      reason: risky ? "Deletes or sends something that can't be undone, so it needs your OK." : "Routine step for the task.",
      proposed_allow_rule: risky ? "Use the Shell tool to delete scratch files in /workspace/tmp." : null,
    };
  }
}
