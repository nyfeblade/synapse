import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { withoutLoginBetas } from "@synapse/shared";
import { log } from "../util/log";
import { ttft } from "../util/ttft-trace";

/**
 * The auth proxy (bug 117). A Claude process never holds a real credential: it gets ANTHROPIC_BASE_URL pointing
 * here and a random proxy token minted for that one spawn (auth-env.ts). This checks the token, strips it, adds
 * the real API key (x-api-key) and streams to api.anthropic.com. The body
 * and every other header (anthropic-beta, anthropic-version…) pass through untouched, both ways, with no
 * buffering: SSE bytes reach the CLI as they arrive, and the prompt cache sees the very request the CLI built.
 *
 * Listens on 127.0.0.1 only; on the box an nftables rule (box/files/bots-auth-proxy.nft) also limits the port to
 * bothost, box and the Bot uids. Grants live in this object's memory: a restart of the listener keeps them, a
 * host restart drops them (the boot sweep has already reaped every Claude process that held one).
 */
/** Bug 296: set on the proxy's own 429 when the spend budget refused the call (never on Anthropic's). */
export const BUDGET_HEADER = "x-synapse-budget";
export interface ProxyUsage { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
/**
 * What a CLI reports for its own run, to reconcile with what went through the proxy. Review round 3 re-review (P2):
 * web searches too, since the SDK's total_cost_usd (what usage.db records for the run) already includes them.
 */
export type ReportedTokens = Pick<ProxyUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> & { webSearchRequests: number };
export interface ProxyGrant { botId: string | null; issuedAt: number; lastUsedAt: number; used: ProxyUsage & { cacheWrite1hTokens: number; webSearchRequests: number }; model: string | null }

/**
 * Review round 2 (P2): the model-call paths Claude Code uses (a query string like ?beta=true is allowed), as on the Mac
 * key proxy. Everything else under /v1 (files, batches, skills, agents, models…) is refused and never forwarded, so a
 * run's token can't reach an unmetered endpoint.
 */
const ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/v1/messages" },
  { method: "POST", path: "/v1/messages/count_tokens" },
];
/** An upstream silent this long is cut (504), as on the Mac key proxy: the CLI then retries. */
const UPSTREAM_IDLE_MS = 10 * 60_000;
const JSON_USAGE_MAX = 4 * 1024 * 1024;
const zeroUse = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, webSearchRequests: 0 });

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"]);
const PREFIX = "sk-ant-api03-synproxy-";
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message }, request_id: null });

export class AuthProxy {
  private grants = new Map<string, ProxyGrant>();
  /**
   * Review round 3 (P2): grants a key reset ended (revokeAll): no longer usable, still reconciled when their process
   * ends. Re-review: one whose process never releases it is dropped after the idle TTL, and the map is bounded (oldest
   * first); a dropped one records its web searches as a grant with no report does.
   */
  private retired = new Map<string, ProxyGrant & { retiredAt: number }>();
  private use = new Map<string, ProxyUsage>();
  private server: http.Server | null = null;
  private port: number;
  private stopping = false;
  private readonly agent: http.Agent;
  private readonly up: URL;

  constructor(private o: {
    /** https://api.anthropic.com in production; a local fake Messages API in tests. */
    upstream: string;
    /**
     * The live API key, read per request (a replaced key applies at once), or null. 0.1.7: the key the grant's Bot pays
     * with (its chosen Anthropic key, else the default; app.ts), on both engines, so the right key is used per Bot.
     */
    credential(botId?: string | null): string | null;
    /** 0.1.7: the status of each Messages answer, for the paying key's health. */
    onStatus?(botId: string | null, status: number): void;
    port: number;
    now?: () => number;
    /** A grant nobody used for this long is dead (revocation at process end is the main path). */
    idleTtlMs?: number;
    /** At most this many retired grants are kept (the oldest is settled and dropped first). */
    retiredMax?: number;
    /** A short-lived process's own proxy (evals, the conformance CLI): don't keep the process alive. */
    unref?: boolean;
    /**
     * Review round 2 (P2): asked before every forwarded model call, as the Mac key proxy asks the host: anything but ok
     * is answered 429 with the budget's message and not forwarded.
     */
    allow?(botId: string | null): { ok: boolean; message: string | null };
    /**
     * Review round 2 (P2): tokens that went through a grant but that its CLI never reported (a Bot's own call with the
     * run's token, a turn cut off before its result), reported once when the grant is released, for usage.db.
     */
    onUnreported?(botId: string | null, model: string, u: ReportedTokens & { cacheWrite1hTokens: number; webSearchRequests: number }): void;
    upstreamTimeoutMs?: number;
  }) {
    this.port = o.port;
    this.up = new URL(o.upstream);
    this.agent = this.up.protocol === "https:" ? new https.Agent({ keepAlive: true, maxSockets: 64 }) : new http.Agent({ keepAlive: true, maxSockets: 64 });
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }
  private now(): number { return (this.o.now ?? Date.now)(); }

  issue(g: { botId: string | null }): string {
    this.sweepRetired();
    const token = PREFIX + randomBytes(32).toString("base64url");
    const t = this.now();
    this.grants.set(token, { botId: g.botId, issuedAt: t, lastUsedAt: t, used: zeroUse(), model: null });
    return token;
  }

  /**
   * The grant ends. `reported`: what the CLI that held it reported for its runs (meteredQuery); whatever went through
   * the proxy beyond that is handed to onUnreported. Without `reported` (a process that never reports) nothing is.
   */
  revoke(token: string, reported?: ReportedTokens): void {
    const g = this.grants.get(token) ?? this.retired.get(token);
    this.grants.delete(token);
    this.retired.delete(token);
    if (g) this.settle(g, reported);
  }

  /**
   * Hands onUnreported what went through a grant beyond its CLI's report. With a report, every field (web searches
   * included) is the proxy's count minus the report. With none (a process that never reports, a retired grant nobody
   * released), tokens are not guessed at, but web searches are always recorded: nothing else counts them.
   */
  private settle(g: ProxyGrant, reported?: ReportedTokens): void {
    if (!this.o.onUnreported) return;
    const over = (k: keyof ReportedTokens) => Math.max(0, g.used[k] - (reported ? reported[k] ?? 0 : g.used[k]));
    const extra = { inputTokens: over("inputTokens"), outputTokens: over("outputTokens"), cacheReadTokens: over("cacheReadTokens"), cacheWriteTokens: over("cacheWriteTokens") };
    const webSearchRequests = Math.max(0, g.used.webSearchRequests - (reported?.webSearchRequests ?? 0));
    if (!Object.values(extra).some((n) => n > 0) && webSearchRequests <= 0) return;
    const w = g.used.cacheWriteTokens ? Math.min(1, extra.cacheWriteTokens / g.used.cacheWriteTokens) : 0;
    try {
      this.o.onUnreported(g.botId, g.model ?? "unknown", { ...extra, cacheWrite1hTokens: Math.round(g.used.cacheWrite1hTokens * w), webSearchRequests });
    } catch (e) { log.warn("auth proxy: unreported usage could not be recorded", { error: String(e) }); }
  }

  /** Every grant (a sign-in reset). */
  revokeAll(): void {
    const t0 = this.now();
    for (const [t, g] of this.grants) this.retired.set(t, { ...g, retiredAt: t0 });
    this.grants.clear();
    this.sweepRetired();
  }

  /** Review round 3 re-review (P2): retired grants past the idle TTL, and any beyond the bound, are settled and dropped. */
  private sweepRetired(): void {
    const ttl = this.o.idleTtlMs ?? 7 * 24 * 3600_000;
    const t = this.now();
    for (const [tok, g] of this.retired) if (t - Math.max(g.retiredAt, g.lastUsedAt) > ttl) { this.retired.delete(tok); this.settle(g); }
    const max = this.o.retiredMax ?? 1000;
    for (const [tok, g] of this.retired) {
      if (this.retired.size <= max) break;
      this.retired.delete(tok); // Map order is insertion order: the oldest first
      this.settle(g);
    }
  }
  /** Tests: how many retired grants are still held. */
  get retiredCount(): number { return this.retired.size; }

  usage(botId: string | null): ProxyUsage {
    return { ...(this.use.get(botId ?? "") ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
  }

  private grantFor(req: http.IncomingMessage): ProxyGrant | null {
    const presented = String(req.headers["x-api-key"] ?? "");
    if (!presented.includes("-synproxy-")) return null;
    const g = this.grants.get(presented); // 256 random bits per token: nothing to learn from lookup timing
    if (!g) return null;
    if (this.now() - g.lastUsedAt > (this.o.idleTtlMs ?? 7 * 24 * 3600_000)) { this.grants.delete(presented); return null; }
    g.lastUsedAt = this.now();
    return g;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "HEAD" && url.startsWith("/api/hello")) { res.writeHead(200).end(); return; } // the CLI's reachability check
    const deny = (status: number, type: string, message: string, extra: http.OutgoingHttpHeaders = {}) => { req.resume(); res.writeHead(status, { "content-type": "application/json", ...extra }).end(errorBody(type, message)); };
    const pathname = url.split("?")[0];
    if (!ALLOWED.some((a) => a.method === req.method && a.path === pathname)) { deny(404, "not_found_error", "Not found"); return; }
    const g = this.grantFor(req);
    if (!g) { deny(401, "authentication_error", "invalid proxy token"); return; }
    const cred = this.o.credential(g.botId);
    if (!cred) { deny(401, "authentication_error", "no API key saved"); return; }
    const isMessages = pathname === "/v1/messages";
    if (isMessages && this.o.allow) {
      let a: { ok: boolean; message: string | null };
      try { a = this.o.allow(g.botId); } catch { a = { ok: false, message: null }; }
      // Bug 296: marked, so a caller that knows (the key check) tells the budget from Anthropic's own rate limit.
      if (!a.ok) { deny(429, "rate_limit_error", a.message ?? "The spend budget is reached.", { [BUDGET_HEADER]: "over" }); return; }
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== "x-api-key" && k !== "authorization" && v !== undefined) headers[k] = v;
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    headers["x-api-key"] = cred;
    headers["accept-encoding"] = "identity"; // every answer readable, so every answer is metered
    // Bug 280: never a Claude login's beta upstream (the CLI adds it only when signed in with one).
    const betas = withoutLoginBetas(req.headers["anthropic-beta"]);
    if (betas) headers["anthropic-beta"] = betas; else delete headers["anthropic-beta"];

    const target = new URL(url, this.up);
    const lib = target.protocol === "https:" ? https : http;
    ttft.mark(g.botId, "proxy: request forwarded upstream");
    const upReq = lib.request(target, { method: req.method, headers, agent: this.agent }, (upRes) => {
      ttft.mark(g.botId, "proxy: upstream response headers");
      if (isMessages && this.o.onStatus) { try { this.o.onStatus(g.botId, upRes.statusCode ?? 502); } catch { /* health is advisory */ } }
      if (ttft.enabled) upRes.once("data", () => ttft.mark(g.botId, "proxy: upstream first body byte"));
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
      if (upRes.headers["content-length"]) out["content-length"] = upRes.headers["content-length"];
      res.writeHead(upRes.statusCode ?? 502, out);
      res.flushHeaders();
      if (isMessages && (upRes.statusCode ?? 0) < 300 && !upRes.headers["content-encoding"]) this.meter(g, upRes, String(upRes.headers["content-type"] ?? "").startsWith("text/event-stream"));
      // An upstream that drops the stream partway drops ours too (pipe alone would leave the caller waiting).
      upRes.on("aborted", () => res.destroy());
      upRes.on("error", (e) => res.destroy(e));
      upRes.pipe(res);
    });
    upReq.setNoDelay(true);
    upReq.setTimeout(this.o.upstreamTimeoutMs ?? UPSTREAM_IDLE_MS, () => upReq.destroy(new Error("upstream timeout")));
    upReq.on("error", (e) => {
      if (res.headersSent) { res.destroy(e); return; }
      const timeout = /upstream timeout/.test(String(e));
      res.writeHead(timeout ? 504 : 502, { "content-type": "application/json" }).end(errorBody(timeout ? "timeout_error" : "api_error", timeout ? "Anthropic didn't answer in time." : "The auth proxy couldn't reach Anthropic."));
    });
    res.on("close", () => { if (!res.writableFinished) upReq.destroy(); }); // the CLI went away: stop the upstream call
    req.pipe(upReq);
  }

  /**
   * Per-Bot and per-grant usage from each answer as it passes (no buffering of what the CLI reads): message_start /
   * message_delta on a stream, the `usage` of a JSON answer (review round 2, P2: a non-streamed call is metered too).
   */
  private meter(g: ProxyGrant, s: http.IncomingMessage, sse: boolean): void {
    const k = g.botId ?? "";
    const u = this.use.get(k) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.use.set(k, u);
    u.requests++;
    g.used.requests++;
    type Raw = Record<string, unknown> & { cache_creation?: { ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const has = (m: Raw, k: string) => typeof m[k] === "number";
    // Bug 280: this message's count so far. message_start opens it; each message_delta's usage is the message's
    // cumulative count (a server tool's fetches raise input_tokens after message_start; recorded in 0020), so a field
    // it carries replaces the running value and only the difference is added. A stream's message_start output count
    // is a placeholder, so output is taken from message_delta (or a JSON answer) only.
    const cur = { input: 0, read: 0, write: 0, write1h: 0, out: 0, ws: 0 };
    const set = (next: typeof cur) => {
      const d = { input: next.input - cur.input, read: next.read - cur.read, write: next.write - cur.write, out: next.out - cur.out, write1h: next.write1h - cur.write1h, ws: next.ws - cur.ws };
      Object.assign(cur, next);
      u.inputTokens += d.input; u.cacheReadTokens += d.read; u.cacheWriteTokens += d.write; u.outputTokens += d.out;
      g.used.inputTokens += d.input; g.used.cacheReadTokens += d.read; g.used.cacheWriteTokens += d.write; g.used.outputTokens += d.out;
      g.used.cacheWrite1hTokens += d.write1h; g.used.webSearchRequests += d.ws;
    };
    const add = (m: Raw, start: boolean, withOutput: boolean) => {
      // Counts only grow within a message: a smaller value (a malformed event) never takes spend back.
      const pick = (k: string, was: number) => (start || has(m, k) ? Math.max(start ? 0 : was, n(m[k])) : was);
      set({
        input: pick("input_tokens", cur.input), read: pick("cache_read_input_tokens", cur.read), write: pick("cache_creation_input_tokens", cur.write),
        write1h: m.cache_creation ? Math.max(start ? 0 : cur.write1h, n(m.cache_creation.ephemeral_1h_input_tokens)) : cur.write1h,
        out: withOutput ? Math.max(cur.out, n(m.output_tokens)) : cur.out,
        ws: m.server_tool_use ? Math.max(start ? 0 : cur.ws, n(m.server_tool_use.web_search_requests)) : cur.ws,
      });
    };
    const dec = new StringDecoder("utf8"); // a chunk can end inside a multi-byte character
    if (!sse) {
      let json = "";
      s.on("data", (c: Buffer) => { if (json.length < JSON_USAGE_MAX) json += dec.write(c); });
      s.on("end", () => {
        try {
          const j = JSON.parse(json + dec.end()) as { model?: string; usage?: Raw };
          if (typeof j.model === "string") g.model = j.model;
          if (j.usage) add(j.usage, true, true);
        } catch { /* not the documented body */ }
      });
      return;
    }
    let tail = "";
    s.on("data", (c: Buffer) => {
      const text = tail + dec.write(c);
      const lines = text.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || !line.includes("usage")) continue;
        try {
          const j = JSON.parse(line.slice(6)) as { type?: string; message?: { model?: string; usage?: Raw }; usage?: Raw };
          if (j.type === "message_start" && j.message?.usage) {
            if (typeof j.message.model === "string") g.model = j.message.model;
            add(j.message.usage, true, false);
          } else if (j.type === "message_delta" && j.usage) add(j.usage, false, true);
        } catch { /* not a whole event */ }
      }
    });
  }

  async start(): Promise<void> {
    this.stopping = false;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.keepAliveTimeout = 65_000;
    server.on("connection", (sock) => sock.setNoDelay(true));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    this.port = (server.address() as AddressInfo).port; // a port of 0 becomes a fixed one for every later restart
    this.server = server;
    if (this.o.unref) server.unref();
    // Supervision: a listener that dies on its own comes back on the same port (running CLIs retry meanwhile).
    server.on("close", () => {
      if (this.stopping || this.server !== server) return;
      this.server = null;
      log.warn("auth proxy listener closed; restarting", { port: this.port });
      const retry = (n: number) => void this.start().catch((e) => { log.error("auth proxy restart failed", { error: String(e), attempt: n }); if (n < 20) setTimeout(() => retry(n + 1), Math.min(5000, 100 * 2 ** n)).unref(); });
      setTimeout(() => retry(0), 100).unref();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  /** Tests: the listener dies without stop() (what supervision is for). */
  crashForTest(): void {
    const s = this.server;
    s?.closeAllConnections();
    s?.close();
  }
}
