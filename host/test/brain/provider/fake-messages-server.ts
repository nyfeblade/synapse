import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Anthropic Messages API for the Claude own-loop tests (no key, no network). Every POST /v1/messages is
 * recorded and answered by the script: a streamed reply built from blocks (text, thinking, redacted thinking, tool
 * calls, server-tool blocks), an error status, a stream cut partway, or an `event: error` sent mid-stream.
 *
 * It also SIMULATES THE PROMPT CACHE the way the API documents it: the prefix is tools → system → messages; a
 * `cache_control` breakpoint writes the prefix up to that block; a later request reads the longest cached prefix that
 * ends at one of its blocks within 20 blocks before one of its breakpoints. Tokens are counted as characters ÷ 4 of the
 * canonical JSON of each block (cache_control left out). So usage.cache_read_input_tokens / cache_creation_input_tokens
 * come out as the real API would report them for the same request bytes, and a test can measure cache hits.
 */
export interface MsgRequest { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown>; raw: string }
export type FakeBlock =
  | { text: string; citations?: unknown[] }
  | { thinking: string; signature: string }
  | { redacted: string }
  | { tool: string; id?: string; input: Record<string, unknown> }
  | { server: Record<string, unknown> };
export type MsgReply =
  | { blocks: FakeBlock[]; stop?: string; output?: number; webSearches?: number; chunkBytes?: number; cutAfter?: number; midError?: { type: string; message: string }; namedEvents?: boolean; pings?: boolean }
  | { status: number; body: string; headers?: Record<string, string> };

const tok = (s: string) => Math.ceil(s.length / 4);
const strip = (b: unknown): unknown => {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b;
  const { cache_control: _c, ...rest } = b as Record<string, unknown>;
  return rest;
};

/** The cache simulation: prefix hashes at every block, breakpoints where cache_control sits. */
export class PromptCacheSim {
  private cache = new Map<string, number>();
  account(body: Record<string, unknown>): { input: number; read: number; write: number; total: number } {
    const blocks: { json: string; bp: boolean; extra?: number }[] = [];
    // A tool sent with defer_loading is outside the prompt (and its prefix) until a tool_reference names it; the
    // reference then expands, where it sits, into the tool's definition (the tool search docs).
    const deferred = new Map<string, number>();
    for (const t of (body.tools as unknown[] | undefined) ?? []) {
      const def = t as { cache_control?: unknown; defer_loading?: unknown; name?: unknown };
      if (def.defer_loading) { deferred.set(String(def.name), tok(JSON.stringify(strip(t)))); continue; }
      blocks.push({ json: JSON.stringify(strip(t)), bp: !!def.cache_control });
    }
    const sys = body.system;
    if (typeof sys === "string") blocks.push({ json: JSON.stringify(sys), bp: false });
    else for (const b of (sys as unknown[] | undefined) ?? []) blocks.push({ json: JSON.stringify(strip(b)), bp: !!(b as { cache_control?: unknown }).cache_control });
    for (const m of (body.messages as { role: string; content: unknown }[] | undefined) ?? []) {
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown[]);
      content.forEach((b, i) => {
        const inner = (b as { type?: string; content?: unknown }).type === "tool_result" && Array.isArray((b as { content?: unknown }).content) ? (b as { content: { type?: string; tool_name?: string }[] }).content : [];
        const extra = inner.filter((x) => x.type === "tool_reference").reduce((a, x) => a + (deferred.get(String(x.tool_name)) ?? 0), 0);
        blocks.push({ json: (i === 0 ? `${m.role}:` : "") + JSON.stringify(strip(b)), bp: !!(b as { cache_control?: unknown }).cache_control, extra });
      });
    }
    const model = String(body.model ?? "");
    const h = createHash("sha256").update(model);
    const prefix: { hash: string; tokens: number }[] = [];
    let tokens = 0;
    for (const b of blocks) { h.update(b.json); tokens += tok(b.json) + (b.extra ?? 0); prefix.push({ hash: h.copy().digest("hex"), tokens }); }
    const bps = blocks.map((b, i) => (b.bp ? i : -1)).filter((i) => i >= 0);
    let read = 0;
    for (const bp of bps) for (let i = bp; i >= Math.max(0, bp - 20); i--) { const hit = this.cache.get(prefix[i]!.hash); if (hit !== undefined && hit > read) read = hit; }
    const last = bps.length ? prefix[bps.at(-1)!]!.tokens : 0;
    for (const bp of bps) this.cache.set(prefix[bp]!.hash, prefix[bp]!.tokens);
    const write = Math.max(0, last - read);
    return { input: tokens - Math.max(read, last), read, write, total: tokens };
  }
}

export async function startFakeMessagesServer(script: (req: MsgRequest, n: number) => MsgReply) {
  const requests: MsgRequest[] = [];
  const usages: { input: number; read: number; write: number; total: number }[] = [];
  const cache = new PromptCacheSim();
  const sockets = new Set<import("node:net").Socket>();
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
      const r: MsgRequest = { path: req.url ?? "", headers: req.headers, body, raw };
      requests.push(r);
      const reply = script(r, requests.length - 1);
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
        res.end(reply.body);
        return;
      }
      const u = cache.account(body);
      usages.push(u);
      const n = ++seq;
      const ev: string[] = [];
      const send = (type: string, data: Record<string, unknown>) => ev.push(`${reply.namedEvents === false ? "" : `event: ${type}\n`}data: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: u.input, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, ...(u.write && (JSON.stringify(body).includes("\"ttl\":\"1h\"")) ? { cache_creation: { ephemeral_1h_input_tokens: u.write, ephemeral_5m_input_tokens: 0 } } : {}), output_tokens: 1 } } });
      if (reply.pings) ev.push("event: ping\ndata: {\"type\":\"ping\"}\n\n");
      let tools = 0;
      reply.blocks.forEach((b, i) => {
        if ("text" in b) {
          send("content_block_start", { index: i, content_block: { type: "text", text: "" } });
          const third = Math.max(1, Math.ceil(b.text.length / 3));
          for (let k = 0; k < b.text.length; k += third) send("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text.slice(k, k + third) } });
          for (const c of b.citations ?? []) send("content_block_delta", { index: i, delta: { type: "citations_delta", citation: c } });
        } else if ("thinking" in b) {
          send("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
          send("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
          send("content_block_delta", { index: i, delta: { type: "signature_delta", signature: b.signature } });
        } else if ("redacted" in b) {
          send("content_block_start", { index: i, content_block: { type: "redacted_thinking", data: b.redacted } });
        } else if ("tool" in b) {
          const id = b.id ?? `toolu_${n}_${tools++}`;
          send("content_block_start", { index: i, content_block: { type: "tool_use", id, name: b.tool, input: {} } });
          const a = JSON.stringify(b.input);
          const half = Math.floor(a.length / 2);
          send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: a.slice(0, half) } });
          send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: a.slice(half) } });
        } else {
          send("content_block_start", { index: i, content_block: b.server });
        }
        send("content_block_stop", { index: i });
      });
      if (reply.midError) {
        ev.push(`event: error\ndata: ${JSON.stringify({ type: "error", error: reply.midError })}\n\n`);
      } else {
        const stop = reply.stop ?? (reply.blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn");
        const out = reply.output ?? Math.max(1, tok(JSON.stringify(reply.blocks)));
        send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: out, ...(reply.webSearches ? { server_tool_use: { web_search_requests: reply.webSearches } } : {}) } });
        send("message_stop", {});
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const all = (reply.cutAfter === undefined ? ev : ev.slice(0, reply.cutAfter)).join("");
      const buf = Buffer.from(all);
      const size = Math.max(1, reply.chunkBytes ?? buf.length);
      void (async () => {
        for (let i = 0; i < buf.length; i += size) { res.write(buf.subarray(i, i + size)); if (reply.chunkBytes) await new Promise((x) => setImmediate(x)); }
        if (reply.cutAfter !== undefined) { await new Promise((x) => setTimeout(x, 30)); res.destroy(); }
        else res.end();
      })();
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, requests, usages,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

/** A Messages error body, as the API sends it. */
export const apiError = (status: number, type: string, message: string, headers?: Record<string, string>): MsgReply =>
  ({ status, body: JSON.stringify({ type: "error", error: { type, message }, request_id: "req_x" }), ...(headers ? { headers } : {}) });

/**
 * The text of the turn's prompt: the last user turn with text of its own (not a tool result, not a system reminder).
 * A prompt that follows tool results (a resumed turn after a deferred call) shares their user turn, so blocks are read
 * one by one.
 */
export function promptOf(body: Record<string, unknown>): { prompt: string; after: number } {
  const msgs = body.messages as { role: string; content: { type: string; text?: string }[] }[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const text = m.content.filter((b) => b.type === "text" && b.text && !b.text.startsWith("<system-reminder>")).map((b) => b.text).join("\n");
    if (!text) continue;
    return { prompt: text, after: msgs.slice(i + 1).filter((x) => x.role === "assistant").length };
  }
  return { prompt: "", after: 0 };
}
