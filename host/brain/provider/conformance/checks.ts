import { parseProviderModelRef } from "@synapse/shared";
import { z } from "zod";
import { providerComplete } from "../../../helper-model/llm";
import { providerFetch, ProviderCallError } from "../../../usage/metered-provider";
import { DEFAULT_FLAGS } from "../../conformance/flags";
import type { BotToolDef, BrainWiring } from "../../types";
import { ChatCompletionsAdapter } from "../adapters/chat-completions";
import type { CanonMessage, CanonRequest, DecodedMessage, WireTool } from "../adapters/types";
import { quirksFor } from "../adapters/quirks";
import { ProviderBrain } from "../provider-brain";
import { ToolRegistry } from "../tool-registry";
import { CONFORMANCE_VERSION, MUST_PASS, type ConformanceRecord, type PcId, type PcResult, type ProviderFlags } from "./evidence";

/**
 * Provider conformance, PC-01..PC-15 (spec §11.1): what ProviderBrain relies on, checked on one model through the real
 * provider path (providerFetch → the provider proxy → the provider), metered as "conformance". It runs when a model is
 * first picked (or on demand) and its result drives the model's badge and "What works".
 *
 *   PC-01 streamed text              PC-06 usage in the stream           PC-11 abort mid-stream
 *   PC-02 tool round trip            PC-07 cached tokens reported        PC-12 reasoning_effort accepted
 *   PC-03 parallel tool calls        PC-08 image input                   PC-13 the Stop loop terminates
 *   PC-04 our schemas accepted       PC-09 image in a tool result        PC-14 structured output validates
 *   PC-05 streamed tool arguments    PC-10 401/404 classified            PC-15 answers in text when no tool is needed
 * Must pass: 01, 02, 04, 05, 06, 10, 11, 13 (evidence.ts MUST_PASS). A failed must-pass check blocks the model.
 */
export interface CheckCtx { ref: string; provider: string; model: string; adapter: ChatCompletionsAdapter; signal: AbortSignal; state: Record<string, unknown> }
type Check = { id: PcId; name: string; run(ctx: CheckCtx): Promise<{ ok: boolean; detail: string } | "skip"> };

const PNG_2x2_RED = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAwMDAAAAODgEBcNXJHgAAAABJRU5ErkJggg==";
const ECHO: WireTool = { name: "echo", description: "Echo a piece of text back.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, strict: false };
const SNAP: WireTool = { name: "snapshot", description: "Take a picture of the screen.", parameters: { type: "object", properties: {} }, strict: false };

async function call(ctx: CheckCtx, req: Partial<CanonRequest> & { messages: CanonMessage[] }, o: { keyOverride?: string; model?: string; abortAfterFirst?: boolean } = {}): Promise<{ msg: DecodedMessage; deltas: number; estimated: boolean; ms: number }> {
  const body = ctx.adapter.encode({ model: o.model ?? ctx.model, system: "You are a test harness. Be brief.", tools: [], wireName: (n) => n, maxOutputTokens: 300, ...req });
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const t0 = Date.now();
  let estimated = false;
  try {
    const s = await providerFetch({ purpose: "conformance", botId: null }, ctx.adapter, { ref: ctx.ref, body, signal: ac.signal, ...(o.keyOverride ? { keyOverride: o.keyOverride } : {}), onUsage: (u) => { estimated = u.estimated; } });
    const dec = ctx.adapter.decoder();
    let deltas = 0;
    for await (const c of s.chunks) {
      for (const ev of dec.push(c)) {
        if (ev.kind === "tool_delta" && ev.delta) deltas++;
        if (o.abortAfterFirst && (ev.kind === "text" || ev.kind === "tool_delta")) ac.abort();
      }
    }
    return { msg: dec.finish(), deltas, estimated, ms: Date.now() - t0 };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
const user = (text: string): CanonMessage => ({ role: "user", parts: [{ type: "text", text }] });

export const CHECKS: Check[] = [
  { id: "PC-01", name: "streamed text", run: async (ctx) => {
    const r = await call(ctx, { messages: [user("Reply with the single word OK.")] });
    ctx.state.pc01 = r;
    return { ok: r.msg.text.trim().length > 0, detail: `${r.msg.text.trim().slice(0, 40)} (${r.ms} ms)` };
  } },
  { id: "PC-02", name: "tool round trip", run: async (ctx) => {
    const first = await call(ctx, { messages: [user("Call the echo tool with the text ping, then tell me in one word what it returned.")], tools: [ECHO] });
    ctx.state.pc02 = first;
    const tc = first.msg.toolCalls[0];
    if (!tc || tc.name !== "echo") return { ok: false, detail: "no echo call" };
    let args: { text?: unknown } = {};
    try { args = JSON.parse(tc.arguments) as { text?: unknown }; } catch { return { ok: false, detail: "arguments not JSON" }; }
    const back = await call(ctx, { tools: [ECHO], messages: [user("Call the echo tool with the text ping, then tell me in one word what it returned."), { role: "assistant", text: first.msg.text, toolCalls: [{ id: tc.id, name: "echo", arguments: tc.arguments, ...(tc.providerMeta !== undefined ? { providerMeta: tc.providerMeta } : {}) }] }, { role: "tool", toolCallId: tc.id, name: "echo", text: String(args.text ?? ""), isError: false }] });
    return { ok: typeof args.text === "string" && (back.msg.text.trim().length > 0 || back.msg.toolCalls.length > 0), detail: `echo(${JSON.stringify(args.text)}) then ${back.msg.text.trim() ? "text" : "a call"}` };
  } },
  { id: "PC-03", name: "parallel tool calls", run: async (ctx) => {
    const r = await call(ctx, { messages: [user("In ONE reply, call the echo tool twice: once with a, once with b.")], tools: [ECHO] });
    return { ok: r.msg.toolCalls.length >= 2, detail: `${r.msg.toolCalls.length} call(s)` };
  } },
  { id: "PC-04", name: "our schemas accepted", run: async (ctx) => {
    const defs: BotToolDef[] = [
      { name: "SendMessage", description: "Send the user a message.", readOnly: false, handler: async () => ({ text: "" }), schema: { content: z.string(), type: z.enum(["text", "widget"]).optional(), widget: z.looseObject({}).optional(), end_turn: z.boolean().optional() } },
      { name: "Shell", description: "Run a command.", readOnly: false, handler: async () => ({ text: "" }), schema: { command: z.string(), notify_on_output: z.object({ pattern: z.string(), reason: z.string(), debounce_ms: z.number().int().min(5000).optional() }).optional() } },
      { name: "gmail_send", description: "Send an email.", readOnly: false, handler: async () => ({ text: "" }), schema: { to: z.union([z.string(), z.array(z.string())]), subject: z.string(), body: z.string() } },
    ];
    const reg = ToolRegistry.forBotTools(defs, quirksFor(parseProviderModelRef(ctx.ref)!.provider).schemaDialect);
    const r = await call(ctx, { messages: [user("Reply with OK. Do not call any tool.")], tools: reg.wireTools() });
    return { ok: true, detail: `accepted ${reg.wireTools().length} tools (${r.ms} ms)` };
  } },
  { id: "PC-05", name: "streamed tool arguments", run: async (ctx) => {
    const r = ctx.state.pc02 as { msg: DecodedMessage; deltas: number } | undefined;
    if (!r) return "skip";
    const tc = r.msg.toolCalls[0];
    ctx.state.streamedArgs = r.deltas > 1;
    return { ok: !!tc && tc.arguments.length > 0, detail: `${r.deltas} argument chunk(s)` };
  } },
  { id: "PC-06", name: "usage in the stream", run: async (ctx) => {
    const r = ctx.state.pc01 as { msg: DecodedMessage; estimated: boolean } | undefined;
    if (!r) return "skip";
    return { ok: !r.estimated && !!r.msg.usage, detail: r.msg.usage ? `${r.msg.usage.promptTokens} prompt tokens` : "no usage frame" };
  } },
  { id: "PC-07", name: "cached tokens reported", run: async (ctx) => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog.`).join("\n");
    await call(ctx, { messages: [user(`${long}\n\nReply OK.`)] });
    const r = await call(ctx, { messages: [user(`${long}\n\nReply OK.`)] });
    const cached = r.msg.usage?.cacheReadTokens ?? 0;
    return { ok: cached > 0, detail: `${cached} cached tokens` };
  } },
  { id: "PC-08", name: "image input", run: async (ctx) => {
    const r = await call(ctx, { messages: [{ role: "user", parts: [{ type: "text", text: "What colour is this image? One word." }, { type: "image", mediaType: "image/png", dataBase64: PNG_2x2_RED }] }] });
    return { ok: r.msg.text.trim().length > 0, detail: r.msg.text.trim().slice(0, 40) };
  } },
  { id: "PC-09", name: "image in a tool result", run: async (ctx) => {
    const r = await call(ctx, { tools: [SNAP], messages: [user("What colour is the screen? One word."), { role: "assistant", text: "", toolCalls: [{ id: "call_snap", name: "snapshot", arguments: "{}" }] }, { role: "tool", toolCallId: "call_snap", name: "snapshot", text: "Here is the screen.", isError: false, images: [{ mimeType: "image/png", data: PNG_2x2_RED }] }] });
    return { ok: r.msg.text.trim().length > 0, detail: r.msg.text.trim().slice(0, 40) };
  } },
  { id: "PC-10", name: "401 and 404 classified", run: async (ctx) => {
    const codes: string[] = [];
    const provider = parseProviderModelRef(ctx.ref)!.provider;
    if (quirksFor(provider).authHeader === "bearer") {
      try { await call(ctx, { messages: [user("OK?")] }, { keyOverride: "sk-synapse-conformance-invalid-key-000000" }); codes.push("401:none"); } catch (e) { codes.push(`401:${e instanceof ProviderCallError ? e.cls.code : "thrown"}`); }
    }
    try { await call(ctx, { messages: [user("OK?")] }, { model: "synapse-no-such-model-pc10" }); codes.push("404:none"); } catch (e) { codes.push(`404:${e instanceof ProviderCallError ? e.cls.code : "thrown"}`); }
    const ok = codes.every((c) => c === "401:BOT-E0421" || c === "404:BOT-MODEL");
    return { ok, detail: codes.join(", ") };
  } },
  { id: "PC-11", name: "abort mid-stream", run: async (ctx) => {
    const t0 = Date.now();
    try {
      await call(ctx, { messages: [user("Count from 1 to 300, one number per line.")], maxOutputTokens: 2000 }, { abortAfterFirst: true });
    } catch { /* the abort surfaces as an error: expected */ }
    const ms = Date.now() - t0;
    return { ok: ms < 30_000, detail: `stopped after ${ms} ms` };
  } },
  { id: "PC-12", name: "reasoning_effort accepted", run: async (ctx) => {
    if (!quirksFor(parseProviderModelRef(ctx.ref)!.provider).reasoningParam) return "skip";
    const r = await call(ctx, { messages: [user("Reply OK.")], effort: "low" });
    return { ok: r.msg.text.trim().length > 0, detail: "accepted" };
  } },
  { id: "PC-13", name: "the Stop loop terminates", run: async (ctx) => {
    let blocks = 0;
    const wiring: BrainWiring = {
      preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
      stop: async () => (blocks++ === 0 ? { block: true, reason: "Reply with the word DONE." } : { block: false }),
      botTools: () => [], flags: () => DEFAULT_FLAGS, turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    };
    const store = { load: () => [], append: () => {}, appendBoundary: () => {}, version: () => 0, file: () => "" } as unknown as ConstructorParameters<typeof ProviderBrain>[0]["store"];
    const brain = new ProviderBrain({ botId: "conformance", wiring, store, getSessionId: () => null, maxModelCalls: 4, systemPrompt: () => "Be brief." });
    const r = await brain.runTurn({ prompt: [{ text: "Say hi." }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "pc13", systemAppend: "", model: ctx.ref, autoReviewEpoch: "continue" }, () => {});
    return { ok: !r.error && blocks === 2, detail: r.error ? r.error.message : `ended after ${blocks} Stop checks` };
  } },
  { id: "PC-14", name: "structured output validates", run: async (ctx) => {
    const r = await providerComplete({ purpose: "conformance", botId: null, ref: ctx.ref, system: "Reply with one JSON object only.", user: "Give the colour of the sky on a clear day.", schema: { type: "object", additionalProperties: false, required: ["colour"], properties: { colour: { type: "string" } } }, maxTokens: 200, signal: ctx.signal });
    return { ok: typeof (r.json as { colour?: unknown }).colour === "string", detail: JSON.stringify(r.json).slice(0, 60) };
  } },
  { id: "PC-15", name: "answers in text when no tool is needed", run: async (ctx) => {
    const r = await call(ctx, { messages: [user("What is 2 + 2? Answer in text.")], tools: [ECHO] });
    return { ok: r.msg.toolCalls.length === 0 && r.msg.text.trim().length > 0, detail: r.msg.toolCalls.length ? "called a tool" : r.msg.text.trim().slice(0, 20) };
  } },
];

/** Runs the checks (all, or `only`) on `ref` and returns the record to store. */
export async function runConformance(ref: string, o: { only?: string[]; signal?: AbortSignal; now?: () => number } = {}): Promise<ConformanceRecord> {
  const p = parseProviderModelRef(ref);
  if (!p) throw new Error(`not a provider model: ${ref}`);
  const ctx: CheckCtx = { ref, provider: p.provider, model: p.model, adapter: new ChatCompletionsAdapter(p.provider), signal: o.signal ?? new AbortController().signal, state: {} };
  const results: PcResult[] = [];
  for (const c of CHECKS) {
    if (o.only && !o.only.includes(c.id)) { results.push({ id: c.id, status: "skip", detail: "not run", ms: 0 }); continue; }
    const t0 = Date.now();
    try {
      const r = await c.run(ctx);
      results.push(r === "skip" ? { id: c.id, status: "skip", detail: "not applicable", ms: 0 } : { id: c.id, status: r.ok ? "pass" : "fail", detail: r.detail, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ id: c.id, status: "fail", detail: e instanceof ProviderCallError ? `${e.cls.code}: ${e.cls.message}` : String((e as Error).message ?? e).slice(0, 200), ms: Date.now() - t0 });
    }
  }
  const st = (id: PcId) => results.find((r) => r.id === id)?.status;
  const flag = (id: PcId): boolean | null => (st(id) === "pass" ? true : st(id) === "fail" ? false : null);
  const flags: ProviderFlags = { parallelTools: flag("PC-03"), cachedTokens: flag("PC-07"), vision: flag("PC-08"), toolImages: flag("PC-09"), reasoningEffort: flag("PC-12"), structuredOutput: flag("PC-14"), streamedArgs: typeof ctx.state.streamedArgs === "boolean" ? ctx.state.streamedArgs : null };
  // A partial run (a live sample) can block a model but never clear it: every must-pass check has to have run and passed.
  const mustPass = MUST_PASS.every((id) => st(id) === "pass");
  return { ref, at: (o.now ?? Date.now)(), version: CONFORMANCE_VERSION, results, mustPass, flags };
}
