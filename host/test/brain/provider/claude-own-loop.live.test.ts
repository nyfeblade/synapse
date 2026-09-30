import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HELPER_MODEL } from "@synapse/shared";
import { AuthProxy } from "../../../auth/proxy";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { layoutOf } from "../../../brain/provider/adapters/anthropic-messages";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, BrainWiring, TurnEvent, TurnResult } from "../../../brain/types";
import { MessagesModelReviewer } from "../../../review/messages-reviewer";
import { searchClaude } from "../../../tools/builtin/web-search";
import { setProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink } from "../../../usage/metered-query";

/**
 * The LIVE smoke test for Claude on Synapse's own loop (ruling 91): real requests to Anthropic's Messages API through
 * the real auth proxy, with the key from the environment. It is what must pass before "Synapse" can be the default
 * engine. One command:
 *
 *   ANTHROPIC_API_KEY=sk-ant-… npm run smoke:claude-live      (CLAUDE_LIVE_MODEL=claude-opus-5-5 to try another model)
 *
 * It prints PASS/FAIL per feature: a tool call, the streamed SendMessage reply, thinking kept and echoed, prompt caching
 * on the next turn, web search, and the safety reviewer's forced StructuredOutput call. It costs a few cents.
 */
const LIVE = process.env.RUN_CLAUDE_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_LIVE_MODEL || "claude-sonnet-5";
const results: [string, boolean, string][] = [];
const check = (feature: string, ok: boolean, detail = "") => { results.push([feature, ok, detail]); };

describe.runIf(LIVE)(`Claude own loop, LIVE against the Messages API (${MODEL})`, () => {
  let proxy: AuthProxy;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-live-"));
  beforeAll(async () => {
    const key = process.env.ANTHROPIC_API_KEY!;
    proxy = new AuthProxy({ upstream: "https://api.anthropic.com", port: 0, credential: () => key, unref: true });
    await proxy.start();
    setProviderRuntime({
      proxy: null, allow: () => ({ ok: true, message: null }), consented: () => true, hasKey: () => false,
      anthropic: { get url() { return proxy.url; }, issue: (g) => proxy.issue(g), revoke: (t, r) => proxy.revoke(t, r), hasKey: () => true },
    });
    setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
  });
  afterAll(async () => {
    setProviderRuntime(null);
    setUsageSink(null);
    await proxy?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    const w = (l: string) => process.stdout.write(`${l}\n`);
    w(`\nClaude own loop, live smoke test (${MODEL}):`);
    for (const [f, ok, d] of results) w(`  ${ok ? "PASS" : "FAIL"}  ${f}${d ? `: ${d}` : ""}`);
  });

  it("a turn with a tool call and a streamed reply, thinking kept, then caching on the next turn", async () => {
    const ran: string[] = [];
    const sent: string[] = [];
    const tools: BotToolDef[] = [
      { name: "SendMessage", description: "Send the user a message. The only way the user sees your reply.", readOnly: false, schema: { content: z.string() }, handler: async (a) => { sent.push(String(a.content)); return { text: "Sent." }; } },
      { name: "Shell", description: "Run a shell command on your computer and return its output.", readOnly: false, schema: { command: z.string() }, handler: async (a) => { ran.push(String(a.command)); return { text: "hello-from-shell" }; } },
    ];
    const wiring: BrainWiring = {
      preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
      toolBatch: async () => ({ endTurn: false }), botTools: () => tools, flags: () => DEFAULT_FLAGS,
      turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    };
    const store = new ProviderSessionStore(tmp);
    let sid: string | null = null;
    // A prefix past every model's minimum cacheable length.
    const system = `You are Piper, a Bot in Synapse. Reply to the user only with the SendMessage tool.\n\n${"House rule: be brief and exact. ".repeat(900)}`;
    const brain = new ProviderBrain({ botId: "live", wiring, store, getSessionId: () => sid, systemPrompt: () => system, effort: () => "medium", cacheTtl: () => "5m" });
    const events: TurnEvent[] = [];
    const turn = (text: string): Promise<TurnResult> => brain.runTurn({ prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: MODEL, autoReviewEpoch: "continue" }, (e) => { events.push(e); if (e.kind === "session") sid = e.sessionId; });

    const r1 = await turn("Run `echo hello` with the Shell tool, then tell me what it printed.");
    check("tool call", !r1.error && ran.length > 0, r1.error ? `${r1.error.code} ${r1.error.message}` : `ran ${JSON.stringify(ran)}`);
    const deltas = events.filter((e) => e.kind === "send_message_delta").length;
    check("streamed reply (SendMessage)", sent.some((t) => t.includes("hello-from-shell")) && deltas > 0, `${deltas} deltas; sent ${JSON.stringify(sent).slice(0, 120)}`);
    const history = sid ? store.load("live", sid) : [];
    const thinking = history.flatMap((m) => (m.role === "assistant" ? layoutOf(m.providerMeta) ?? [] : [])).filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
    // The call after the tool call carried the thinking back; it succeeding is the echo's proof.
    check("thinking kept and echoed", !r1.error && thinking > 0, `${thinking} thinking block(s) kept`);

    const r2 = await turn("Thanks. Now say goodbye.");
    check("prompt caching (next turn reads the cache)", !r2.error && r2.usage.cacheReadTokens > 0, `read ${r2.usage.cacheReadTokens}, written ${r2.usage.cacheWriteTokens}, uncached ${r2.usage.inputTokens}`);
    expect(results.every(([, ok]) => ok)).toBe(true);
  }, 240_000);

  it("web search with Claude's server tool", async () => {
    let ok = false;
    let d = "";
    try {
      const r = await searchClaude({ query: "What is the capital of Australia?", botId: "live" });
      ok = r.text.length > 0 && r.sources.length > 0;
      d = `${r.sources.length} source(s)`;
    } catch (e) { d = String((e as Error).message ?? e).slice(0, 200); }
    check("web search", ok, d);
    expect(ok).toBe(true);
  }, 120_000);

  it("the safety reviewer's forced StructuredOutput call", async () => {
    let ok = false;
    let d = "";
    try {
      const v = await new MessagesModelReviewer().review({ tool: "mcp__bot__Shell", risk_target: { command: "ls /workspace" }, user_request: "list my files" }, AbortSignal.timeout(60_000), "live");
      ok = v.decision === "allow" || v.decision === "block";
      d = `${HELPER_MODEL}: ${v.decision} (tier ${v.risk_tier})`;
    } catch (e) { d = String((e as Error).message ?? e).slice(0, 200); }
    check("reviewer forced tool call", ok, d);
    expect(ok).toBe(true);
  }, 120_000);
});
