import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookCallback, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { meteredQuery } from "../../usage/metered-query";
import type { UserMessageEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { applyCacheEnv } from "../../brain/cache-env";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toNamedMcpServer, toSdkUserMessage } from "../../brain/sdk-wiring";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { SEND_TOOL } from "../../brain/tool-policy";
import type { BotToolDef } from "../../brain/types";
import { loadConfig, type HostConfig } from "../../config";
import { clockReminder, collectUserTurn, nudgeText } from "../../runner/prompt-collector";
import {
  JUDGE_MODEL, MAIN_MODEL, assertRealAllowed, parseJudge, runEval, verdict, writeReport,
  type ArmAnswer, type BotDriver, type EvalResult, type Judge, type JudgeInput, type TokenUse,
} from "./real";
import { loadCases, type RoutingCase } from "./run";
import { explicitKeyEnv } from "../../auth/dev-auth";

/**
 * The REAL routing eval's model-facing half, on the Mac with an explicit Anthropic API key (explicitKeyEnv: SYNAPSE_API_KEY or ANTHROPIC_API_KEY, never a Claude login; the
 * same way host/test/perf/context-budget.probe spawns the real CLI). No box, no gateway.
 *
 * Faithful context: a real host app (temp data dir) creates one everyday Bot; a small realistic memory is written
 * to its user memory BEFORE its prompt renders; each turn then spawns the real CLI with that Bot's production
 * spawn config (buildBotQueryOptions: standalone prompt + rendered Bot prompt, the everyday built-ins and up-front
 * bot tools, lazy tools, the 1-hour cache) and the user turn as TurnRunner builds it (the "[id] text" line, the
 * clock, the reply reminder). Only the side effects are replaced: SendMessage records the reply instead of
 * delivering it (same "Message sent." result, same end_turn rule: PostToolBatch stops the turn), and every other
 * tool is denied (a simple prompt that reaches for one fails the "no tool call" check). The routed arm keeps both
 * escalations: the first tool other than SendMessage switches the rest of the turn to the Bot's model
 * (Query.setModel from PreToolUse, as ClaudeBrain does), and a failed routed turn reruns on it (real.ts).
 * A turn that ends without sending gets the real reply nudge once, as the Stop hook would.
 */

export const EVAL_MEMORY = [
  "The user's name is Sam.",
  "The user's dog is called Biscuit.",
  "The user lives in Lisbon and works as a product designer.",
  "The user prefers short, direct answers.",
  "The user is learning Japanese.",
];

const TURN_TIMEOUT_MS = 180_000;
const here = path.dirname(fileURLToPath(import.meta.url));

type Json = Record<string, any>;

function usageFromResult(m: Json): { usage: TokenUse; models: string[] } {
  const usage: TokenUse = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const models: string[] = [];
  for (const [model, mu] of Object.entries((m.modelUsage ?? {}) as Record<string, Json>)) {
    models.push(model);
    usage.fresh += mu.inputTokens ?? 0;
    usage.cacheRead += mu.cacheReadInputTokens ?? 0;
    usage.cacheWrite += mu.cacheCreationInputTokens ?? 0;
    usage.output += mu.outputTokens ?? 0;
  }
  if (!models.length && m.usage) {
    usage.fresh = m.usage.input_tokens ?? 0; usage.cacheRead = m.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite = m.usage.cache_creation_input_tokens ?? 0; usage.output = m.usage.output_tokens ?? 0;
  }
  return { usage, models };
}

/** Streams one message in and keeps the input open until `done` (setModel is a control request: it needs streaming input). */
async function* oneMessage(msg: SDKUserMessage, done: Promise<void>): AsyncGenerator<SDKUserMessage> {
  yield msg;
  await done;
}

export interface BotContext { app: HostApp; cfg: HostConfig; botId: string; timeZone: string; systemAppendChars: number; close(): Promise<void> }

export async function openBotContext(memory: string[]): Promise<BotContext> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "routing-eval-"));
  fs.mkdirSync(path.join(d, "workspace"), { recursive: true });
  const cfg = loadConfig({
    DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host"), WORKSPACE: path.join(d, "workspace"),
    CLAUDE_CONFIG_DIR: path.join(d, ".claude"), SYNAPSE_CC_MANAGED: path.join(d, "cc-managed"), HOST_PORT: "0", WEBHOOK_PORT: "0",
    WEBHOOK_BIND: "127.0.0.1", BRAIN: "fake", REVIEWER: "stub", DISK_FREE_PCT: "50",
  });
  const app = await createHostApp(cfg);
  const { id } = await app.handlers.createAgent!({ name: "Juno", isKickstartRequested: false });
  for (const content of memory) app.services.memory.add({ kind: "user", botId: id }, { content, tier: "profile", kind: "fact" });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const systemAppendChars = app.services.runner.systemAppend(id).length;
  return {
    app, cfg, botId: id, timeZone, systemAppendChars,
    async close() { await app.close(); fs.rmSync(d, { recursive: true, force: true }); },
  };
}

/** One Bot turn's spawn options: the Bot's production spawn config on `model`, with the eval's bot tools and hooks. */
export function turnOptions(ctx: BotContext, model: string, tools: BotToolDef[], hooks: Options["hooks"], abort: AbortController, cwd: string): Options {
  const sc = ctx.app.services.spawnConfig(ctx.botId);
  const env = { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...(sc.env.ENABLE_TOOL_SEARCH ? { ENABLE_TOOL_SEARCH: sc.env.ENABLE_TOOL_SEARCH } : {}) };
  applyCacheEnv(env);
  const o: Options = buildBotQueryOptions({
    cfg: ctx.cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
    systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode, model, effort: sc.effort, env,
    mcpServers: { ...(sc.mcpServers ?? {}), bot: toNamedMcpServer("bot", tools, sc.upFrontBotTools ? { upFront: sc.upFrontBotTools } : {}) },
    botToolNames: tools.map((t) => t.name), extraDisallowed: sc.extraDisallowed, plugins: sc.plugins, skillOverrides: sc.skillOverrides,
    builtinTools: sc.builtinTools,
    hooks: hooks ?? {},
    canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: abort,
  });
  o.cwd = cwd;
  o.additionalDirectories = [];
  o.persistSession = false;
  o.includePartialMessages = false;
  return o;
}

export function sdkBotDriver(ctx: BotContext, log: (s: string) => void = () => {}): BotDriver {
  const wiring = ctx.app.services.runner.wiring(ctx.botId);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "routing-eval-cwd-"));
  return {
    async answer(c: RoutingCase, model: string): Promise<ArmAnswer> {
      const sent: string[] = [];
      const toolCalls: string[] = [];
      let endTurn = false, escalated = false, nudged = false, lastText = "";
      let q: Query | null = null;
      const tools: BotToolDef[] = wiring.botTools().map((t) => t.name === "SendMessage"
        ? { ...t, handler: async (a) => {
          const content = String(a.content ?? "").trim();
          if (!content) return { text: "content is required for a text message.", isError: true };
          sent.push(content);
          if (a.end_turn === true) endTurn = true;
          return { text: "Message sent." };
        } }
        : { ...t, handler: async () => ({ text: "This tool is unavailable right now.", isError: true }) });
      const pre: HookCallback = async (raw) => {
        const i = raw as Json;
        if (i.tool_name === SEND_TOOL) return {};
        toolCalls.push(String(i.tool_name));
        if (model !== MAIN_MODEL && !escalated && q) {
          escalated = true;
          try { await q.setModel(MAIN_MODEL); } catch (e) { log(`${c.id} setModel failed: ${String(e)}`); }
        }
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This tool is unavailable right now. Answer from what you know." } };
      };
      const batch: HookCallback = async () => (endTurn ? { continue: false, stopReason: "reply delivered" } : {});
      const stop: HookCallback = async (raw) => {
        if (sent.length || nudged || (raw as Json).stop_hook_active) return {};
        nudged = true;
        return { decision: "block", reason: nudgeText("reply", lastText) };
      };
      const abort = new AbortController();
      const o = turnOptions(ctx, model, tools, { PreToolUse: [{ hooks: [pre] }], PostToolBatch: [{ hooks: [batch] }], Stop: [{ hooks: [stop] }] }, abort, cwd);

      const entry = { id: "t1u", content: c.text } as UserMessageEntry;
      const prompt = collectUserTurn({ messages: [{ entry, before: [], after: [] }], profileUpdate: null, blocks: [] });
      prompt.splice(prompt.length - 1, 0, { text: clockReminder(Date.now(), ctx.timeZone) });
      let finish!: () => void;
      const done = new Promise<void>((r) => { finish = r; });
      const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
      let result: Json | null = null, error: string | undefined;
      try {
        q = meteredQuery({ purpose: "eval-routing", botId: ctx.botId }, { prompt: oneMessage(toSdkUserMessage(prompt), done), options: o });
        for await (const m of q as AsyncIterable<SDKMessage>) {
          const mj = m as Json;
          if (mj.type === "assistant") {
            const texts = ((mj.message?.content ?? []) as Json[]).filter((x) => x.type === "text").map((x) => String(x.text));
            if (texts.length) lastText = texts.join("\n");
          }
          if (mj.type === "result") { result = mj; break; }
        }
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      } finally {
        clearTimeout(timer);
        finish();
        q?.close();
      }
      const { usage, models } = result ? usageFromResult(result) : { usage: { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, models: [] as string[] };
      if (!error && result?.is_error && result.subtype !== "success") error = `result ${String(result.subtype)}`;
      if (!result && !error) error = "no result";
      return { model, models: models.length ? models : [model], text: sent.join("\n\n"), sent: sent.length > 0, toolCalls, escalated, usage, ...(error ? { error } : {}) };
    },
  };
}

const RUBRIC = `You are a strict, impartial judge of chat replies. A personal-assistant Bot in a messaging app answered its user's message; you see two candidate replies, A and B, in random order. Judge only the reply text as the user would read it.

Score each reply 1-5 on:
- correctness: factually right, consistent with what the Bot knows about the user; nothing invented.
- completeness: answers what was asked, nothing important missing.
- instructions: does what the message asks, in a form that fits a quick chat message (brief when the message is brief; honours the user's known preferences).
- tone: natural, warm and direct; no filler, no over-explaining.

Then say which reply is better overall: "A", "B" or "tie". Use "tie" when the difference would not matter to the user. Length alone is not a reason to prefer a reply.

Answer with ONLY this JSON, nothing else:
{"a":{"correctness":n,"completeness":n,"instructions":n,"tone":n},"b":{"correctness":n,"completeness":n,"instructions":n,"tone":n},"verdict":"A"|"B"|"tie","reason":"<one short sentence>"}`;

export function judgePrompt(i: JudgeInput): string {
  return [
    "What the Bot knows about its user:",
    ...i.memory.map((m) => `- ${m}`),
    "",
    `The user's message:\n<<<${i.prompt}>>>`,
    "",
    `Reply A:\n<<<${i.a || "(no reply was sent)"}>>>`,
    "",
    `Reply B:\n<<<${i.b || "(no reply was sent)"}>>>`,
  ].join("\n");
}

export function sdkJudge(): Judge {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "routing-eval-judge-"));
  return {
    async judge(i: JudgeInput) {
      const env = { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
      let result: Json | null = null;
      const q = meteredQuery({ purpose: "eval-routing-judge", botId: null }, {
        prompt: judgePrompt(i),
        options: { model: JUDGE_MODEL, systemPrompt: RUBRIC, tools: [], mcpServers: {}, settingSources: [], persistSession: false, maxTurns: 1, cwd, env },
      });
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) if ((m as Json).type === "result") { result = m as Json; break; }
      } finally { q.close(); }
      if (!result) throw new Error("judge: no result");
      const { usage } = usageFromResult(result);
      const text = typeof result.result === "string" ? result.result : "";
      return { ...parseJudge(text), usage };
    },
  };
}

export interface RealEvalOptions {
  env?: Record<string, string | undefined>;
  outRoot?: string;
  log?: (s: string) => void;
  /** Test seam: called just before anything is built. */
  onBuild?: () => void;
}

/** The one real run: refuses without EVAL_REAL=1, then writes test-reports/routing-eval/<ts>/{report.md,results.json}. */
export async function runRealEval(o: RealEvalOptions = {}): Promise<{ result: EvalResult; md: string; json: string }> {
  assertRealAllowed(o.env ?? process.env);
  o.onBuild?.();
  const log = o.log ?? ((s: string) => process.stdout.write(`${s}\n`));
  const ctx = await openBotContext(EVAL_MEMORY);
  try {
    const result = await runEval({
      cases: loadCases(), driver: sdkBotDriver(ctx, log), judge: sdkJudge(), memory: EVAL_MEMORY, log,
      context: { botPromptChars: ctx.systemAppendChars, memory: EVAL_MEMORY, timeZone: ctx.timeZone, surface: "Agent SDK in-process, real CLI, explicit API key; everyday Bot production spawn config" },
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(o.outRoot ?? path.resolve(here, "..", "..", "..", "test-reports", "routing-eval"), ts);
    const { md, json } = writeReport(dir, result);
    const v = verdict(result);
    log(`verdict ${v.pass ? "PASS" : v.incomplete ? "INCOMPLETE" : "FAIL"}; tokens ${JSON.stringify(result.tokens.total)}; report ${md}`);
    return { result, md, json };
  } finally {
    await ctx.close();
  }
}
