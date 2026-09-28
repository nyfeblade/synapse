import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { withoutLoginBetas, type MacMeteredUsage } from "@synapse/shared";

/**
 * Security review (blocking 1): a Bot's wrapped `claude` on this Mac never holds the Anthropic API key.
 * The same design as the box's host/auth/proxy.ts: a loopback proxy in the coordinator. Each claude run gets
 * ANTHROPIC_BASE_URL = this proxy and a random token minted for that one run (revoked when the run ends); the proxy
 * checks the token, swaps it for the real key (read per request from the encrypted Mac copy) and forwards to
 * api.anthropic.com. Only the paths the CLI uses for model calls are forwarded.
 *
 * Review fixes: each token is bound to its Bot, and the usage in every /v1/messages answer (streamed message_start /
 * message_delta, or a plain JSON body) is reported (onUsage) so the host counts it against the spend view, the ladder
 * and the budgets. A request body has a byte cap, and incoming requests and upstream answers have timeouts.
 *
 * What a Bot can and can't do: during its own run, anything in that run can use the token (so it can spend on the
 * key, like the Bot's claude does); it can never obtain the key itself, and the token is dead once the run ends.
 */
export const MAC_PROXY_TOKEN_PREFIX = "sk-ant-api03-macproxy-";
/** The model-call paths Claude Code uses (query strings like ?beta=true allowed). Everything else is refused. */
const ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/v1/messages" },
  { method: "POST", path: "/v1/messages/count_tokens" },
];
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "x-api-key", "authorization", "accept-encoding"]);
/** Re-review fix C: how long a budget answer from the host stands before a /v1/messages request asks again. */
const ALLOW_TTL_MS = 30_000;
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message }, request_id: null });
/** The Messages API's own request size limit. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** No upstream bytes for this long: the call is dead (a long extended-thinking stream still sends pings). */
const UPSTREAM_IDLE_MS = 10 * 60_000;
/** A client that doesn't finish sending its request in this long is cut off. */
const REQUEST_MS = 5 * 60_000;
/** A plain JSON answer is parsed for its usage only up to this size. */
const JSON_USAGE_MAX = 4 * 1024 * 1024;

/** recordMacUsage's usage (shared MacMeteredUsage): 1-hour cache writes and web searches are priced on the host. */
export type MacUsage = MacMeteredUsage;
export interface MacUsageReport { botId: string; model: string; usage: MacUsage }
export interface MacKeyGrant { baseUrl: string; token: string; release(): void }
export type MacKeyGrantResult = MacKeyGrant | { refused: "no-key" | "proxy-down" };
/** What the executor needs: a grant for one claude run (bound to its Bot), or why there is none. */
export interface MacKeyGrantor { grant(g: { botId: string }): Promise<MacKeyGrantResult> }

type RawUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export class MacKeyProxy implements MacKeyGrantor {
  private tokens = new Map<string, { botId: string }>();
  private allowed = new Map<string, { at: number; ok: boolean; message: string | null }>();
  private server: http.Server | null = null;
  private starting: Promise<boolean> | null = null;
  private readonly up: URL;
  private readonly agent: http.Agent;

  constructor(private o: {
    /** The real key (decrypted on demand), or null when none is saved on this Mac. */
    key(): string | null;
    /** https://api.anthropic.com; a local fake in tests. */
    upstream?: string;
    /** Tests: stands in for listen (to prove a failed start refuses runs). */
    listen?(server: http.Server): Promise<void>;
    log?(s: string): void;
    /** Each /v1/messages answer's usage, for the host (recordMacUsage). */
    onUsage?(u: MacUsageReport): void;
    /**
     * Re-review fix C: may this Bot still spend? Asked per /v1/messages request (cached ALLOW_TTL_MS). null = the host
     * couldn't be asked (refused: fail closed). Absent: no mid-run check (tests).
     */
    allow?(botId: string): Promise<{ ok: boolean; message: string | null } | null>;
    allowTtlMs?: number;
    now?(): number;
    maxBodyBytes?: number;
    upstreamTimeoutMs?: number;
    requestTimeoutMs?: number;
  }) {
    this.up = new URL(o.upstream ?? "https://api.anthropic.com");
    this.agent = this.up.protocol === "https:" ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  }

  get url(): string | null {
    const a = this.server?.address() as AddressInfo | null | undefined;
    return a ? `http://127.0.0.1:${a.port}` : null;
  }

  /** Starts once; a failed start is retried on the next grant. */
  private ensure(): Promise<boolean> {
    if (this.server) return Promise.resolve(true);
    this.starting ??= (async () => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.requestTimeout = this.o.requestTimeoutMs ?? REQUEST_MS;
      server.headersTimeout = Math.min(60_000, server.requestTimeout);
      try {
        await (this.o.listen ? this.o.listen(server) : new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
        }));
        this.server = server;
        return true;
      } catch (e) {
        this.o.log?.(`local-exec: the key proxy couldn't start (${(e as Error).message}); claude runs on this Mac are refused`);
        return false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async grant(g: { botId: string }): Promise<MacKeyGrantResult> {
    if (!this.o.key()) return { refused: "no-key" };
    if (!(await this.ensure()) || !this.url) return { refused: "proxy-down" };
    const token = MAC_PROXY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    this.tokens.set(token, { botId: g.botId });
    // The executor asked the host just now, before granting: that answer stands for the cache window.
    this.allowed.set(g.botId, { at: this.now(), ok: true, message: null });
    let done = false;
    return { baseUrl: this.url, token, release: () => { if (!done) { done = true; this.tokens.delete(token); } } };
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** Re-review fix C: the host's current budget answer for this Bot, cached for about 30 s. */
  private async mayspend(botId: string): Promise<{ ok: boolean; message: string | null }> {
    if (!this.o.allow) return { ok: true, message: null };
    const c = this.allowed.get(botId);
    if (c && this.now() - c.at < (this.o.allowTtlMs ?? ALLOW_TTL_MS)) return c;
    let a: { ok: boolean; message: string | null } | null = null;
    try { a = await this.o.allow(botId); } catch { a = null; }
    const v = a ?? { ok: false, message: "Couldn't check the spend budget with the Bots' computer, so this request wasn't sent." };
    if (a) this.allowed.set(botId, { at: this.now(), ...a });
    return v;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const deny = (status: number, type: string, message: string) => { req.resume(); if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", connection: "close" }).end(errorBody(type, message)); };
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "HEAD" && url.pathname === "/api/hello") { res.writeHead(200).end(); return; } // the CLI's reachability check
    if (!ALLOWED.some((a) => a.method === req.method && a.path === url.pathname)) { deny(404, "not_found_error", "Not found"); return; }
    const presented = String(req.headers["x-api-key"] ?? "");
    const grant = presented.startsWith(MAC_PROXY_TOKEN_PREFIX) ? this.tokens.get(presented) : undefined;
    if (!grant) { deny(401, "authentication_error", "invalid proxy token"); return; }
    const key = this.o.key();
    if (!key) { deny(401, "authentication_error", "no API key saved"); return; }
    const cap = this.o.maxBodyBytes ?? MAX_BODY_BYTES;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > cap) { deny(413, "request_too_large", "Request exceeds the maximum allowed number of bytes."); return; }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    headers["x-api-key"] = key;
    // Re-review fix A: every answer must be readable for its usage, so upstream is asked for no compression.
    headers["accept-encoding"] = "identity";
    // Bug 280: never a Claude login's beta upstream (the CLI adds it only when signed in with one).
    const betas = withoutLoginBetas(req.headers["anthropic-beta"]);
    if (betas) headers["anthropic-beta"] = betas; else delete headers["anthropic-beta"];
    const target = new URL(`${url.pathname}${url.search}`, this.up);
    const lib = target.protocol === "https:" ? https : http;
    const metered = url.pathname === "/v1/messages";
    // The body is held until it is known to be under the cap (a chunked body has no length up front), then sent.
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > cap) { over = true; chunks.length = 0; deny(413, "request_too_large", "Request exceeds the maximum allowed number of bytes."); return; }
      chunks.push(c);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => void (async () => {
      if (over) return;
      if (metered) {
        const may = await this.mayspend(grant.botId);
        if (!may.ok) { deny(429, "rate_limit_error", may.message ?? "The spend budget is reached."); return; }
      }
      const body = Buffer.concat(chunks);
      headers["content-length"] = String(body.length);
      const upReq = lib.request(target, { method: req.method, headers, agent: this.agent }, (upRes) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
        if (upRes.headers["content-length"]) out["content-length"] = upRes.headers["content-length"];
        res.writeHead(upRes.statusCode ?? 502, out);
        res.flushHeaders();
        if (metered && (upRes.statusCode ?? 0) < 300 && !upRes.headers["content-encoding"]) this.meter(grant.botId, upRes);
        upRes.pipe(res);
      });
      upReq.setTimeout(this.o.upstreamTimeoutMs ?? UPSTREAM_IDLE_MS, () => upReq.destroy(new Error("upstream timeout")));
      upReq.on("error", (e) => {
        if (res.headersSent) { res.destroy(); return; }
        const timeout = e.message === "upstream timeout";
        res.writeHead(timeout ? 504 : 502, { "content-type": "application/json" }).end(errorBody(timeout ? "timeout_error" : "api_error", timeout ? "Anthropic didn't answer in time." : "The key proxy couldn't reach Anthropic."));
      });
      res.on("close", () => { if (!res.writableFinished) upReq.destroy(); });
      upReq.end(body);
    })());
  }

  /** The usage of one /v1/messages answer, read as it passes (no buffering of a stream), reported when it ends. */
  private meter(botId: string, s: http.IncomingMessage): void {
    const u: MacUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let model = "";
    let seen = false;
    const take = (raw: RawUsage | undefined, delta = false) => {
      if (!raw) return;
      seen = true;
      // Bug 280: message_delta's usage is the message's cumulative count, input included (a server tool's fetches
      // raise input_tokens after message_start; recorded in 0020): a field it carries replaces message_start's.
      const field = (k: "input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", was: number) =>
        !delta ? num(raw[k]) : typeof raw[k] === "number" ? Math.max(was, num(raw[k])) : was;
      u.inputTokens = field("input_tokens", u.inputTokens);
      u.cacheReadTokens = field("cache_read_input_tokens", u.cacheReadTokens);
      u.cacheWriteTokens = field("cache_creation_input_tokens", u.cacheWriteTokens);
      // message_delta's output_tokens is the running total for the message.
      u.outputTokens = Math.max(u.outputTokens, num(raw.output_tokens));
      // P5: the 1-hour share of the cache writes (2x input, not 1.25x) and web searches ($10 / 1,000), for list pricing.
      // Kept off the report when zero. Running totals too, so the largest value wins.
      const h1 = num(raw.cache_creation?.ephemeral_1h_input_tokens);
      if (h1 > (u.cacheWrite1hTokens ?? 0)) u.cacheWrite1hTokens = h1;
      const ws = num(raw.server_tool_use?.web_search_requests);
      if (ws > (u.webSearchRequests ?? 0)) u.webSearchRequests = ws;
    };
    const sse = String(s.headers["content-type"] ?? "").startsWith("text/event-stream");
    const dec = new StringDecoder("utf8");
    let tail = "";
    let json = "";
    s.on("data", (c: Buffer) => {
      const text = dec.write(c);
      if (!sse) { if (json.length < JSON_USAGE_MAX) json += text; return; }
      const lines = (tail + text).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || !line.includes("usage")) continue;
        try {
          const j = JSON.parse(line.slice(6)) as { type?: string; message?: { model?: string; usage?: RawUsage }; usage?: RawUsage };
          if (j.type === "message_start") { model = j.message?.model ?? model; take(j.message?.usage); } else if (j.type === "message_delta") take(j.usage, true);
        } catch { /* not a whole event */ }
      }
    });
    // Re-review fix B: reported exactly once, when the answer ends or is cut off (an aborted stream still spent what
    // message_start said).
    let reported = false;
    const done = () => {
      if (reported) return;
      reported = true;
      if (!sse) {
        try {
          const j = JSON.parse(json) as { model?: string; usage?: RawUsage };
          model = j.model ?? model;
          take(j.usage);
        } catch { /* not JSON, or cut off */ }
      }
      if (seen) {
        try { this.o.onUsage?.({ botId, model: model || "unknown", usage: u }); } catch (e) { this.o.log?.(`local-exec: usage report failed (${(e as Error).message})`); }
      }
    };
    s.on("end", done);
    s.on("aborted", done);
    s.on("close", done);
    s.on("error", done);
  }

  async stop(): Promise<void> {
    this.tokens.clear();
    this.allowed.clear();
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
