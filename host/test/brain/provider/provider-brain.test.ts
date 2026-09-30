import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, BrainWiring, PreToolDecision, ToolCall, TurnEvent, TurnInput } from "../../../brain/types";
import { setProviderRuntime } from "../../../usage/metered-provider";
import { startProviderRuntime, TEST_KEY } from "./runtime";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { finish, reply, startFakeChatServer, textChunks, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  setProviderRuntime(null);
  setUsageSink(null);
  for (const s of servers.splice(0)) await s.close();
});

function wiringWith(o: { tools?: BotToolDef[]; pre?: (c: ToolCall) => PreToolDecision; stopBlocks?: string[] } = {}) {
  const log: string[] = [];
  const stops = [...(o.stopBlocks ?? [])];
  const w: BrainWiring = {
    preToolUse: async (c) => { log.push(`pre:${c.toolName}:${JSON.stringify(c.input)}`); return o.pre?.(c) ?? { decision: "allow" }; },
    canUseTool: async (c) => { log.push(`can:${c.toolName}`); return { behavior: "allow" }; },
    postToolUse: async (c, out) => { log.push(`post:${c.toolName}:${out}`); return {}; },
    stop: async (i) => { log.push(`stop:${i.stopHookActive}`); const r = stops.shift(); return r ? { block: true, reason: r } : { block: false }; },
    toolBatch: async (calls) => { log.push(`batch:${calls.length}`); return { endTurn: false }; },
    botTools: () => o.tools ?? [],
    turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    flags: () => DEFAULT_FLAGS,
  };
  return { w, log };
}

async function setup(script: (req: FakeRequest, n: number) => FakeReply, o: Parameters<typeof wiringWith>[0] = {}) {
  const server = await startFakeChatServer(script);
  servers.push(server);
  const runs: MeteredRun[] = [];
  setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
  const rt = await startProviderRuntime({ upstream: server.url, firstByteMs: 2000, idleMs: 2000 });
  servers.push({ close: rt.stop });
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-"));
  const store = new ProviderSessionStore(hp);
  let sid: string | null = null;
  const { w, log } = wiringWith(o);
  const mk = () => new ProviderBrain({ botId: "bot_1", wiring: w, store, getSessionId: () => sid, systemPrompt: (a) => `SYS ${a}`, sleep: async () => {} });
  const brain = mk();
  const events: TurnEvent[] = [];
  const run = async (b: ProviderBrain, text: string, extra: Partial<TurnInput> = {}) => {
    const r = await b.runTurn({ prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "APPEND", model: "openai:gpt-test", autoReviewEpoch: "continue", ...extra }, (e) => {
      events.push(e);
      if (e.kind === "session") sid = e.sessionId;
    });
    return r;
  };
  return { server, brain, mk, run, events, log, runs, store, sid: () => sid };
}

const shellTool = (calls: Record<string, unknown>[]): BotToolDef => ({
  name: "Shell", description: "Run a command", readOnly: false,
  schema: { command: z.string(), timeout: z.number().optional() },
  handler: async (a) => { calls.push(a); return { text: `ran ${String(a.command)}` }; },
});
const sendTool = (sent: string[]): BotToolDef => ({
  name: "SendMessage", description: "Send", readOnly: false, schema: { content: z.string() },
  handler: async (a) => { sent.push(String(a.content)); return { text: "Sent." }; },
});

describe("ProviderBrain", () => {
  it("streams a text reply, runs the Stop hook, meters the call and saves the conversation", async () => {
    const s = await setup(() => reply({ text: "Hello there", usage: [120, 7] }));
    const r = await s.run(s.brain, "hi");
    expect(r).toMatchObject({ aborted: false, finalText: "Hello there", toolCallCount: 0, model: "openai:gpt-test", usage: { inputTokens: 120, outputTokens: 7 } });
    expect(r.usage.costUsd).toBeGreaterThan(0);
    expect(r.error).toBeUndefined();
    const kinds = s.events.map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(["session", "dispatched", "thinking"]);
    expect(s.events.filter((e) => e.kind === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello there");
    expect(s.events).toContainEqual({ kind: "context", tokens: 120 });
    expect(s.sid()).toMatch(/^prov-/);
    expect(s.log).toEqual(["stop:false"]);
    // the request: system prompt with the append, the user's text, the key in the header, streamed usage
    const req = s.server.requests[0]!;
    expect(req.path).toBe("/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${TEST_KEY}`); // the proxy swapped its token for the key
    expect(req.body).toMatchObject({ model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "SYS APPEND" }, { role: "user", content: "hi" }] });
    expect(s.runs).toEqual([]); // turn usage goes back in the TurnResult, as for Claude
    const saved = s.store.load("bot_1", s.sid()!);
    expect(saved).toEqual([{ role: "user", parts: [{ type: "text", text: "hi" }] }, { role: "assistant", text: "Hello there", toolCalls: [] }]);
  });

  it("runs a tool through the wiring, streams SendMessage's arguments, and sends the results back", async () => {
    const ran: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const s = await setup((_r, n) => n === 0
      ? reply({ calls: [{ id: "call_a", name: "Shell", args: { command: "ls", timeout: null } }, { id: "call_b", name: "SendMessage", args: { content: "Done: two files" } }] })
      : reply({ text: "" }), { tools: [shellTool(ran), sendTool(sent)] });
    const r = await s.run(s.brain, "list files");
    expect(r.toolCallCount).toBe(2);
    expect(ran).toEqual([{ command: "ls" }]); // null stripped before zod (phase 0 3c)
    expect(sent).toEqual(["Done: two files"]);
    expect(s.log).toEqual(["pre:mcp__bot__Shell:{\"command\":\"ls\"}", "post:mcp__bot__Shell:ran ls", "pre:mcp__bot__SendMessage:{\"content\":\"Done: two files\"}", "post:mcp__bot__SendMessage:Sent.", "batch:2", "stop:false"]);
    const deltas = s.events.filter((e) => e.kind === "send_message_delta") as Extract<TurnEvent, { kind: "send_message_delta" }>[];
    expect(deltas.every((d) => d.toolUseId === "call_b")).toBe(true);
    expect(deltas.map((d) => d.partialJson).join("")).toBe("{\"content\":\"Done: two files\"}");
    const starts = s.events.filter((e) => e.kind === "tool_start").map((e) => (e as { name: string }).name);
    expect(starts).toEqual(["mcp__bot__Shell", "mcp__bot__SendMessage"]);
    const second = s.server.requests[1]!.body.messages as Record<string, unknown>[];
    expect(second.slice(-3)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "Shell", arguments: "{\"command\":\"ls\",\"timeout\":null}" } }, { id: "call_b", type: "function", function: { name: "SendMessage", arguments: "{\"content\":\"Done: two files\"}" } }] },
      { role: "tool", tool_call_id: "call_a", content: "ran ls" },
      { role: "tool", tool_call_id: "call_b", content: "Sent." },
    ]);
    expect(s.server.requests[0]!.body.tools).toHaveLength(2);
  });

  it("an invented tool, bad JSON and invalid input get error results and never reach the gate", async () => {
    const ran: Record<string, unknown>[] = [];
    const s = await setup((_r, n) => n === 0
      ? { sse: [{ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "c1", function: { name: "Bash", arguments: "{}" } },
        { index: 1, id: "c2", function: { name: "Shell", arguments: "{not json" } },
        { index: 2, id: "c3", function: { name: "Shell", arguments: "{\"command\":5}" } },
      ] } }] }, finish("tool_calls"), usageChunk(10, 5)] }
      : reply({ text: "ok" }), { tools: [shellTool(ran)] });
    await s.run(s.brain, "go");
    expect(ran).toEqual([]);
    expect(s.log.filter((l) => l.startsWith("pre:"))).toEqual([]);
    const tools = (s.server.requests[1]!.body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[0]).toContain("No such tool available: Bash");
    expect(tools[1]).toContain("not valid JSON");
    expect(tools[2]).toContain("InputValidationError");
  });

  it("retries a 503 and a stream cut partway, discarding the partial reply; every attempt is metered", async () => {
    const s = await setup((_r, n) => n === 0 ? { status: 503, body: "{\"error\":{\"message\":\"overloaded\"}}" }
      : n === 1 ? { sse: [...textChunks("partial reply that will be"), usageChunk(0, 0)], cutAfter: 2, chunkBytes: 20, delayMs: 5 }
        : reply({ text: "whole reply", usage: [50, 5] }));
    const r = await s.run(s.brain, "hi");
    expect(r.finalText).toBe("whole reply");
    expect(s.events.filter((e) => e.kind === "retry")).toEqual([
      { kind: "retry", attempt: 1, errorStatus: 503, resetStream: true },
      { kind: "retry", attempt: 2, errorStatus: null, resetStream: true },
    ]);
    // the cut stream reported no usage: estimated from its bytes, never zero
    expect(r.usage.inputTokens).toBeGreaterThan(50);
    expect(s.store.load("bot_1", s.sid()!).filter((m) => m.role === "assistant")).toEqual([{ role: "assistant", text: "whole reply", toolCalls: [] }]);
  });

  it("a 401 fails at once (no retry), keeps the user's message, and classifies the error", async () => {
    const s = await setup(() => ({ status: 401, body: "{\"error\":{\"message\":\"Incorrect API key\"}}" }));
    const r = await s.run(s.brain, "hi");
    expect(r.error).toMatchObject({ code: "BOT-E0421", retryable: false, trayTitle: "Key rejected" });
    expect(s.server.requests).toHaveLength(1);
    expect(s.store.load("bot_1", s.sid()!)).toEqual([{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
  });

  it("gives up after 4 attempts on a retryable error and rolls the prompt back for the runner's retry", async () => {
    const s = await setup(() => ({ status: 500, body: "{}" }));
    const r = await s.run(s.brain, "hi");
    expect(r.error).toMatchObject({ code: "BOT-E0406", retryable: true });
    expect(s.server.requests).toHaveLength(4);
    expect(s.store.load("bot_1", s.sid() ?? "prov-none")).toEqual([]);
  });

  it("interrupt() aborts the stream and ends the turn aborted", async () => {
    const s = await setup(() => ({ sse: textChunks("slow slow slow slow", 10), delayMs: 200 }));
    const p = s.run(s.brain, "hi");
    await new Promise((r) => setTimeout(r, 150));
    await s.brain.interrupt("user");
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(s.brain.procState).toBe("warm_idle");
  });

  it("a blocking Stop hook appends its reason and loops; steering messages join at the next model call", async () => {
    const s = await setup((_r, n) => reply({ text: `answer ${n}` }), { stopBlocks: ["You haven't replied yet."] });
    s.brain.pushUserMessage({ text: "early steer" });
    const r = await s.run(s.brain, "hi");
    expect(r.finalText).toBe("answer 1");
    expect(s.log).toEqual(["stop:false", "stop:true"]);
    const first = s.server.requests[0]!.body.messages as { role: string; content: string }[];
    expect(first.at(-1)).toEqual({ role: "user", content: "hi\n\nearly steer" });
    const second = s.server.requests[1]!.body.messages as { role: string; content: string }[];
    expect(second.at(-1)).toEqual({ role: "user", content: "You haven't replied yet." });
  });

  it("history survives cool() and a new brain: the next turn re-sends it, thought signatures echoed", async () => {
    const SIG = { google: { thought_signature: "abc" } };
    const ran: Record<string, unknown>[] = [];
    const s = await setup((_r, n) => n === 0 ? reply({ calls: [{ id: "g1", name: "Shell", args: { command: "pwd" }, extra: { extra_content: SIG } }] }) : reply({ text: `t${n}` }), { tools: [shellTool(ran)] });
    await s.run(s.brain, "one", { model: "gemini:gemini-test" });
    await s.brain.cool("idle");
    await s.run(s.mk(), "two", { model: "gemini:gemini-test" });
    const msgs = s.server.requests[2]!.body.messages as Record<string, unknown>[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect((msgs[2]!.tool_calls as Record<string, unknown>[])[0]!.extra_content).toEqual(SIG);
  });

  it("toolBatch endTurn ends the turn with no further model call", async () => {
    const sent: string[] = [];
    const s = await setup(() => reply({ calls: [{ id: "c", name: "SendMessage", args: { content: "hi" } }] }), { tools: [sendTool(sent)] });
    const w = (s.brain as unknown as { d: { wiring: BrainWiring } }).d.wiring;
    w.toolBatch = async () => ({ endTurn: true });
    await s.run(s.brain, "hi");
    expect(s.server.requests).toHaveLength(1);
    expect(sent).toEqual(["hi"]);
  });

  it("refuses a model that isn't a provider ref, and a routed Claude model is ignored", async () => {
    const s = await setup(() => reply({ text: "ok" }));
    expect((await s.run(s.brain, "hi", { model: "claude-sonnet-5" })).error?.code).toBe("BOT-MODEL");
    const r = await s.run(s.brain, "hi", { routedModel: "claude-haiku-4-5-20251001" });
    expect(r.model).toBe("openai:gpt-test");
    expect(s.server.requests.at(-1)!.body.model).toBe("gpt-test");
  });
});

describe("tool results with images", () => {
  it("go to the model in a follow-up user message", async () => {
    const tool: BotToolDef = { name: "Screenshot", description: "shot", readOnly: true, schema: {}, handler: async () => ({ text: "here", images: [{ mimeType: "image/png", data: "iVBOR" }] }) };
    const s = await setup((_r, n) => n === 0 ? { sse: [...toolChunks([{ id: "s1", name: "Screenshot", args: {} }]), finish("tool_calls"), usageChunk(5, 5)] } : reply({ text: "I see" }), { tools: [tool] });
    await s.run(s.brain, "look", { model: "gemini:g" });
    const msgs = s.server.requests[1]!.body.messages as Record<string, unknown>[];
    expect(msgs.at(-2)).toEqual({ role: "tool", tool_call_id: "s1", content: "here" });
    expect(msgs.at(-1)).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] });
  });
});
