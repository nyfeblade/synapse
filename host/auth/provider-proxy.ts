import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { isProviderId, type ProviderId } from "@synapse/shared";
import { quirksFor } from "../brain/provider/adapters/quirks";
import { log } from "../util/log";
import { BUDGET_HEADER } from "./proxy";

/**
 * The provider proxy (spec §4, track 2.4): `/p/<provider>/…` on loopback. Whoever calls a model provider (only
 * providerFetch today; Codex's base_url later) holds a random per-call token bound to one provider, never the key. The
 * proxy checks the token, asks the spend budget, swaps the token for `Authorization: Bearer <key>` and streams to the
 * provider's FIXED upstream. Only two paths exist: `POST chat/completions` and `GET models` (the key test); everything
 * else is a 404 and never forwarded.
 *
 * What comes back is passed through with the key scrubbed out of it (an upstream that echoes the key in an error body
 * never hands it on): error and JSON bodies are buffered and redacted, a stream is redacted as it flows.
 */
type Provider = Exclude<ProviderId, "anthropic">;
export interface ProviderGrant { botId: string | null; provider: Provider; issuedAt: number; lastUsedAt: number; keyOverride?: string }

const PREFIX = "synprov-";
/**
 * The only paths forwarded: model calls, the free model list (the key test), OpenAI's Responses (web search) and
 * Gemini's native generateContent (Google Search grounding), each only for its provider. Everything else is a 404.
 */
const ROUTES: ReadonlyArray<{ method: string; path: RegExp; providers?: readonly Provider[]; model: boolean }> = [
  { method: "POST", path: /^chat\/completions$/, model: true },
  { method: "GET", path: /^models$/, model: false },
  // Ollama's own model list (it lists what's downloaded; nothing is loaded or started).
  { method: "GET", path: /^api\/tags$/, providers: ["ollama"], model: false },
  { method: "POST", path: /^responses$/, providers: ["openai"], model: true },
  { method: "POST", path: /^native\/models\/[A-Za-z0-9._-]{1,100}:generateContent$/, providers: ["gemini"], model: true },
];
const BUFFER_MAX = 16 * 1024 * 1024;
const UPSTREAM_IDLE_MS = 10 * 60_000;
const errorBody = (message: string) => JSON.stringify({ error: { message, type: "synapse_proxy" } });

/** Every run of 12+ key characters that also occurs in the key, replaced (the whole key, or a slice an upstream quoted). */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 12 || !text) return text;
  let out = text.split(secret).join("[redacted key]");
  out = out.replace(/[A-Za-z0-9_\-.:]{12,}/g, (run) => {
    if (secret.includes(run)) return "[redacted key]";
    // a run that contains a 12+ char slice of the key (e.g. "sk-proj-abc…" glued to other text)
    for (let i = 0; i + 12 <= run.length; i++) if (secret.includes(run.slice(i, i + 12))) return "[redacted key]";
    return run;
  });
  return out;
}

export class ProviderProxy {
  private grants = new Map<string, ProviderGrant>();
  private server: http.Server | null = null;
  private port: number;
  private readonly agents = { http: new http.Agent({ keepAlive: true, maxSockets: 64 }), https: new https.Agent({ keepAlive: true, maxSockets: 64 }) };

  constructor(private o: {
    /**
     * The saved key for a provider, read per request: 0.1.7, the key the grant's Bot pays with (its chosen key for the
     * provider, else the provider's default; app.ts), so the right key is used per Bot and a change applies at once.
     */
    credential(p: Provider, botId?: string | null): string | null;
    /** Asked before every chat call (the spend budget, and the paying key's monthly cap); not ok → 429 with BUDGET_HEADER, never forwarded. */
    allow?(botId: string | null, p?: Provider): { ok: boolean; message: string | null };
    /** 0.1.7: the status of each upstream answer made with a saved key (never a key test's candidate), for that key's health. */
    onStatus?(p: Provider, botId: string | null, status: number): void;
    /** Tests only: a fake upstream in place of the provider's fixed base URL. */
    upstream?(p: Provider): string | undefined;
    /** Loopback port; 0 (default) = any free one. Only host code holds a token, so no fixed port is needed. */
    port?: number;
    now?: () => number;
    idleTtlMs?: number;
    unref?: boolean;
  }) {
    this.port = o.port ?? 0;
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }
  private now(): number { return (this.o.now ?? Date.now)(); }

  /** A token for one provider. `keyOverride`: the key test's candidate key, kept in this process like a saved one. */
  issue(g: { botId: string | null; provider: Provider; keyOverride?: string }): string {
    const token = PREFIX + randomBytes(32).toString("base64url");
    const t = this.now();
    this.grants.set(token, { botId: g.botId, provider: g.provider, issuedAt: t, lastUsedAt: t, ...(g.keyOverride ? { keyOverride: g.keyOverride } : {}) });
    return token;
  }
  revoke(token: string): void { this.grants.delete(token); }
  revokeProvider(p: Provider): void { for (const [t, g] of this.grants) if (g.provider === p) this.grants.delete(t); }
  get grantCount(): number { return this.grants.size; }

  private grantFor(req: http.IncomingMessage, provider: Provider): ProviderGrant | null {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token.startsWith(PREFIX)) return null;
    const g = this.grants.get(token);
    if (!g || g.provider !== provider) return null;
    if (this.now() - g.lastUsedAt > (this.o.idleTtlMs ?? 3600_000)) { this.grants.delete(token); return null; }
    g.lastUsedAt = this.now();
    return g;
  }

  /** A saved key's answer, for its health row (advisory: it never fails a call). */
  private noteStatus(p: Provider, botId: string | null, status: number): void {
    try { this.o.onStatus?.(p, botId, status); } catch { return; }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const deny = (status: number, message: string, extra: http.OutgoingHttpHeaders = {}) => { req.resume(); res.writeHead(status, { "content-type": "application/json", ...extra }).end(errorBody(message)); };
    const [pathname, query] = (req.url ?? "/").split("?", 2) as [string, string | undefined];
    const m = /^\/p\/([a-z]+)\/(.+)$/.exec(pathname);
    const provider = m && isProviderId(m[1]) && m[1] !== "anthropic" ? (m[1] as Provider) : null;
    const rest = m?.[2] ?? "";
    const route = provider ? ROUTES.find((r) => r.method === req.method && r.path.test(rest) && (!r.providers || r.providers.includes(provider))) : undefined;
    if (!provider || !route) { deny(404, "Not found"); return; }
    const g = this.grantFor(req, provider);
    if (!g) { deny(401, "invalid proxy token"); return; }
    const q = quirksFor(provider);
    const key = q.authHeader === "bearer" ? (g.keyOverride ?? this.o.credential(provider, g.botId)) : null;
    if (q.authHeader === "bearer" && !key) { deny(401, "no key saved"); return; }
    if (route.model && this.o.allow) {
      let a: { ok: boolean; message: string | null };
      try { a = this.o.allow(g.botId, provider); } catch { a = { ok: false, message: null }; }
      if (!a.ok) { deny(429, a.message ?? "The spend budget is reached.", { [BUDGET_HEADER]: "over" }); return; }
    }
    const headers: http.OutgoingHttpHeaders = { "content-type": String(req.headers["content-type"] ?? "application/json"), accept: String(req.headers.accept ?? "*/*"), "accept-encoding": "identity", ...(q.extraHeaders ?? {}) };
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    const native = rest.startsWith("native/");
    // Gemini's native API takes the key in its own header; its base is the compat base without /openai.
    if (key && native) headers["x-goog-api-key"] = key;
    else if (key) headers.authorization = `Bearer ${key}`;
    const base = (this.o.upstream?.(provider) ?? q.baseUrl).replace(/\/+$/, "");
    const target = new URL(native ? `${base.replace(/\/openai$/, "")}/${rest.slice("native/".length)}`
      : rest.startsWith("api/") ? `${base.replace(/\/v1$/, "")}/${rest}` : `${base}/${rest}${query ? `?${query}` : ""}`);
    const isHttps = target.protocol === "https:";
    const upReq = (isHttps ? https : http).request(target, { method: req.method, headers, agent: isHttps ? this.agents.https : this.agents.http }, (upRes) => {
      const status = upRes.statusCode ?? 502;
      if (key && !g.keyOverride) this.noteStatus(provider, g.botId, status);
      const type = String(upRes.headers["content-type"] ?? "");
      const out: http.OutgoingHttpHeaders = {};
      for (const h of ["content-type", "retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-request-id"]) if (upRes.headers[h] !== undefined) out[h] = upRes.headers[h];
      if (status >= 300 || !type.startsWith("text/event-stream")) {
        // An error or a JSON answer: whole, redacted, then sent.
        const chunks: Buffer[] = [];
        let size = 0;
        upRes.on("data", (c: Buffer) => { size += c.length; if (size <= BUFFER_MAX) chunks.push(c); });
        upRes.on("end", () => {
          const body = Buffer.from(redactSecret(Buffer.concat(chunks).toString("utf8"), key));
          res.writeHead(status, { ...out, "content-length": String(body.length) }).end(body);
        });
        upRes.on("error", (e) => res.destroy(e));
        return;
      }
      res.writeHead(status, out);
      res.flushHeaders();
      // A stream: redacted as it flows, holding back only the tail a key could still be split across.
      const dec = new StringDecoder("utf8");
      let carry = "";
      const hold = key ? key.length : 0;
      upRes.on("data", (c: Buffer) => {
        const text = carry + dec.write(c);
        const cut = Math.max(0, text.length - hold);
        const safe = redactSecret(text, key);
        if (safe !== text) { carry = ""; res.write(safe); return; }
        carry = text.slice(cut);
        if (cut) res.write(text.slice(0, cut));
      });
      upRes.on("end", () => res.end(redactSecret(carry + dec.end(), key)));
      upRes.on("error", (e) => res.destroy(e));
    });
    upReq.setTimeout(UPSTREAM_IDLE_MS, () => upReq.destroy(new Error("upstream timeout")));
    upReq.on("error", (e) => {
      if (res.headersSent) { res.destroy(e); return; }
      const timeout = /upstream timeout/.test(String(e));
      res.writeHead(timeout ? 504 : 502, { "content-type": "application/json", "x-synapse-proxy": timeout ? "timeout" : "unreachable" }).end(errorBody(timeout ? "The provider didn't answer in time." : "The proxy couldn't reach the provider."));
    });
    res.on("close", () => { if (!res.writableFinished) upReq.destroy(); });
    req.pipe(upReq);
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      try { this.handle(req, res); } catch (e) { log.warn("provider proxy: request failed", { error: String(e) }); if (!res.headersSent) res.writeHead(500).end(); }
    });
    server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    if (this.o.unref) server.unref();
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.grants.clear();
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
