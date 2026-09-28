import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { allowedHosts, checkTailnet, clearCookie, COOKIE, deviceCookie, deviceName, originAllowed, parseCookies, throttledLog, type Pairing } from "./auth";
import { pushEndpointAllowed } from "./push";
import type { PairedDevice, PhoneStore } from "./store";

/** A Bot as the phone lists it: its name and its avatar's colour and shape (nothing else leaves the Mac). */
export interface PhoneBot { id: string; name: string; color: string; shape: string }

/** One phone's call socket, as the call side sees it. */
export interface CallLink {
  readonly deviceId: string;
  send(msg: Record<string, unknown>): void;
  /** The call's audio for the phone: 16-bit little-endian 24 kHz mono. */
  audio(pcm: Buffer): void;
  close(code?: number): void;
}

export interface CallHandlers {
  call(link: CallLink, botId: string): void;
  /** The phone's microphone: 16-bit little-endian 16 kHz mono. */
  mic(link: CallLink, pcm: Buffer): void;
  mute(link: CallLink, muted: boolean): void;
  hangup(link: CallLink): void;
  closed(link: CallLink): void;
}

export interface Asset { type: string; body: Buffer | string; cache?: "no-cache" | "long" }

export interface PhoneServerDeps {
  store: PhoneStore;
  pairing: Pairing;
  /** The Mac's own Tailscale identity (cached; refreshed by the wiring). */
  identity(): { login: string | null; dnsName: string | null };
  bots(): PhoneBot[];
  asset(path: string): Asset | null;
  calls: CallHandlers;
  log?(line: string): void;
  /** Tests only: a push endpoint on the loopback (the test's own push service). */
  allowLoopbackPush?: boolean;
}

/** One phone may start a call at most once every 2 s, and 10 times a minute. */
export const CALL_RATE = { minGapMs: 2_000, perMinute: 10 } as const;

const MAX_BODY = 8 * 1024;
const MAX_MIC_FRAME = 32 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
};

function csp(host: string): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    `connect-src 'self' wss://${host}`, "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join("; ");
}

/**
 * Bug 198: the phone server. HTTP + one WebSocket on a Unix socket in the app's own 0700 folder —
 * never a TCP port another program could take over. The phone reaches it only through
 * `tailscale serve` (HTTPS with the tailnet's real certificate). Every request passes the tailnet gate (auth.ts); the API and the call socket also need
 * a paired device's cookie. Nothing secret is ever put in a URL.
 */
export class PhoneServer {
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MIC_FRAME });
  private sockets = new Map<WebSocket, { device: PairedDevice; link: CallLink }>();
  /** The Unix socket it listens on (null = not listening). There is no TCP listener at all. */
  socketPath: string | null = null;
  /** Answered at /api/probe: proves a request through serve reached THIS listener. */
  probeNonce = randomBytes(16).toString("hex");
  private refused: (why: string) => void;

  constructor(private d: PhoneServerDeps) { this.refused = throttledLog(d.log); }

  private hosts(): Set<string> { return allowedHosts(this.d.identity().dnsName); }

  private gate(req: IncomingMessage) {
    return checkTailnet(req, { login: this.d.identity().login, hosts: this.hosts(), viaSocket: this.socketPath !== null });
  }

  private origin(req: IncomingMessage): boolean {
    return originAllowed(req.headers.origin, this.hosts());
  }

  private device(req: IncomingMessage): PairedDevice | null {
    const dev = this.d.store.deviceForToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (dev) this.d.store.touch(dev.id);
    return dev;
  }

  /**
   * Listen on a Unix socket: its folder (which must already be, or be made, a real directory owned by
   * this user) is 0700 and the socket 0600, so only this user (and tailscaled, as root) can connect.
   * A stale socket from a crashed run is replaced.
   */
  startSocket(socketPath: string): Promise<string> {
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    // The folder must be a real directory of this user's — never a symlink someone planted, never
    // another user's — before anything in it is trusted or changed.
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      return Promise.reject(Object.assign(new Error("The phone socket's folder isn't a private folder of this user's."), { code: "UNSAFE_DIR" }));
    }
    fs.chmodSync(dir, 0o700);
    try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch { /* none */ }
    return new Promise((resolve, reject) => {
      const s = this.make();
      s.once("error", reject);
      s.listen(socketPath, () => {
        s.off("error", reject);
        try { fs.chmodSync(socketPath, 0o600); } catch { /* listening already */ }
        this.server = s;
        this.socketPath = socketPath;
        resolve(socketPath);
      });
    });
  }

  private make(): http.Server {
    const s = http.createServer((req, res) => void this.handle(req, res).catch((e: unknown) => {
      this.d.log?.(`phone: request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) this.json(res, 500, { error: "failed" });
    }));
    s.headersTimeout = 10_000;
    s.requestTimeout = 15_000;
    s.on("upgrade", (req, sock, head) => this.upgrade(req, sock, head));
    return s;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets.keys()) ws.terminate();
    this.sockets.clear();
    const s = this.server;
    const sock = this.socketPath;
    this.server = null;
    this.socketPath = null;
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
    if (sock) { try { fs.unlinkSync(sock); } catch { /* already gone */ } }
  }

  get listening(): boolean { return this.server !== null; }

  /** A revoked phone's open call socket closes at once. */
  closeDevice(id: string): void {
    for (const [ws, v] of this.sockets) if (v.device.id === id) ws.close(4001, "revoked");
  }

  private deny(res: ServerResponse, why: string): void {
    this.refused(why);
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
    res.end("Forbidden");
  }

  private json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra });
    res.end(JSON.stringify(body));
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let n = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { req.destroy(); resolve(null); } else parts.push(c); });
      req.on("end", () => { try { const v = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; resolve(v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null); } catch { resolve(null); } });
      req.on("error", () => resolve(null));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const g = this.gate(req);
    if (!g.ok) return this.deny(res, g.why);
    const url = new URL(req.url ?? "/", "http://phone.invalid");
    const p = url.pathname;
    const method = req.method ?? "GET";
    if (p.startsWith("/api/")) {
      // A state-changing call must come from this server's own page.
      if (method !== "GET" && !this.origin(req)) return this.deny(res, "origin");
      return this.api(req, res, method, p);
    }
    if (method !== "GET" && method !== "HEAD") return this.json(res, 405, { error: "method" });
    const a = this.d.asset(p === "/" ? "/index.html" : p);
    if (!a) return this.json(res, 404, { error: "not found" });
    const headers: Record<string, string> = {
      "Content-Type": a.type, ...SECURITY_HEADERS,
      "Cache-Control": a.cache === "long" ? "public, max-age=86400" : "no-cache",
    };
    if (a.type.startsWith("text/html")) headers["Content-Security-Policy"] = csp((req.headers.host ?? "").toLowerCase());
    if (p === "/sw.js") headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    res.end(method === "HEAD" ? undefined : a.body);
  }

  private async api(req: IncomingMessage, res: ServerResponse, method: string, p: string): Promise<void> {
    // The wiring's check that serve's mapping reaches THIS listener (not something else on the port).
    if (method === "GET" && p === "/api/probe") return this.json(res, 200, { probe: this.probeNonce });
    if (method === "GET" && p === "/api/session") {
      const dev = this.device(req);
      return this.json(res, 200, { paired: dev !== null, ...(dev ? { name: dev.name } : {}) });
    }
    if (method === "POST" && p === "/api/pair") {
      const b = await this.body(req);
      if (!b || !this.d.pairing.redeem(b.code)) return this.json(res, 403, { ok: false });
      const { device, token } = this.d.store.addDevice(deviceName(req.headers["user-agent"]));
      this.d.log?.(`phone: paired ${device.name} (${device.id.slice(0, 8)})`);
      return this.json(res, 200, { ok: true, name: device.name }, { "Set-Cookie": deviceCookie(token) });
    }
    const dev = this.device(req);
    if (!dev) return this.json(res, 401, { error: "not paired" });
    if (method === "POST" && p === "/api/unpair") {
      this.d.store.revoke(dev.id);
      this.closeDevice(dev.id);
      return this.json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
    }
    if (method === "GET" && p === "/api/bots") return this.json(res, 200, { bots: this.d.bots() });
    if (method === "GET" && p === "/api/push/key") {
      try { return this.json(res, 200, { publicKey: this.d.store.vapid().publicKey }); } catch { return this.json(res, 503, { error: "unavailable" }); }
    }
    if (method === "POST" && p === "/api/push/subscribe") {
      const b = await this.body(req);
      const keys = (b?.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
      const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
      const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
      const auth = typeof keys.auth === "string" ? keys.auth : "";
      const okKey = /^[A-Za-z0-9_-]{80,100}$/.test(p256dh) && Buffer.from(p256dh, "base64url").length === 65 && /^[A-Za-z0-9_-]{16,32}$/.test(auth);
      if (!pushEndpointAllowed(endpoint, this.d.allowLoopbackPush) || !okKey || endpoint.length > 1000) return this.json(res, 400, { ok: false });
      // Scoped to the phone asking: another phone's subscription can't be taken over.
      if (!this.d.store.addSub({ deviceId: dev.id, endpoint, p256dh, auth, createdAt: Date.now() })) return this.json(res, 409, { ok: false });
      return this.json(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/api/push/unsubscribe") {
      const b = await this.body(req);
      if (typeof b?.endpoint === "string") this.d.store.removeSub(b.endpoint, dev.id);
      return this.json(res, 200, { ok: true });
    }
    return this.json(res, 404, { error: "not found" });
  }

  private upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
    const refuse = (why: string) => {
      this.refused(`socket ${why}`);
      sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    };
    const g = this.gate(req);
    if (!g.ok) return refuse(g.why);
    if (new URL(req.url ?? "/", "http://phone.invalid").pathname !== "/ws") return refuse("path");
    if (!this.origin(req)) return refuse("origin");
    const dev = this.device(req);
    if (!dev) return refuse("not paired");
    this.wss.handleUpgrade(req, sock, head, (ws) => this.connected(ws, dev));
  }

  private connected(ws: WebSocket, device: PairedDevice): void {
    const link: CallLink = {
      deviceId: device.id,
      send: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
      audio: (pcm) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 512 * 1024) ws.send(pcm, { binary: true }); },
      close: (code) => ws.close(code ?? 1000),
    };
    this.sockets.set(ws, { device, link });
    const c = this.d.calls;
    const calls: number[] = [];
    ws.on("message", (data, binary) => {
      if (binary) {
        const b = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (b.length > 0 && b.length % 2 === 0) c.mic(link, b);
        return;
      }
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
      if (m.type === "call") {
        // Each call starts a helper on the Mac: a phone can't hammer it.
        const now = Date.now();
        while (calls.length && now - calls[0]! > 60_000) calls.shift();
        if ((calls.length && now - calls[calls.length - 1]! < CALL_RATE.minGapMs) || calls.length >= CALL_RATE.perMinute) { this.refused("call rate"); link.send({ type: "ended", reason: "busy" }); return; }
        calls.push(now);
        if (typeof m.botId === "string" && this.d.bots().some((b) => b.id === m.botId)) c.call(link, m.botId);
        else link.send({ type: "ended", reason: "unknown-bot" });
      }
      else if (m.type === "mute" && typeof m.muted === "boolean") c.mute(link, m.muted);
      else if (m.type === "hangup") c.hangup(link);
      else if (m.type === "ping") link.send({ type: "pong" });
    });
    ws.on("close", () => { this.sockets.delete(ws); c.closed(link); });
    ws.on("error", () => { /* close follows */ });
    link.send({ type: "hello", bots: this.d.bots() });
  }
}
