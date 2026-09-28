import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Replays real Anthropic API answers (bug 280). The fixtures in ./fixtures/api-recordings are sanitized recordings of
 * the owner's real Claude Code runs (see INDEX.md / NOTES.md there): every response exactly as it came, SSE bytes and
 * event order included, with filler text. This server hands them out one per request, at the recorded timing
 * compressed by `timeScale` (headers first, then each group of events at its recorded arrival time), and records
 * every request it sees so a test can check what went upstream.
 *
 * Like the real API: /v1/* needs `x-api-key` equal to `apiKey` (else the documented 401 body); an answer is compressed
 * only when the request's accept-encoding allows the encoding it was recorded with (gzip for SSE, br for JSON), so a
 * proxy that asks for `identity` gets plain bytes. `HEAD /api/hello` is answered 200 (the CLI's reachability check).
 */
export const RECORDINGS_DIR = path.join(__dirname, "fixtures", "api-recordings");

export interface RecordedEvent { t_ms: number; raw: string }
export interface Recording {
  file: string;
  scenario: string;
  request: { method: string; path: string; auth: string; headers: Record<string, string>; body: Record<string, unknown> & { model?: string; stream?: boolean } };
  response: { status: number; headers: Record<string, string>; ttfb_ms: number; total_ms: number; kind: "sse" | "json"; sse?: RecordedEvent[]; body?: unknown };
}

let cache: Recording[] | null = null;
export function loadRecordings(): Recording[] {
  cache ??= fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f.replace(/\.json$/, ""), ...(JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, f), "utf8")) as Omit<Recording, "file">) }));
  return cache;
}
/** One recording by its file-name prefix ("0020" or "0020-s08-websearch-sonnet5"). */
export function recording(prefix: string): Recording {
  const r = loadRecordings().find((x) => x.file.startsWith(prefix));
  if (!r) throw new Error(`no recording ${prefix}`);
  return r;
}
/** The stream body exactly as it came off the wire (decompressed). */
export const sseBody = (r: Recording): string => (r.response.sse ?? []).map((e) => e.raw).join("");
/** The parsed data of every SSE event. */
export function sseEvents(r: Recording): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const e of r.response.sse ?? []) for (const line of e.raw.split("\n")) if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)) as Record<string, any>);
  return out;
}

export interface FinalUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; webSearchRequests: number }
/**
 * What the recorded answer says it cost, by the API's contract: message_delta's usage is the message's final,
 * cumulative count (a server tool's fetches raise input_tokens after message_start); fields it leaves out keep
 * message_start's value. A JSON answer's `usage` is final as is.
 */
export function recordedUsage(r: Recording): FinalUsage {
  type U = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } };
  let u: U = {};
  if (r.response.kind === "json") u = ((r.response.body as { usage?: U }).usage ?? {});
  for (const e of sseEvents(r)) {
    if (e.type === "message_start") u = { ...(e.message?.usage as U) };
    if (e.type === "message_delta" && e.usage) u = { ...u, ...(e.usage as U), cache_creation: (e.usage as U).cache_creation ?? u.cache_creation, server_tool_use: (e.usage as U).server_tool_use ?? u.server_tool_use };
  }
  return {
    inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
  };
}

export interface SeenReplayRequest { method: string; path: string; headers: http.IncomingHttpHeaders; apiKey: string | null; authorization: string | null; beta: string | null; body: Record<string, unknown>; served: string | null }
export interface ReplayAnthropic {
  url: string;
  requests: SeenReplayRequest[];
  /** Recordings still to serve, in order (tests push onto it). */
  queue: Recording[];
  close(): Promise<void>;
}

const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "vary"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `pick`: chooses the recording for a request instead of the queue (return null to fall back to it). With neither, a
 * /v1 request gets 500 api_error "no recording queued" (a test that asked for more than it queued fails loudly).
 */
export async function startReplayAnthropic(o: { apiKey: string; queue?: Recording[]; timeScale?: number; pick?: (req: SeenReplayRequest) => Recording | null }): Promise<ReplayAnthropic> {
  const requests: SeenReplayRequest[] = [];
  const queue = [...(o.queue ?? [])];
  const scale = o.timeScale ?? 0.01;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void (async () => {
      const url = req.url ?? "/";
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ }
      const h = (k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string) : null);
      const seen: SeenReplayRequest = { method: req.method ?? "", path: url, headers: { ...req.headers }, apiKey: h("x-api-key"), authorization: h("authorization"), beta: h("anthropic-beta"), body, served: null };
      requests.push(seen);
      if (req.method === "HEAD" && url.startsWith("/api/hello")) { res.writeHead(200).end(); return; }
      if (!url.startsWith("/v1/")) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Not found" }, request_id: null })); return; }
      if (h("x-api-key") !== o.apiKey) {
        res.writeHead(401, { "content-type": "application/json", "x-should-retry": "false" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: null }));
        return;
      }
      const rec = o.pick?.(seen) ?? queue.shift() ?? null;
      if (!rec) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no recording queued" }, request_id: null })); return; }
      seen.served = rec.file;
      await serve(rec, req, res, scale);
    })());
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, queue, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function serve(rec: Recording, req: http.IncomingMessage, res: http.ServerResponse, scale: number): Promise<void> {
  const r = rec.response;
  const accepts = String(req.headers["accept-encoding"] ?? "");
  const recordedEnc = r.headers["content-encoding"] ?? "";
  const enc = recordedEnc && accepts.split(",").some((e) => e.trim().split(";")[0] === recordedEnc) ? recordedEnc : "";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (!DROP.has(k)) headers[k] = v;
  headers["request-id"] = `req_replay_${rec.file.slice(0, 4)}`;
  if (enc) headers["content-encoding"] = enc;
  if (r.kind === "json") {
    await sleep(r.ttfb_ms * scale);
    const plain = Buffer.from(JSON.stringify(r.body));
    const bytes = enc === "br" ? zlib.brotliCompressSync(plain) : enc === "gzip" ? zlib.gzipSync(plain) : plain;
    res.writeHead(r.status, { ...headers, "content-length": String(bytes.length) });
    res.end(bytes);
    return;
  }
  res.writeHead(r.status, headers);
  res.flushHeaders();
  const gz = enc === "gzip" ? zlib.createGzip() : null;
  if (gz) gz.pipe(res);
  const write = (s: string) => new Promise<void>((done) => {
    if (!gz) { res.write(s, () => done()); return; }
    gz.write(s);
    gz.flush(zlib.constants.Z_SYNC_FLUSH, () => done());
  });
  const t0 = Date.now();
  const events = r.sse ?? [];
  for (let i = 0; i < events.length;) {
    // Events that completed in the same network chunk arrive together, as they did.
    let j = i;
    let group = "";
    while (j < events.length && events[j]!.t_ms === events[i]!.t_ms) group += events[j++]!.raw;
    const wait = events[i]!.t_ms * scale - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    if (res.destroyed) return;
    await write(group);
    i = j;
  }
  if (gz) gz.end(); else res.end();
}
