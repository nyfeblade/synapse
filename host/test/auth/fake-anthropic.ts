import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Anthropic Messages API that speaks its real wire format, for proving API-key
 * sign-in with no real key (ANTHROPIC_BASE_URL points here):
 *   - POST /v1/messages, streamed (SSE: message_start … ping … content blocks … message_delta, message_stop)
 *     or plain JSON; text and tool_use blocks; usage with cache_read/cache_creation tokens;
 *   - x-api-key is checked: a missing or wrong key gets the real 401 body
 *     {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}};
 *   - scripted failures (401/402 billing_error/403/404/429 with retry-after/500/529 overloaded_error), each
 *     with the documented error body and the request-id / retry-after / x-should-retry headers.
 * A call carrying tools is a conversational call: it takes the next scripted reply (the last repeats) and the next
 * scripted failure. Anything else (count_tokens, side helpers) gets a minimal answer.
 */
export type Block = { text: string } | { tool: string; input: Record<string, unknown> };
export interface Failure { status: number; type: string; message?: string; retryAfterSec?: number }
export interface SeenRequest { path: string; method: string; apiKey: string | null; authorization: string | null; version: string | null; beta: string | null; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; conversational: boolean; stream: boolean }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface FakeAnthropic {
  url: string;
  requests: SeenRequest[];
  /** Replies still to come; a test can push failures between turns. */
  failures: Failure[];
  close(): Promise<void>;
}

const sse = (res: http.ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
let reqNo = 0;

export function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message }, request_id: `req_fake_${reqNo}` });
}

function fail(res: http.ServerResponse, f: Failure): void {
  const h: Record<string, string> = { "content-type": "application/json", "request-id": `req_fake_${reqNo}` };
  if (f.retryAfterSec !== undefined) h["retry-after"] = String(f.retryAfterSec);
  h["x-should-retry"] = f.status === 429 || f.status >= 500 ? "true" : "false";
  res.writeHead(f.status, h);
  res.end(errorBody(f.type, f.message ?? f.type));
}

function stream(res: http.ServerResponse, model: string, blocks: Block[], n: number, u: Usage): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${reqNo}` });
  const usage = { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite };
  sse(res, "message_start", { type: "message_start", message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  sse(res, "ping", { type: "ping" });
  blocks.forEach((b, i) => {
    if ("text" in b) {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      // Two deltas: the text really streams in pieces.
      const mid = Math.ceil(b.text.length / 2);
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text.slice(0, mid) } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text.slice(mid) } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_fake_${n}_${i}`, name: b.tool, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: i });
  });
  const stop = blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn";
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: u.output } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

/** `bearer`: also accept `authorization: Bearer <bearer>` (a subscription OAuth token), as the real API does. */
/**
 * `models`: what count_tokens (and messages) say per model, as the real API does for a key: a denied model gets 404
 * not_found_error; one in `noLongContext` refuses the context-1m beta with 400 invalid_request_error.
 */
export async function startFakeAnthropic(o: { apiKey: string; bearer?: string; script: Block[][]; failures?: Failure[]; usage?: Usage; models?: { deny?: string[]; noLongContext?: string[] }; webSearches?: number }): Promise<FakeAnthropic> {
  const requests: SeenRequest[] = [];
  const failures = [...(o.failures ?? [])];
  const usage = o.usage ?? { input: 12, output: 7, cacheRead: 300, cacheWrite: 40 };
  let conversational = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", () => {
      reqNo++;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* not JSON */ }
      const url = req.url ?? "";
      const isMessages = req.method === "POST" && url.startsWith("/v1/messages") && !url.includes("count_tokens");
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const conv = isMessages && tools.length > 0;
      const h = (k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string) : null);
      requests.push({ path: url, method: req.method ?? "", apiKey: h("x-api-key"), authorization: h("authorization"), version: h("anthropic-version"), beta: h("anthropic-beta"), headers: { ...req.headers }, body, conversational: conv, stream: body.stream === true });
      // Only the API (/v1/…) is authenticated; the CLI's /api/hello reachability check is not.
      const authed = h("x-api-key") === o.apiKey || (!!o.bearer && h("authorization") === `Bearer ${o.bearer}`);
      if (url.startsWith("/v1/") && !authed) {
        res.writeHead(401, { "content-type": "application/json", "request-id": `req_fake_${reqNo}`, "x-should-retry": "false" });
        res.end(errorBody("authentication_error", "invalid x-api-key"));
        return;
      }
      const askedModel = typeof body.model === "string" ? body.model : "";
      if (url.startsWith("/v1/messages") && o.models?.deny?.includes(askedModel)) { fail(res, { status: 404, type: "not_found_error", message: `model: ${askedModel}` }); return; }
      if (url.startsWith("/v1/messages") && o.models?.noLongContext?.includes(askedModel) && (h("anthropic-beta") ?? "").includes("context-1m")) {
        fail(res, { status: 400, type: "invalid_request_error", message: "The long context beta is not yet available for this subscription." });
        return;
      }
      if (!isMessages) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(url.includes("count_tokens") ? { input_tokens: 10 } : { data: [], has_more: false }));
        return;
      }
      if (conv && failures.length) { fail(res, failures.shift()!); return; }
      const model = typeof body.model === "string" ? body.model : "claude-haiku-4-5-20251001";
      const blocks = conv ? (o.script[Math.min(conversational, o.script.length - 1)] ?? [{ text: "ok" }]) : [{ text: "ok" }];
      if (conv) conversational++;
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${reqNo}` });
        res.end(JSON.stringify({ id: `msg_fake_${reqNo}`, type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(o.webSearches ? { server_tool_use: { web_search_requests: o.webSearches } } : {}) } }));
        return;
      }
      stream(res, model, blocks, conversational, conv ? usage : { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, failures, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
