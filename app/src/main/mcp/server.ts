import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { MCP_LIMITS, STR_MCP, isMcpTool, type McpTaskResultView, type McpTaskView, type McpToolName } from "@synapse/shared";
import type { Call } from "../gateway-call";
import { kernelPeer, launcherOf, type PeerCred, type PeerLookup } from "./peer";
import { McpRateLimiter } from "./rate";
import type { McpAudit, McpClient, McpOutcome, McpStore } from "./store";

/** macOS sun_path is 104 bytes, NUL included. */
export const MAX_SOCKET_PATH = 103;
const AUTH_TIMEOUT_MS = 10_000;
/** Open and in-flight connections at once: a flood can't pile up peer checks. */
export const MAX_CONNECTIONS = 16;

/** A card in Synapse: an app asking to use the owner's Bots. */
export interface McpPendingView { id: string; key: string; name: string; exe: string | null; createdAt: number }

export interface McpServerDeps {
  store: McpStore;
  audit: McpAudit;
  /** The host's gateway (only the five mcp* commands are ever called). */
  call: () => Call;
  /** The kernel's answer for who connected (tests replace it). */
  peer?: PeerLookup;
  /** The executable that launched the helper (tests replace it). */
  launcher?: (pid: number) => Promise<string | null>;
  /** This app's uid: the only uid that may connect. */
  uid?: number;
  /** A card appeared or went, or a client changed. */
  onChange?(): void;
  limiter?: McpRateLimiter;
  now?(): number;
  log?(line: string): void;
}

interface Conn {
  sock: net.Socket; nonce: string; peer: PeerCred; exe: string | null; buf: string;
  state: "auth" | "pending" | "ready" | "closed"; key: string | null; name: string | null; client: McpClient | null; pendingId: string | null;
}
interface Pending extends McpPendingView { conns: Set<Conn>; timer: NodeJS.Timeout }

/** A client key: what the snippet passes (claude-desktop, claude-code, cursor) or the MCP clientInfo name, slugged. */
export function clientKey(raw: unknown): string | null {
  const k = String(raw ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
  return k || null;
}
/** The name on the card and in Settings: ours for the three known keys, otherwise what the client said (one clean line). */
export function clientName(key: string, raw: unknown): string {
  const known = STR_MCP.clients[key];
  if (known) return known;
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || key;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/**
 * 0.1.4 — Synapse's MCP socket server, in the app's main process (docs/superpowers/specs/2026-09-29-synapse-mcp-design.md).
 *
 * The only transport is a Unix socket in a 0700 folder of this user's, itself 0600; every connection's uid comes
 * from the kernel and must be this app's, or it is closed before a byte is read. There is no TCP listener. A client
 * proves its token with an HMAC over this connection's nonce; a client without one raises a card in Synapse naming it
 * and the executable that launched it, and only the owner's Allow issues a token. Five tools, audited, rate-limited;
 * nothing here can answer an approval card, read a setting, a secret or a memory.
 */
export class McpSocketServer {
  private server: net.Server | null = null;
  private conns = new Set<Conn>();
  private pendings = new Map<string, Pending>();
  private denied = new Map<string, number>();
  private limiter: McpRateLimiter;
  socketPath: string | null = null;

  constructor(private d: McpServerDeps) {
    this.limiter = d.limiter ?? new McpRateLimiter(() => this.now());
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private uid(): number { return this.d.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1); }

  get listening(): boolean { return this.server !== null; }

  /**
   * Listen on `socketPath`. Its folder must be (or is made) a real directory owned by this user — never a symlink,
   * never another user's — forced to 0700; the socket is 0600. A stale socket from a crashed run is replaced.
   */
  async start(socketPath: string): Promise<string> {
    if (this.server) return this.socketPath!;
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw Object.assign(new Error("The MCP socket's path is too long."), { code: "SOCKET_PATH" });
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== this.uid()) {
      throw Object.assign(new Error("The MCP socket's folder isn't a private folder of this user's."), { code: "UNSAFE_DIR" });
    }
    fs.chmodSync(dir, 0o700);
    try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch { /* none */ }
    const s = net.createServer({ pauseOnConnect: true }, (sock) => void this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(socketPath, () => { s.off("error", reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
    const ss = fs.lstatSync(socketPath);
    if (!ss.isSocket() || (ss.mode & 0o777) !== 0o600 || ss.uid !== this.uid()) {
      await new Promise<void>((r) => s.close(() => r()));
      throw Object.assign(new Error("The MCP socket couldn't be made private."), { code: "UNSAFE_SOCKET" });
    }
    s.on("error", (e) => this.d.log?.(`mcp: server error: ${e.message}`));
    this.server = s;
    this.socketPath = socketPath;
    return socketPath;
  }

  async stop(): Promise<void> {
    for (const p of this.pendings.values()) clearTimeout(p.timer);
    this.pendings.clear();
    for (const c of this.conns) this.close(c, { t: "refused", code: "OFF", message: "MCP access was turned off in Synapse." });
    const s = this.server;
    const sock = this.socketPath;
    this.server = null;
    this.socketPath = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    if (sock) { try { fs.unlinkSync(sock); } catch { /* already gone */ } }
    this.d.onChange?.();
  }

  pending(): McpPendingView[] {
    return [...this.pendings.values()].map(({ id, key, name, exe, createdAt }) => ({ id, key, name, exe, createdAt }));
  }

  // ---------- connections ----------

  private accepting = 0;

  private async accept(sock: net.Socket): Promise<void> {
    sock.on("error", () => {});
    if (this.conns.size + this.accepting >= MAX_CONNECTIONS) { sock.destroy(); return; }
    this.accepting++;
    let peer: PeerCred | null = null;
    try { peer = await (this.d.peer ?? kernelPeer)(sock); } catch (e) { this.d.log?.(`mcp: peer check failed: ${(e as Error).message}`); }
    this.accepting--;
    if (!peer || peer.uid !== this.uid() || !this.server) {
      this.d.audit.record({ at: this.now(), clientId: null, client: peer ? `uid ${peer.uid}` : "unknown", tool: "connect", bot: null, outcome: "refused", detail: "peer" });
      sock.destroy();
      return;
    }
    const exe = await (this.d.launcher ?? launcherOf)(peer.pid).catch(() => null);
    const c: Conn = { sock, nonce: randomBytes(32).toString("hex"), peer, exe, buf: "", state: "auth", key: null, name: null, client: null, pendingId: null };
    this.conns.add(c);
    const authTimer = setTimeout(() => { if (c.state === "auth") this.close(c, { t: "refused", code: "TIMEOUT", message: "No hello." }); }, AUTH_TIMEOUT_MS);
    sock.on("close", () => { clearTimeout(authTimer); this.gone(c); });
    sock.on("data", (d: Buffer) => this.onData(c, d));
    sock.resume();
    this.send(c, { t: "hello", v: 1, nonce: c.nonce });
  }

  private onData(c: Conn, d: Buffer): void {
    c.buf += d.toString("utf8");
    if (c.buf.length > MCP_LIMITS.frameMaxBytes && !c.buf.includes("\n")) return this.close(c, { t: "refused", code: "TOO_BIG", message: "Frame too large." });
    let i: number;
    while ((i = c.buf.indexOf("\n")) >= 0) {
      const line = c.buf.slice(0, i);
      c.buf = c.buf.slice(i + 1);
      if (line.length > MCP_LIMITS.frameMaxBytes) return this.close(c, { t: "refused", code: "TOO_BIG", message: "Frame too large." });
      let f: Record<string, unknown>;
      try { f = JSON.parse(line) as Record<string, unknown>; } catch { return this.close(c, { t: "refused", code: "BAD_FRAME", message: "Bad frame." }); }
      if (!f || typeof f !== "object") return this.close(c, { t: "refused", code: "BAD_FRAME", message: "Bad frame." });
      if (c.state === "auth" && f.t === "auth") this.auth(c, f);
      else if (c.state === "ready" && f.t === "call") void this.onCall(c, f);
      else if (c.state === "pending" && f.t === "call") this.send(c, { t: "result", id: f.id, ok: false, error: { code: "PENDING", message: `Allow ${c.name ?? "this app"} in Synapse first.` } });
      else return this.close(c, { t: "refused", code: "BAD_FRAME", message: "Unexpected frame." });
    }
  }

  private auth(c: Conn, f: Record<string, unknown>): void {
    const key = clientKey(f.key);
    if (!key) return this.close(c, { t: "refused", code: "BAD_FRAME", message: "No client name." });
    c.key = key;
    c.name = clientName(key, f.name);
    const client = this.d.store.byKey(key);
    if (client && f.proof !== null && f.proof !== undefined && this.d.store.verify(client, c.nonce, f.proof)) {
      c.state = "ready";
      c.client = client;
      this.d.store.touch(client.id, this.now());
      this.send(c, { t: "ready", client: { id: client.id, name: client.name } });
      return;
    }
    // No token, or one that doesn't prove: the owner decides, on a card naming the app and what launched it.
    const until = this.denied.get(key) ?? 0;
    if (until > this.now()) {
      this.d.audit.record({ at: this.now(), clientId: null, client: c.name, tool: "connect", bot: null, outcome: "refused", detail: "denied recently" });
      return this.close(c, { t: "refused", code: "DENIED", message: `${c.name} was denied in Synapse. Try again later.` });
    }
    let p = [...this.pendings.values()].find((x) => x.key === key && x.exe === c.exe);
    if (!p) {
      const sameKey = [...this.pendings.values()].filter((x) => x.key === key).length;
      if (sameKey >= MCP_LIMITS.pendingPerKey || this.pendings.size >= MCP_LIMITS.pendingTotal) {
        return this.close(c, { t: "refused", code: "BUSY", message: "Synapse already has apps waiting for approval. Answer those first." });
      }
      const id = randomUUID();
      const timer = setTimeout(() => this.expire(id), MCP_LIMITS.approvalWaitMs);
      timer.unref?.();
      p = { id, key, name: c.name, exe: c.exe, createdAt: this.now(), conns: new Set(), timer };
      this.pendings.set(id, p);
      this.d.onChange?.();
    }
    p.conns.add(c);
    c.state = "pending";
    c.pendingId = p.id;
    this.send(c, { t: "pending" });
  }

  /** Settings / the card: Allow. Issues the token (sealed here, sent once to the waiting helper). */
  approve(id: string): McpClient {
    const p = this.pendings.get(id);
    if (!p) throw new Error("That request is no longer waiting.");
    const { client, token } = this.d.store.approve(p.key, p.name, p.exe, this.now());
    this.drop(p);
    this.d.audit.record({ at: this.now(), clientId: client.id, client: client.name, tool: "connect", bot: null, outcome: "approved", ...(p.exe ? { detail: p.exe } : {}) });
    for (const c of p.conns) {
      if (c.state !== "pending") continue;
      c.state = "ready";
      c.client = client;
      c.pendingId = null;
      this.send(c, { t: "approved", token, client: { id: client.id, name: client.name } });
    }
    this.d.onChange?.();
    return client;
  }

  /** Settings / the card: Deny. The key can't ask again for MCP_LIMITS.denyCooldownMs. */
  deny(id: string): void {
    const p = this.pendings.get(id);
    if (!p) return;
    this.drop(p);
    this.denied.set(p.key, this.now() + MCP_LIMITS.denyCooldownMs);
    this.d.audit.record({ at: this.now(), clientId: null, client: p.name, tool: "connect", bot: null, outcome: "denied", ...(p.exe ? { detail: p.exe } : {}) });
    for (const c of p.conns) this.close(c, { t: "refused", code: "DENIED", message: `${p.name} was denied in Synapse.` });
    this.d.onChange?.();
  }

  /** Settings: Revoke. Its token stops working and its open connections close now. */
  revoke(clientId: string): boolean {
    const c = this.d.store.revoke(clientId);
    if (!c) return false;
    this.limiter.forget(clientId);
    this.d.audit.record({ at: this.now(), clientId, client: c.name, tool: "connect", bot: null, outcome: "revoked" });
    for (const x of this.conns) if (x.client?.id === clientId) this.close(x, { t: "refused", code: "REVOKED", message: `${c.name} was revoked in Synapse.` });
    this.d.onChange?.();
    return true;
  }

  private expire(id: string): void {
    const p = this.pendings.get(id);
    if (!p) return;
    this.drop(p);
    for (const c of p.conns) this.close(c, { t: "refused", code: "TIMEOUT", message: `Nobody answered in Synapse. Try again, then click Allow.` });
    this.d.onChange?.();
  }

  private drop(p: Pending): void {
    clearTimeout(p.timer);
    this.pendings.delete(p.id);
  }

  private gone(c: Conn): void {
    c.state = "closed";
    this.conns.delete(c);
    const p = c.pendingId ? this.pendings.get(c.pendingId) : undefined;
    if (p) {
      p.conns.delete(c);
      // The helper quit before anyone answered: the card goes with it.
      if (p.conns.size === 0) { this.drop(p); this.d.onChange?.(); }
    }
  }

  private send(c: Conn, f: Record<string, unknown>): void {
    if (c.state !== "closed" && c.sock.writable) c.sock.write(`${JSON.stringify(f)}\n`);
  }

  private close(c: Conn, f: Record<string, unknown>): void {
    this.send(c, f);
    c.state = "closed";
    c.sock.end();
    setTimeout(() => c.sock.destroy(), 200).unref?.();
  }

  // ---------- tools ----------

  private async onCall(c: Conn, f: Record<string, unknown>): Promise<void> {
    const id = typeof f.id === "number" || typeof f.id === "string" ? f.id : null;
    const client = c.client!;
    const tool = f.tool;
    const args = (f.args && typeof f.args === "object" ? f.args : {}) as Record<string, unknown>;
    const botAsked = str(args.bot, 200);
    const audit = (outcome: McpOutcome, bot: string | null, detail?: string) =>
      this.d.audit.record({ at: this.now(), clientId: client.id, client: client.name, tool: String(tool).slice(0, 40), bot, outcome, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    const fail = (code: string, message: string, outcome: McpOutcome = "refused") => {
      audit(outcome, botAsked, message);
      this.send(c, { t: "result", id, ok: false, error: { code, message } });
    };
    // The client may have been revoked since this connection proved itself.
    if (!this.d.store.byId(client.id)) return this.close(c, { t: "refused", code: "REVOKED", message: `${client.name} was revoked in Synapse.` });
    if (!isMcpTool(tool)) return fail("UNKNOWN_TOOL", "Synapse's MCP server has five tools: list_bots, ask_bot, start_task, task_status, task_result.");
    const wait = this.limiter.take(client.id, tool);
    if (wait !== null) return fail("LIMITED", `Too many requests from ${client.name}. Try again in ${wait} s.`, "limited");
    const ref = { clientId: client.id, clientName: client.name };
    let result: unknown;
    try {
      result = await this.run(tool, args, ref);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return fail(m.startsWith("BAD:") ? "INVALID" : "FAILED", m.replace(/^BAD:\s*/, ""), m.startsWith("BAD:") ? "refused" : "error");
    }
    const bot = (result as { bot?: { name?: string } } | null)?.bot?.name ?? botAsked;
    audit("ok", bot ?? null);
    if (c.client?.id === client.id) this.d.store.touch(client.id, this.now());
    this.send(c, { t: "result", id, ok: true, result });
  }

  private async run(tool: McpToolName, a: Record<string, unknown>, ref: { clientId: string; clientName: string }): Promise<unknown> {
    const call = this.d.call();
    const bot = () => { const b = str(a.bot, 200); if (!b?.trim()) throw new Error("BAD: Say which Bot: its name or id (list_bots)."); return b; };
    const text = (k: string) => {
      const t = a[k];
      if (typeof t !== "string" || !t.trim()) throw new Error(`BAD: ${k} is empty.`);
      if (t.length > MCP_LIMITS.messageMaxChars) throw new Error(`BAD: Keep ${k} under ${MCP_LIMITS.messageMaxChars} characters.`);
      return t;
    };
    const task = () => { const t = str(a.id, 100); if (!t) throw new Error("BAD: Which task? Pass the id start_task gave."); return t; };
    switch (tool) {
      case "list_bots": return call("mcpListBots", {} as Record<string, never>);
      case "ask_bot": return call("mcpStartTask", { ...ref, bot: bot(), text: text("message"), waitMs: MCP_LIMITS.askWaitMs }) as Promise<McpTaskResultView>;
      case "start_task": return call("mcpStartTask", { ...ref, bot: bot(), text: text("task"), waitMs: 0 }) as Promise<McpTaskResultView>;
      case "task_status": return call("mcpTaskStatus", { ...ref, taskId: task() }) as Promise<McpTaskView>;
      case "task_result": return call("mcpTaskResult", { ...ref, taskId: task() }) as Promise<McpTaskResultView>;
    }
  }
}
