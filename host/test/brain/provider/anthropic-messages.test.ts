import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicDecoder, AnthropicMessagesAdapter, claudeCaps, encodeAnthropic, encodeAnthropicMessages, mapAnthropicUsage, STRUCTURED_TOOL, UsageTracker,
} from "../../../brain/provider/adapters/anthropic-messages";
import { adapterFor, modelTarget } from "../../../brain/provider/adapters/index";
import { ChatCompletionsAdapter } from "../../../brain/provider/adapters/chat-completions";
import type { CanonMessage, CanonRequest, DecodedMessage } from "../../../brain/provider/adapters/types";
import { SseParser } from "../../../brain/provider/sse";
import { providerFetch, ProviderCallError, setProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { listCostUsd } from "../../../usage/list-price";
import { apiError, startFakeMessagesServer, type MsgReply } from "./fake-messages-server";
import { ANTHROPIC_TEST_KEY, startProviderRuntime } from "./runtime";

/**
 * The Anthropic Messages adapter (2026-09-30, Claude on Synapse's own loop): golden requests and golden streams, the
 * SSE decoding under every chunk boundary, the error table, the metering, and the key staying in the auth proxy.
 */
const FIX = path.join(__dirname, "fixtures", "anthropic");
const golden = (name: string, actual: unknown) => {
  const file = path.join(FIX, name);
  if (process.env.UPDATE_GOLDEN === "1" || !fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  expect(actual).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
};

const THINK = { anthropic: { blocks: [{ type: "thinking", thinking: "Check the folder first.", signature: "c2lnLTE=" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1" }] } };
const HISTORY: CanonMessage[] = [
  { role: "user", parts: [{ type: "text", text: "what's in my folder? here's a photo" }, { type: "image", mediaType: "image/jpeg", dataBase64: "/9j/AAA" }] },
  { role: "assistant", text: "Checking.", toolCalls: [{ id: "toolu_1", name: "mcp__bot__Shell", arguments: "{\"command\":\"ls\"}" }], providerMeta: THINK },
  { role: "tool", toolCallId: "toolu_1", name: "mcp__bot__Shell", text: "a.txt\nshot.png", isError: false, images: [{ mimeType: "image/png", data: "iVBOR" }] },
  { role: "user", parts: [{ type: "text", text: "<system-reminder>\nKeep it short.\n</system-reminder>" }] },
  { role: "assistant", text: "", toolCalls: [{ id: "toolu_2", name: "mcp__bot__SendMessage", arguments: "{\"content\":\"Two files.\"}" }] },
  { role: "tool", toolCallId: "toolu_2", name: "mcp__bot__SendMessage", text: "Sent.", isError: false },
  { role: "user", parts: [{ type: "text", text: "and the second one?" }] },
];
const TOOLS = [
  { name: "SendMessage", description: "Send a message", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, strict: false },
  { name: "Shell", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, strict: false },
];
const req = (o: Partial<CanonRequest> = {}): CanonRequest => ({
  model: "claude-sonnet-5", system: "SYS", messages: HISTORY, tools: TOOLS, wireName: (n) => n.replace(/^mcp__bot__/, ""), claudeEffort: "high", cacheTtl: "1h", ...o,
});

function decodeSse(text: string, cuts: number[] = []): { msg: DecodedMessage; events: unknown[]; dec: AnthropicDecoder } {
  const bytes = new TextEncoder().encode(text);
  const p = new SseParser();
  const dec = new AnthropicDecoder();
  const events: unknown[] = [];
  let prev = 0;
  const feed = (evs: { data: string }[]) => { for (const e of evs) events.push(...dec.push(JSON.parse(e.data))); };
  for (const c of [...cuts, bytes.length]) { feed(p.push(bytes.subarray(prev, c))); prev = c; }
  feed(p.end());
  return { msg: dec.finish(), events, dec };
}

describe("Anthropic Messages: golden requests", () => {
  it("a full turn: system and tools cached (1h), images in user and tool turns, thinking echoed verbatim, tool results first, reminders merged, adaptive thinking + effort", () => {
    const body = encodeAnthropic(req());
    golden("encode-full.json", body);
    // Four breakpoints at most: the last tool, the system prompt, the last two user turns.
    const marks = JSON.stringify(body).match(/"cache_control"/g) ?? [];
    expect(marks.length).toBe(4);
    const msgs = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    // The thinking block goes back exactly as it came, first in its turn.
    expect(msgs[1]!.content[0]).toEqual({ type: "thinking", thinking: "Check the folder first.", signature: "c2lnLTE=" });
    // Tool results first, then the reminder, in one user turn; the tool's image inline in its result.
    expect(msgs[2]!.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect((msgs[2]!.content[0]!.content as unknown[])[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("the same history encodes to the same bytes every time (the cached prefix is byte-stable)", () => {
    const a = JSON.stringify(encodeAnthropic(req()));
    const b = JSON.stringify(encodeAnthropic(req({ messages: structuredClone(HISTORY) })));
    expect(a).toBe(b);
    // A turn later, everything before the new turn is unchanged byte for byte (only the moving breakpoints move).
    const later = encodeAnthropic(req({ messages: [...HISTORY, { role: "assistant", text: "It's a screenshot.", toolCalls: [] }, { role: "user", parts: [{ type: "text", text: "thanks" }] }] }));
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/,"cache_control":\{[^}]*\}/g, ""));
    const was = strip(encodeAnthropic(req())).messages as unknown[];
    expect((strip(later).messages as unknown[]).slice(0, was.length)).toEqual(was);
  });

  it("per model: Haiku gets no thinking and no effort; Opus 5.5 adaptive with its effort; the voice front's thinkingOff only where allowed", () => {
    const h = encodeAnthropic(req({ model: "claude-haiku-4-5-20251001" }));
    expect(h).not.toHaveProperty("thinking");
    expect(h).not.toHaveProperty("output_config");
    const o = encodeAnthropic(req({ model: "claude-opus-5-5", claudeEffort: "max" }));
    expect(o.thinking).toEqual({ type: "adaptive" });
    expect(o.output_config).toEqual({ effort: "max" });
    expect(encodeAnthropic(req({ model: "claude-sonnet-5", thinkingOff: true, claudeEffort: "max" }))).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "high" } });
    expect(encodeAnthropic(req({ model: "claude-opus-5-5", thinkingOff: true, claudeEffort: "low" }))).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(encodeAnthropic(req({ model: "claude-sonnet-5[1m]" })).model).toBe("claude-sonnet-5");
    expect(encodeAnthropic(req({ cacheTtl: "5m" })).system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  });

  it("structured output: a forced StructuredOutput tool (thinking off) where the model takes one, else asked for in the system prompt", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const onHaiku = encodeAnthropic(req({ model: "claude-haiku-4-5-20251001", tools: [], jsonSchema: { name: "v", schema, strict: false } }));
    expect(onHaiku.tool_choice).toEqual({ type: "tool", name: STRUCTURED_TOOL });
    expect(onHaiku.tools).toEqual([{ name: STRUCTURED_TOOL, description: "Give your answer as this tool's input.", input_schema: schema, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    const onSonnet = encodeAnthropic(req({ tools: [], jsonSchema: { name: "v", schema, strict: false } }));
    expect(onSonnet.thinking).toEqual({ type: "disabled" });
    const onOpus55 = encodeAnthropic(req({ model: "claude-opus-5-5", tools: [], jsonSchema: { name: "v", schema, strict: false } }));
    expect(onOpus55).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(onOpus55.system)).toContain(`calling the ${STRUCTURED_TOOL} tool`);
  });

  it("well-formed whatever the history: a call with no result gets one, a thinking-only turn is left out, foreign ids are made safe, it starts on a user turn", () => {
    const msgs = encodeAnthropicMessages([
      { role: "assistant", text: "", toolCalls: [], providerMeta: { anthropic: { blocks: [{ type: "thinking", thinking: "x", signature: "s" }] } } },
      { role: "assistant", text: "hi", toolCalls: [{ id: "call:abc/1", name: "Read", arguments: "{bad json" }] },
      { role: "user", parts: [{ type: "text", text: "go on" }] },
    ], (n) => n);
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "(continued)" }] });
    expect(msgs[1]!.content).toEqual([{ type: "text", text: "hi" }, { type: "tool_use", id: "call_abc_1", name: "Read", input: {} }]);
    expect(msgs[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_abc_1", is_error: true });
    expect(msgs[2]!.content[1]).toEqual({ type: "text", text: "go on" });
  });

  it("a history that ran on Claude goes to another provider without Claude's blocks (and the other way round)", () => {
    const cc = new ChatCompletionsAdapter("openai").encode({ ...req(), model: "gpt-x" }) as { messages: Record<string, unknown>[] };
    expect(JSON.stringify(cc.messages)).not.toContain("anthropic");
    expect(JSON.stringify(cc.messages)).not.toContain("c2lnLTE=");
    const gem: CanonMessage[] = [{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", text: "a", toolCalls: [], providerMeta: { extra_content: { google: { thought_signature: "g" } } } }, { role: "user", parts: [{ type: "text", text: "q2" }] }];
    expect(JSON.stringify(encodeAnthropic(req({ messages: gem })))).not.toContain("thought_signature");
  });

  it("the ref resolves: Claude ids (and [1m]) to Anthropic, provider refs to their provider", () => {
    expect(modelTarget("claude-sonnet-5[1m]")).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(modelTarget("openai:gpt-6")).toEqual({ provider: "openai", model: "gpt-6" });
    expect(modelTarget("nonsense")).toBeNull();
    expect(adapterFor("anthropic")).toBeInstanceOf(AnthropicMessagesAdapter);
    expect(claudeCaps("claude-fable-5-1")).toMatchObject({ forcedTool: false, canDisableThinking: false });
  });
});

describe("Anthropic Messages: golden streams", () => {
  it("thinking + text + two tool calls: the calls stream their arguments, the blocks are kept in order, usage is the whole call's", () => {
    const { msg, events } = decodeSse(fs.readFileSync(path.join(FIX, "stream-thinking-tools.sse"), "utf8"));
    golden("decoded-thinking-tools.json", msg);
    expect(msg.toolCalls.map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([["Shell", { command: "ls -la /workspace" }], ["SendMessage", { content: "On it." }]]);
    expect(msg.usage).toEqual({ inputTokens: 42, outputTokens: 187, cacheReadTokens: 9000, cacheWriteTokens: 1800, cacheWrite1hTokens: 1800, promptTokens: 10842 });
    expect(msg.finishReason).toBe("tool_calls");
    // The SendMessage call streams: its id and name first, then its argument pieces (the typing indicator reads them).
    const tool = events.filter((e) => (e as { kind: string }).kind === "tool_delta") as { index: number; id?: string; name?: string; delta: string }[];
    expect(tool.filter((e) => e.index === 1)).toEqual([{ kind: "tool_delta", index: 1, id: "toolu_01B", name: "SendMessage", delta: "" }, { kind: "tool_delta", index: 1, delta: "{\"content\":\"On it" }, { kind: "tool_delta", index: 1, delta: ".\"}" }]);
  });

  it("redacted thinking, a server web search with its result, and a cited answer come back verbatim when echoed", () => {
    const { msg, dec } = decodeSse(fs.readFileSync(path.join(FIX, "stream-search-redacted.sse"), "utf8"));
    golden("decoded-search-redacted.json", msg);
    expect(msg.usage).toMatchObject({ inputTokens: 2900, outputTokens: 55, webSearchRequests: 1 });
    expect(dec.serverBlocks().map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
    const echoed = encodeAnthropicMessages([{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", text: msg.text, toolCalls: [], providerMeta: msg.providerMeta }], (n) => n)[1]!;
    expect(echoed.content.map((b) => b.type)).toEqual(["redacted_thinking", "server_tool_use", "web_search_tool_result", "text"]);
    expect(echoed.content[1]).toEqual({ type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "synapse release" } });
    expect((echoed.content[3]!.citations as unknown[]).length).toBe(1);
  });

  it("the same message whatever the chunk boundaries: every single cut, then 300 random splits (UTF-8 split mid-character included)", () => {
    for (const f of ["stream-thinking-tools.sse", "stream-search-redacted.sse"]) {
      const text = fs.readFileSync(path.join(FIX, f), "utf8");
      const whole = decodeSse(text).msg;
      const n = new TextEncoder().encode(text).length;
      const strip = (m: DecodedMessage) => ({ ...m, toolCalls: m.toolCalls.map((c) => ({ ...c })) });
      for (let c = 1; c < n; c += 7) expect(strip(decodeSse(text, [c]).msg)).toEqual(strip(whole));
      let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
      for (let k = 0; k < 300; k++) {
        const cuts = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => 1 + Math.floor(rnd() * (n - 1))).sort((a, b) => a - b);
        expect(strip(decodeSse(text, [...new Set(cuts)]).msg)).toEqual(strip(whole));
      }
    }
  });

  it("usage: message_start opens it (its output count is a placeholder), each message_delta's cumulative count replaces it and never lowers it", () => {
    const t = new UsageTracker();
    expect(t.push({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } })).toMatchObject({ inputTokens: 10, cacheReadTokens: 90, outputTokens: 0, promptTokens: 100 });
    expect(t.push({ type: "message_delta", usage: { output_tokens: 30 } })).toMatchObject({ inputTokens: 10, outputTokens: 30 });
    expect(t.push({ type: "message_delta", usage: { output_tokens: 20, input_tokens: 400 } })).toMatchObject({ inputTokens: 400, outputTokens: 30 });
    expect(mapAnthropicUsage({ input_tokens: 0 })).toBeNull();
  });
});

describe("Anthropic Messages through providerFetch and the auth proxy", () => {
  const closers: { close(): Promise<void> }[] = [];
  afterEach(async () => { setProviderRuntime(null); setUsageSink(null); for (const c of closers.splice(0)) await c.close(); });
  async function setup(script: (n: number) => MsgReply, o: { proxyAllow?: () => { ok: boolean; message: string | null }; key?: string | null } = {}) {
    const up = await startFakeMessagesServer((_r, n) => script(n));
    closers.push(up);
    const rt = await startProviderRuntime({ anthropicUpstream: up.url, ...(o.proxyAllow ? { proxyAllow: o.proxyAllow } : {}), ...(o.key !== undefined ? { anthropicKey: o.key } : {}) });
    closers.push({ close: rt.stop });
    const runs: MeteredRun[] = [];
    setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
    const call = async (chunkBytes?: number) => {
      const a = new AnthropicMessagesAdapter();
      const s = await providerFetch({ purpose: "review", botId: "b1" }, a, { ref: "claude-sonnet-5", body: encodeAnthropic(req()), signal: new AbortController().signal });
      const dec = a.decoder();
      for await (const c of s.chunks) dec.push(c);
      void chunkBytes;
      return { msg: dec.finish(), settled: await s.settled };
    };
    return { up, rt, runs, call };
  }
  const classify = async (reply: MsgReply) => {
    const s = await setup(() => reply);
    try { await s.call(); return null; } catch (e) { return e instanceof ProviderCallError ? { ...e.cls, status: e.status } : e; }
  };

  it("the key stays in the proxy: the upstream gets the real key, the request left with a one-call token; the token is dead afterwards", async () => {
    const s = await setup(() => ({ blocks: [{ text: "hi" }] }));
    await s.call();
    const h = s.up.requests[0]!.headers;
    expect(h["x-api-key"]).toBe(ANTHROPIC_TEST_KEY);
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(s.rt.auth!.usage("b1").requests).toBe(1);
    // No double count: the call's own report covers everything the proxy metered.
    expect(s.rt.unreported).toEqual([]);
  });

  it("meters the call at Claude's list price with its cache multipliers, and records it once", async () => {
    const s = await setup(() => ({ blocks: [{ text: "hello" }], output: 50 }));
    const first = await s.call();
    const second = await s.call();
    expect(first.settled.cacheWriteTokens).toBeGreaterThan(0);
    expect(second.settled.cacheReadTokens).toBe(first.settled.cacheWriteTokens);
    expect(second.settled.costUsd).toBe(listCostUsd("claude-sonnet-5", { ...second.settled }));
    expect(second.settled.costUsd).toBeLessThan(first.settled.costUsd);
    expect(s.runs.map((r) => r.purpose)).toEqual(["review", "review"]); // a "turn" is recorded by the runner, from the brain's result
  });

  it("the same decoded message over the wire whatever the chunk size (1 byte … whole)", async () => {
    for (const chunkBytes of [1, 2, 3, 5, 11, 64, 4096]) {
      const s = await setup(() => ({ blocks: [{ thinking: "hmm — 🙂", signature: "sig" }, { text: "héllo 日本" }, { tool: "Shell", input: { command: "ls" } }], chunkBytes, pings: true }));
      const r = await s.call();
      expect(r.msg.text).toBe("héllo 日本");
      expect(r.msg.toolCalls.map((c) => JSON.parse(c.arguments))).toEqual([{ command: "ls" }]);
      expect((r.msg.providerMeta as { anthropic: { blocks: unknown[] } }).anthropic.blocks[0]).toEqual({ type: "thinking", thinking: "hmm — 🙂", signature: "sig" });
      await setProviderRuntime(null);
      for (const c of closers.splice(0)) await c.close();
    }
  });

  it("the error table: overloaded, rate limit (retry-after honoured), invalid key, context, credit, missing model, overloaded mid-stream", async () => {
    expect(await classify(apiError(529, "overloaded_error", "Overloaded"))).toMatchObject({ code: "BOT-E0401", retryable: true, inLoopRetry: true, status: 529 });
    expect(await classify(apiError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { "retry-after": "7" }))).toMatchObject({ code: "BOT-E0420", inLoopRetry: true, retryAfterMs: 7000 });
    expect(await classify(apiError(401, "authentication_error", "invalid x-api-key"))).toMatchObject({ code: "BOT-E0421", retryable: false });
    expect(await classify(apiError(400, "invalid_request_error", "prompt is too long: 1052012 tokens > 1000000 maximum"))).toMatchObject({ code: "BOT-E0404" });
    expect(await classify(apiError(413, "request_too_large", "Request exceeds the maximum allowed number of bytes."))).toMatchObject({ code: "BOT-E0404" });
    expect(await classify(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."))).toMatchObject({ code: "BOT-E0405", message: expect.stringMatching(/credit/) });
    expect(await classify(apiError(404, "not_found_error", "model: claude-nope"))).toMatchObject({ code: "BOT-MODEL" });
    expect(await classify(apiError(500, "api_error", "Internal server error"))).toMatchObject({ code: "BOT-E0406", retryable: true });
    expect(await classify({ blocks: [{ text: "partial" }], midError: { type: "overloaded_error", message: "Overloaded" } })).toMatchObject({ code: "BOT-E0401", retryable: true });
  });

  it("refused before sending: the spend budget (at the proxy), no key saved, no proxy", async () => {
    const budget = await setup(() => ({ blocks: [{ text: "x" }] }), { proxyAllow: () => ({ ok: false, message: "Monthly budget reached." }) });
    await expect(budget.call()).rejects.toMatchObject({ cls: { code: "BOT-E0405", message: "Monthly budget reached." } });
    expect(budget.up.requests).toHaveLength(0);
    const nokey = await setup(() => ({ blocks: [{ text: "x" }] }), { key: null });
    await expect(nokey.call()).rejects.toMatchObject({ cls: { code: "BOT-E0421" } });
    expect(nokey.up.requests).toHaveLength(0);
    nokey.rt.rt.anthropic = null; // no auth proxy at all: there is no way to Claude, said as the missing key
    await expect(nokey.call()).rejects.toMatchObject({ cls: { code: "BOT-E0421" } });
  });

  it("a stream cut partway is metered (estimated, never zero) and reported to the proxy, so nothing billed goes unrecorded", async () => {
    const s = await setup(() => ({ blocks: [{ text: "a long answer that never finishes" }], cutAfter: 3 }));
    await expect(s.call()).rejects.toBeInstanceOf(ProviderCallError);
    expect(s.runs).toHaveLength(1);
    const u = s.runs[0]!.usage;
    expect(u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens).toBeGreaterThan(0);
    expect(u.costUsd).toBeGreaterThan(0);
  });
});
