import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HELPER_MODEL, NEW_BOT_ENGINE, type BotEngine } from "@synapse/shared";
import { BotService } from "../../../bots/bot-service";
import { SseHub } from "../../../gateway/sse-hub";
import { HostSettingsStore } from "../../../store/host-settings";
import { initLayout } from "../../../store/layout";
import { tmpConfig } from "../../helpers";
import { BrainSwitch, brainKindOf, sessionKindOf } from "../../../brain/brain-switch";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { FakeBrain } from "../../../brain/fake-brain";
import { compactProviderSession } from "../../../brain/provider/compaction";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, BrainWiring, TurnEvent, TurnInput } from "../../../brain/types";
import { providerComplete } from "../../../helper-model/llm";
import { HelperRouter } from "../../../helper-model/router";
import { MessagesModelReviewer } from "../../../review/messages-reviewer";
import { searchClaude } from "../../../tools/builtin/web-search";
import { listCostUsd } from "../../../usage/list-price";
import { setProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { ProviderFrontSession, frontSessionFor } from "../../../voice/provider-front-session";
import { apiError, promptOf, startFakeMessagesServer, type MsgReply, type MsgRequest } from "./fake-messages-server";
import { startProviderRuntime } from "./runtime";

/**
 * Claude on Synapse's own loop (2026-09-30), end to end against a fake Messages API behind the real auth proxy:
 * the brain, prompt caching (measured), routing escalation, compaction, errors, the brain switch, and the helpers
 * (reviewer, one-shots, web search, voice front) that no longer need the Agent SDK.
 */
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => { setProviderRuntime(null); setUsageSink(null); for (const c of closers.splice(0)) await c.close(); });

function wiringWith(tools: BotToolDef[], log: string[] = []): BrainWiring {
  return {
    preToolUse: async (c) => { log.push(`pre:${c.toolName}`); return { decision: "allow" }; },
    canUseTool: async () => ({ behavior: "allow" }),
    postToolUse: async (c) => { log.push(`post:${c.toolName}`); return {}; },
    stop: async () => ({ block: false }), toolBatch: async () => ({ endTurn: false }), botTools: () => tools,
    turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }), flags: () => DEFAULT_FLAGS,
  };
}
const shell = (ran: string[]): BotToolDef => ({ name: "Shell", description: "Run a shell command on your computer.", readOnly: false, schema: { command: z.string() }, handler: async (a) => { ran.push(String(a.command)); return { text: `ran ${String(a.command)}` }; } });
const send = (sent: string[]): BotToolDef => ({ name: "SendMessage", description: "Send the user a message.", readOnly: false, schema: { content: z.string() }, handler: async (a) => { sent.push(String(a.content)); return { text: "Sent." }; } });
const input = (text: string, o: Partial<TurnInput> = {}): TurnInput => ({ prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: "claude-sonnet-5", autoReviewEpoch: "continue", ...o });

/** A long, stable system prompt, like the standalone prompt plus the Bot's own block. */
const SYSTEM = `You are Piper, a Bot in Synapse.\n${"Follow the house rules. ".repeat(1500)}`;

async function setup(script: (r: MsgRequest, n: number) => MsgReply, o: { deps?: Partial<ConstructorParameters<typeof ProviderBrain>[0]>; tools?: BotToolDef[] } = {}) {
  const up = await startFakeMessagesServer(script);
  closers.push(up);
  const rt = await startProviderRuntime({ anthropicUpstream: up.url, firstByteMs: 3000, idleMs: 3000 });
  closers.push({ close: rt.stop });
  const runs: MeteredRun[] = [];
  setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-"));
  closers.push({ close: async () => fs.rmSync(hp, { recursive: true, force: true }) });
  const store = new ProviderSessionStore(hp);
  let sid: string | null = null;
  const ran: string[] = [];
  const sent: string[] = [];
  const log: string[] = [];
  const brain = new ProviderBrain({
    botId: "bot_c", wiring: wiringWith(o.tools ?? [send(sent), shell(ran)], log), store, getSessionId: () => sid, systemPrompt: () => SYSTEM, sleep: async () => {},
    effort: () => "high", cacheTtl: () => "1h", ...(o.deps ?? {}),
  });
  const events: TurnEvent[] = [];
  const run = (text: string, extra: Partial<TurnInput> = {}) => brain.runTurn(input(text, extra), (e) => { events.push(e); if (e.kind === "session") sid = e.sessionId; });
  return { up, rt, brain, run, events, ran, sent, log, runs, store, sid: () => sid };
}

/** A scripted "model": each turn (by its prompt) is a list of replies, answered in order. */
const byTurn = (plan: Record<string, MsgReply[]>) => (r: MsgRequest): MsgReply => {
  const { prompt, after } = promptOf(r.body);
  const key = Object.keys(plan).find((k) => prompt.includes(k));
  return (key ? plan[key]![after] : undefined) ?? { blocks: [{ text: "done" }] };
};

describe("ProviderBrain on Claude (the Messages adapter)", () => {
  it("runs a turn: thinking kept and echoed unchanged, tools gated and run, SendMessage streams, usage metered at Claude's price", async () => {
    const s = await setup(byTurn({ "list": [
      { blocks: [{ thinking: "Look first.", signature: "sig-A" }, { tool: "Shell", input: { command: "ls" } }] },
      { blocks: [{ tool: "SendMessage", input: { content: "Two files." } }] },
      { blocks: [{ text: "done" }] },
    ] }));
    const r = await s.run("list my files");
    expect(r).toMatchObject({ aborted: false, toolCallCount: 2, model: "claude-sonnet-5" });
    expect(r.error).toBeUndefined();
    expect(s.ran).toEqual(["ls"]);
    expect(s.sent).toEqual(["Two files."]);
    expect(s.log).toEqual(["pre:mcp__bot__Shell", "post:mcp__bot__Shell", "pre:mcp__bot__SendMessage", "post:mcp__bot__SendMessage"]);
    expect(s.sid()).toMatch(/^prov-/);
    // The thinking block goes back first in its turn, byte for byte, on every later call.
    for (const q of s.up.requests.slice(1)) expect((q.body.messages as { content: unknown[] }[])[1]!.content[0]).toEqual({ type: "thinking", thinking: "Look first.", signature: "sig-A" });
    expect(s.events.some((e) => e.kind === "send_message_delta")).toBe(true);
    expect(s.up.requests.every((q) => q.body.model === "claude-sonnet-5" && (q.body.output_config as { effort: string }).effort === "high")).toBe(true);
    const u = r.usage as typeof r.usage & { costUsd: number };
    // Cost is linear in the tokens; every cache write here is a 1-hour one (2x input).
    expect(u.costUsd).toBeGreaterThan(0);
    expect(u.costUsd).toBeCloseTo(listCostUsd("claude-sonnet-5", { ...u, cacheWrite1hTokens: u.cacheWriteTokens }), 8);
    // The key never reached the Bot's side: every request left with a one-call proxy token and arrived with the key.
    expect(s.rt.unreported).toEqual([]);
  });

  it("the thinking blocks survive the session file: a fresh brain after cool() sends them back unchanged", async () => {
    const s = await setup(byTurn({ "one": [{ blocks: [{ thinking: "Plan it.", signature: "sig-B" }, { text: "first" }] }], "two": [{ blocks: [{ text: "second" }] }] }));
    await s.run("one");
    await s.brain.cool("test");
    await s.run("two");
    const last = s.up.requests.at(-1)!.body.messages as { role: string; content: unknown[] }[];
    expect(last[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "Plan it.", signature: "sig-B" }, { type: "text", text: "first" }] });
  });

  it("prompt caching: after the first call nearly every prompt token is a cache read, across tool calls and turns (measured)", async () => {
    const plan: Record<string, MsgReply[]> = {};
    const turns = ["check the disk", "now the logs", "and the network", "summarize it all"];
    for (const t of turns) plan[t] = [{ blocks: [{ tool: "Shell", input: { command: `probe ${t}` } }] }, { blocks: [{ tool: "SendMessage", input: { content: `Result for ${t}.` } }] }, { blocks: [{ text: "done" }] }];
    const s = await setup(byTurn(plan));
    for (const t of turns) await s.run(t);
    const u = s.up.usages;
    expect(u).toHaveLength(12);
    // Each call after the first reads at least everything the previous call sent (its whole prompt was written).
    for (let i = 1; i < u.length; i++) expect(u[i]!.read, `call ${i}`).toBeGreaterThanOrEqual(u[i - 1]!.total * 0.95);
    const total = u.reduce((a, x) => a + x.total, 0);
    const read = u.reduce((a, x) => a + x.read, 0);
    const written = u.reduce((a, x) => a + x.write, 0);
    const uncached = u.reduce((a, x) => a + x.input, 0);
    const hit = read / total;
    expect(hit).toBeGreaterThan(0.85);
    // In dollars: what the prompt side cost with caching vs sending it all uncached.
    const cost = listCostUsd("claude-sonnet-5", { inputTokens: uncached, outputTokens: 0, cacheReadTokens: read, cacheWriteTokens: written, cacheWrite1hTokens: written });
    const none = listCostUsd("claude-sonnet-5", { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBeLessThan(none * 0.35);
    console.log(`[cache-measure] calls=${u.length} promptTokens=${total} read=${read} (${(hit * 100).toFixed(1)}%) written=${written} uncached=${uncached} promptCost=$${cost.toFixed(4)} vs uncached $${none.toFixed(4)}`);
  });

  it("a routed turn on Haiku escalates to the Bot's own model the moment it reaches for a work tool", async () => {
    const s = await setup(byTurn({ "hey": [{ blocks: [{ tool: "Shell", input: { command: "date" } }] }, { blocks: [{ text: "done" }] }] }));
    const r = await s.run("hey", { routedModel: HELPER_MODEL });
    expect(s.up.requests.map((q) => q.body.model)).toEqual([HELPER_MODEL, "claude-sonnet-5"]);
    expect(r.escalated).toBe(true);
    // Haiku is sent no thinking and no effort; Sonnet gets both.
    expect(s.up.requests[0]!.body).not.toHaveProperty("thinking");
    expect(s.up.requests[1]!.body.thinking).toEqual({ type: "adaptive" });
  });

  it("an overloaded API (529) is retried in the loop with the partial reply reset; a refusal runs no tool and fails the turn plainly", async () => {
    let n = 0;
    const s = await setup(() => (n++ === 0 ? apiError(529, "overloaded_error", "Overloaded") : { blocks: [{ text: "fine" }] }));
    const r = await s.run("hello");
    expect(r.error).toBeUndefined();
    expect(s.events.find((e) => e.kind === "retry")).toMatchObject({ attempt: 1, errorStatus: 529, resetStream: true });
    const refused = await setup(() => ({ blocks: [{ text: "I can" }, { tool: "Shell", input: { command: "rm -rf /" } }], stop: "refusal" }));
    const rr = await refused.run("do it");
    expect(refused.ran).toEqual([]);
    expect(rr.error).toMatchObject({ code: "BOT-E0407", retryable: false });
  });

  it("pause_turn: the reply so far goes back and the model carries on", async () => {
    let n = 0;
    const s = await setup(() => (n++ === 0 ? { blocks: [{ server: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } } }], stop: "pause_turn" } : { blocks: [{ text: "found it" }] }));
    const r = await s.run("look it up");
    expect(r.finalText).toBe("found it");
    const second = s.up.requests[1]!.body.messages as { role: string; content: { type: string }[] }[];
    expect(second.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "server_tool_use" }] });
  });

  it("compaction on the new path: mid-turn at the line, on the Bot's own model, with a compact boundary; and the idle Compactor path", async () => {
    let summaries = 0;
    const s = await setup((r) => {
      if (!r.body.tools) { summaries++; return { blocks: [{ text: "SUMMARY: the user asked about disks." }] }; }
      return byTurn({ "first": [{ blocks: [{ text: "ok" }] }], "second": [{ blocks: [{ text: "ok again" }] }] })(r);
    }, { deps: { compactInstructions: () => "Summarize.", window: () => 10_000 } });
    await s.run("first question");
    const r = await s.run("second question");
    expect(r.error).toBeUndefined();
    expect(summaries).toBe(1);
    expect(s.events.filter((e) => e.kind === "compact_boundary")).toHaveLength(1);
    const summarizer = s.up.requests.find((q) => !q.body.tools)!;
    expect(summarizer.body.model).toBe("claude-sonnet-5");
    // The next call starts from the summary, with the unanswered prompt after it.
    const after = s.up.requests.at(-1)!.body.messages as { content: { text?: string }[] }[];
    expect(after[0]!.content[0]!.text).toContain("SUMMARY: the user asked about disks.");
    expect(JSON.stringify(after)).toContain("second question");
    // The idle Compactor's path (app.ts compactFn) on a Claude session.
    const ok = await compactProviderSession({ store: s.store, botId: "bot_c", sessionId: s.sid()!, ref: "claude-sonnet-5", instructions: "Summarize.", signal: new AbortController().signal });
    expect(ok).toBe(true);
    expect(summaries).toBe(2);
  });
});

describe("the brain switch: Engine Synapse / Claude Code", () => {
  const wiring = wiringWith([]);
  function sw(start: { model: string; engine?: BotEngine }, sid: string | null = null) {
    const st = { ...start, sid };
    const claude = new FakeBrain("b", wiring, () => [{ text: "claude-code" }]);
    const own = new FakeBrain("b", wiring, () => [{ text: "synapse" }]);
    const seen: string[] = [];
    const b = new BrainSwitch({
      botId: "b", model: () => st.model, engine: () => st.engine ?? "claude-code",
      claude: () => claude, provider: () => own, getSessionId: () => st.sid, clearSessionId: () => { st.sid = null; }, restoreBlock: () => "RESTORE",
    });
    const run = async (model = st.model) => { let p = ""; const r = await b.runTurn({ ...input("hi"), model }, () => {}); void r; p = r.finalText; seen.push(p); return p; };
    return { b, st, run, seen, claude, own };
  }
  it("kinds: a Claude model runs on Claude Code unless its engine is Synapse; other models are unaffected", () => {
    expect(brainKindOf("claude-sonnet-5")).toBe("claude");
    expect(brainKindOf("claude-sonnet-5", "claude-code")).toBe("claude");
    expect(brainKindOf("claude-sonnet-5", "synapse")).toBe("provider");
    expect(brainKindOf("claude-opus-5-5[1m]", "synapse")).toBe("provider");
    expect(brainKindOf("openai:gpt-6", "claude-code")).toBe("provider");
    expect(brainKindOf("acp:cursor", "synapse")).toBe("acp");
    expect(sessionKindOf("prov-123")).toBe("provider");
  });
  it("an existing Bot (no engine) keeps Claude Code; switching to Synapse starts a new conversation with the restore block, and back", async () => {
    const s = sw({ model: "claude-sonnet-5" }, "8c0b-uuid");
    expect(await s.run()).toBe("claude-code");
    expect(s.st.sid).toBe("8c0b-uuid");
    s.st.engine = "synapse";
    expect(await s.run()).toBe("synapse");
    expect(s.st.sid).toBeNull();
    expect(s.b.active).toBe("provider");
    s.st.engine = "claude-code";
    expect(await s.run()).toBe("claude-code");
    expect(s.b.active).toBe("claude");
  });
});

describe("the Engine setting on a Bot", () => {
  it("a new Bot records the default engine (so a later default never moves it); the owner can switch it; a bad value is refused; a copy keeps it", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const bots = new BotService({ cfg, hub: new SseHub(), settings });
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    expect(bots.summary(id).profile.engine).toBe(NEW_BOT_ENGINE);
    expect(bots.update(id, { engine: "synapse" }).profile.engine).toBe("synapse");
    expect(() => bots.update(id, { engine: "turbo" as never })).toThrow(/Unknown engine/);
    const copy = bots.duplicate(id);
    expect(bots.summary(copy).profile.engine).toBe("synapse");
  });
});

describe("the helpers on Claude without the Agent SDK", () => {
  async function upstream(script: (r: MsgRequest) => MsgReply) {
    const up = await startFakeMessagesServer((r) => script(r));
    closers.push(up);
    const rt = await startProviderRuntime({ anthropicUpstream: up.url });
    closers.push({ close: rt.stop });
    const runs: MeteredRun[] = [];
    setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
    return { up, runs };
  }
  const VERDICT = { matched_ask_rule_ids: [], floor_category: null, matched_allow_rule_ids: [], injection_suspected: false, risk_tier: 1, decision: "allow", confidence: 0.9, reason: "Routine.", proposed_allow_rule: null };

  it("the safety reviewer: Haiku, the reviewer prompt, a forced StructuredOutput call capped at 256 tokens, checked by checkVerdict", async () => {
    const h = await upstream(() => ({ blocks: [{ tool: "StructuredOutput", input: { verdict: VERDICT } }], stop: "tool_use" }));
    const v = await new MessagesModelReviewer().review({ risk_target: { command: "ls" } }, new AbortController().signal, "bot_1");
    expect(v.decision).toBe("allow");
    const b = h.up.requests[0]!.body;
    expect(b).toMatchObject({ model: HELPER_MODEL, max_tokens: 256, tool_choice: { type: "tool", name: "StructuredOutput" } });
    expect(b).not.toHaveProperty("thinking");
    expect(JSON.stringify(b.system)).toContain("StructuredOutput");
    expect(h.runs).toMatchObject([{ purpose: "review", botId: "bot_1", model: HELPER_MODEL }]);
  });

  it("the reviewer fails closed: a malformed verdict, no tool call, or a reply cut at the cap is an error, never a verdict", async () => {
    await upstream(() => ({ blocks: [{ tool: "StructuredOutput", input: { verdict: { ...VERDICT, decision: "maybe" } } }] }));
    await expect(new MessagesModelReviewer().review({}, new AbortController().signal)).rejects.toThrow(/malformed/);
    for (const c of closers.splice(0)) await c.close();
    await upstream(() => ({ blocks: [{ text: "I think it's fine" }] }));
    await expect(new MessagesModelReviewer().review({}, new AbortController().signal)).rejects.toThrow(/no structured output/);
    for (const c of closers.splice(0)) await c.close();
    await upstream(() => ({ blocks: [{ tool: "StructuredOutput", input: { verdict: VERDICT } }], stop: "max_tokens" }));
    await expect(new MessagesModelReviewer().review({}, new AbortController().signal)).rejects.toThrow(/output cap/);
  });

  it("one-shots: the account helper routes Claude calls to Haiku on the adapter (the reviewer stays Claude's own), structured output via the forced tool", async () => {
    const router = new HelperRouter({ botModel: () => "claude-sonnet-5", anthropicReady: () => true, consented: () => true, hasKey: () => false, claudeRef: () => HELPER_MODEL });
    expect(router.forBot("bot_1")).toEqual({ kind: "provider", ref: HELPER_MODEL });
    expect(router.account()).toEqual({ kind: "provider", ref: HELPER_MODEL });
    expect(router.reviewer()).toEqual({ kind: "claude" });
    const sdk = new HelperRouter({ botModel: () => "claude-sonnet-5", anthropicReady: () => true, consented: () => true, hasKey: () => false });
    expect(sdk.account()).toEqual({ kind: "claude" });
    const h = await upstream(() => ({ blocks: [{ tool: "StructuredOutput", input: { schedule: "0 9 * * *" } }] }));
    const r = await providerComplete({ purpose: "schedule-parser", botId: null, ref: HELPER_MODEL, system: "Parse.", user: "every day at 9", schema: { type: "object", properties: { schedule: { type: "string" } }, required: ["schedule"] } });
    expect(r.json).toEqual({ schedule: "0 9 * * *" });
    expect(h.runs[0]).toMatchObject({ purpose: "schedule-parser", model: HELPER_MODEL });
  });

  it("web search on Claude: its server web_search tool, sources from the results, $10 per 1,000 searches metered", async () => {
    const h = await upstream(() => ({
      blocks: [
        { server: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "synapse" } } },
        { server: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.org/a", title: "A" }] } },
        { text: "Synapse shipped 0.1.6." },
      ], webSearches: 1,
    }));
    const r = await searchClaude({ query: "synapse", botId: "bot_1" });
    expect(r).toEqual({ text: "Synapse shipped 0.1.6.", sources: [{ title: "A", url: "https://example.org/a" }] });
    expect((h.up.requests[0]!.body.tools as { type: string }[])[0]!.type).toBe("web_search_20250305");
    const run = h.runs[0]!;
    expect(run.purpose).toBe("web-search");
    expect(run.usage.costUsd).toBeGreaterThanOrEqual(0.01);
  });

  it("the voice front: a Claude Bot on Synapse speaks through the adapter at low effort with no thinking, one delegate tool", async () => {
    const h = await upstream(() => ({ blocks: [{ text: "On it." }, { tool: "delegate", input: { task: "email Sam the notes" } }] }));
    const f = frontSessionFor({ botId: "bot_1", model: "claude-sonnet-5", system: "You are Piper's voice." }, () => { throw new Error("the SDK front must not be used"); }, { ownLoop: () => true });
    expect(f).toBeInstanceOf(ProviderFrontSession);
    const delegated: string[] = [];
    const t = await f.turn("email Sam the notes", () => {}, (x) => delegated.push(x));
    expect(t).toMatchObject({ text: "On it.", delegations: ["email Sam the notes"] });
    expect(h.up.requests[0]!.body).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "low" } });
    // Without the own loop, a Claude Bot's voice is Claude Code's, as before.
    expect(() => frontSessionFor({ botId: "b", model: "claude-sonnet-5", system: "s" }, () => { throw new Error("sdk"); })).toThrow("sdk");
  });
});
