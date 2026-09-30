import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_LIMITS, MCP_OPEN_SYNAPSE } from "@synapse/shared";
import type { Call } from "../../src/main/gateway-call";
import { kernelPeer } from "../../src/main/mcp/peer";
import { McpRateLimiter } from "../../src/main/mcp/rate";
import { McpSocketServer, clientKey, clientName } from "../../src/main/mcp/server";
import { McpAudit, McpStore, proofFor, type Sealer } from "../../src/main/mcp/store";
import { mcpSnippets, registerMcp } from "../../src/main/mcp/wire";
import { SynapseLink, checkPrivate, formatResult } from "../../src/mcp/helper";

/**
 * 0.1.4 — Synapse's MCP socket server: private Unix socket (0700 folder, 0600 socket, kernel peer uid), off by
 * default, clients approved once by the owner, tokens sealed and proven per connection (no replay), revocable,
 * audited, rate-limited, and only five tools. The host is a stub here; mcp-e2e.test.ts runs the real helper.
 */

/** A real sealer (AES-256-GCM, like a key file would give): the token on disk is never plaintext. */
function aesSeal(): Sealer {
  const key = randomBytes(32);
  return {
    encrypt: (s) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); const b = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    decrypt: (b) => { const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}

const dirs: string[] = [];
const servers: McpSocketServer[] = [];
const socks: net.Socket[] = [];
afterEach(async () => {
  for (const s of socks.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m-"));
  dirs.push(d);
  return d;
}

interface HostCalls { cmd: string; args: Record<string, unknown> }
function fakeHost(calls: HostCalls[]): Call {
  return (async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "mcpListBots") return { bots: [{ id: "b1", name: "Piper", description: "Research" }] };
    if (cmd === "mcpStartTask") return { id: "mcp_1", bot: { id: "b1", name: "Piper" }, status: args.waitMs ? "done" : "queued", createdAt: 1, endedAt: args.waitMs ? 2 : null, reply: args.waitMs ? "Hi from Piper" : null };
    if (cmd === "mcpTaskStatus") return { id: String(args.taskId), bot: { id: "b1", name: "Piper" }, status: "running", createdAt: 1, endedAt: null };
    if (cmd === "mcpTaskResult") return { id: String(args.taskId), bot: { id: "b1", name: "Piper" }, status: "done", createdAt: 1, endedAt: 2, reply: "Done." };
    throw new Error(`unexpected ${cmd}`);
  }) as Call;
}

function setup(o: { uid?: number; limiter?: McpRateLimiter } = {}) {
  const userData = tmp();
  const store = McpStore.in(userData, aesSeal());
  const audit = McpAudit.in(userData);
  const calls: HostCalls[] = [];
  let changes = 0;
  const server = new McpSocketServer({
    store, audit, call: () => fakeHost(calls),
    peer: async () => ({ uid: o.uid ?? process.getuid!(), pid: process.pid }), launcher: async () => "/Applications/Claude.app",
    onChange: () => changes++, limiter: o.limiter,
  });
  servers.push(server);
  const socketPath = path.join(userData, "mcp", "mcp.sock");
  return { userData, store, audit, calls, server, socketPath, changes: () => changes };
}

type Frame = Record<string, unknown>;
/** A raw protocol client: every frame the server sent, and a way to wait for one. */
function raw(socketPath: string) {
  const sock = net.connect(socketPath);
  socks.push(sock);
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  let buf = "";
  let closed = false;
  sock.on("data", (d) => {
    buf += String(d);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { frames.push(JSON.parse(buf.slice(0, i)) as Frame); buf = buf.slice(i + 1); }
    for (const w of waiters.splice(0)) w();
  });
  sock.on("close", () => { closed = true; for (const w of waiters.splice(0)) w(); });
  sock.on("error", () => {});
  const next = async (pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> => {
    const t = Date.now() + ms;
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (closed || Date.now() > t) throw new Error(`no frame (closed=${closed}); got ${JSON.stringify(frames)}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { sock, frames, next, send: (f: Frame) => sock.write(`${JSON.stringify(f)}\n`), closed: () => closed };
}

async function hello(c: ReturnType<typeof raw>): Promise<string> {
  return String((await c.next((f) => f.t === "hello")).nonce);
}

/** Connect as `key`, get the owner's Allow, and return the token and a ready connection. */
async function approved(s: ReturnType<typeof setup>, key = "claude-desktop") {
  const c = raw(s.socketPath);
  await hello(c);
  c.send({ t: "auth", key, name: "claude-ai", proof: null });
  await c.next((f) => f.t === "pending");
  const [p] = s.server.pending();
  s.server.approve(p!.id);
  const a = await c.next((f) => f.t === "approved");
  return { c, token: String(a.token), clientId: String((a.client as { id: string }).id) };
}

let seq = 0;
async function call(c: ReturnType<typeof raw>, tool: string, args: Frame = {}): Promise<Frame> {
  const id = ++seq;
  c.send({ t: "call", id, tool, args });
  return c.next((f) => f.t === "result" && f.id === id);
}

describe("the private channel", () => {
  it("listens only on a Unix socket: folder 0700 (forced), socket 0600, no TCP address", async () => {
    const s = setup();
    fs.mkdirSync(path.dirname(s.socketPath), { mode: 0o755 });
    fs.chmodSync(path.dirname(s.socketPath), 0o755);
    await s.server.start(s.socketPath);
    expect(fs.statSync(path.dirname(s.socketPath)).mode & 0o777).toBe(0o700);
    const st = fs.lstatSync(s.socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(process.getuid!());
    expect(typeof (s.server as unknown as { server: net.Server }).server.address()).toBe("string");
    // The helper checks the same before it dials.
    expect(checkPrivate(s.socketPath)).toBeNull();
  });

  it("refuses a symlinked folder, another folder layout it can't trust, or a path too long for sun_path", async () => {
    const s = setup();
    const real = tmp();
    fs.symlinkSync(real, path.dirname(s.socketPath));
    await expect(s.server.start(s.socketPath)).rejects.toMatchObject({ code: "UNSAFE_DIR" });
    const t = setup();
    await expect(t.server.start(path.join(t.userData, "x".repeat(120), "mcp.sock"))).rejects.toMatchObject({ code: "SOCKET_PATH" });
  });

  it("the helper won't use a socket in a folder others can read", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    fs.chmodSync(path.dirname(s.socketPath), 0o755);
    expect(checkPrivate(s.socketPath)).toMatch(/isn't private/);
    fs.chmodSync(path.dirname(s.socketPath), 0o700);
  });

  it("the kernel's peer uid is read for real (LOCAL_PEERCRED / LOCAL_PEERPID), and a connection from another uid is closed unread", async () => {
    // Real kernel lookup against a real connection.
    const d = tmp();
    const p = path.join(d, "k.sock");
    const got = new Promise<{ uid: number; pid: number }>((resolve, reject) => {
      const srv = net.createServer({ pauseOnConnect: true }, (sk) => { kernelPeer(sk).then(resolve, reject).finally(() => { sk.destroy(); srv.close(); }); });
      srv.listen(p, () => { const c = net.connect(p); c.on("error", () => {}); socks.push(c); });
    });
    expect(await got).toEqual({ uid: process.getuid!(), pid: process.pid });

    const s = setup({ uid: process.getuid!() + 1 });
    await s.server.start(s.socketPath);
    const c = raw(s.socketPath);
    await expect(c.next((f) => f.t === "hello", 1500)).rejects.toThrow(/closed=true/);
    expect(s.audit.recent()[0]).toMatchObject({ tool: "connect", outcome: "refused", detail: "peer" });
  });
});

describe("off by default", () => {
  it("a fresh install: the switch is off, nothing listens, nothing is written, and the helper says to open Synapse", async () => {
    const userData = tmp();
    const handlers = new Map<string, (a: unknown) => unknown>();
    const wire = registerMcp({
      userData, reg: (n, f) => void handlers.set(n, f as (a: unknown) => unknown), emit: () => {}, call: () => null, log: () => {},
      launch: { command: "/Applications/Synapse.app/Contents/Resources/mcp/synapse-mcp", args: [], env: {} }, seal: aesSeal(),
    });
    await wire.resume();
    const st = await handlers.get("mcp.status")!({}) as { enabled: boolean; clients: unknown[]; pending: unknown[] };
    expect(st).toMatchObject({ enabled: false, clients: [], pending: [] });
    expect(wire.server.listening).toBe(false);
    expect(fs.readdirSync(userData)).toEqual([]);
    const link = new SynapseLink({ socketPath: path.join(userData, "mcp", "mcp.sock"), key: () => "cursor", name: () => "Cursor", version: () => "1" });
    await expect(link.call("list_bots", {})).rejects.toThrow(MCP_OPEN_SYNAPSE);

    // On, then off again: the socket is gone and the helper is back to "Open Synapse".
    expect(await handlers.get("mcp.enable")!({})).toMatchObject({ enabled: true });
    expect(fs.existsSync(path.join(userData, "mcp", "mcp.sock"))).toBe(true);
    expect(await handlers.get("mcp.disable")!({})).toMatchObject({ enabled: false });
    expect(fs.existsSync(path.join(userData, "mcp", "mcp.sock"))).toBe(false);
    await expect(link.call("list_bots", {})).rejects.toThrow(MCP_OPEN_SYNAPSE);
    // The switch survives a restart.
    await handlers.get("mcp.enable")!({});
    await wire.dispose();
    const again = registerMcp({ userData, reg: () => {}, emit: () => {}, call: () => null, log: () => {}, launch: { command: "x", args: [], env: {} }, seal: aesSeal() });
    await again.resume();
    expect(again.server.listening).toBe(true);
    await again.dispose();
  });
});

describe("approval, tokens and revoke", () => {
  it("an unapproved client gets a card naming it and what launched it, and nothing runs until Allow", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const c = raw(s.socketPath);
    await hello(c);
    c.send({ t: "auth", key: "claude-desktop", name: "claude-ai", proof: null });
    await c.next((f) => f.t === "pending");
    expect(s.server.pending()).toEqual([expect.objectContaining({ key: "claude-desktop", name: "Claude Desktop", exe: "/Applications/Claude.app" })]);
    const r = await call(c, "list_bots");
    expect(r).toMatchObject({ ok: false, error: { code: "PENDING" } });
    expect(s.calls).toEqual([]);
  });

  it("Deny closes it and the same client can't raise another card for a while", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const c = raw(s.socketPath);
    await hello(c);
    c.send({ t: "auth", key: "cursor", name: "Cursor", proof: null });
    await c.next((f) => f.t === "pending");
    s.server.deny(s.server.pending()[0]!.id);
    expect(await c.next((f) => f.t === "refused")).toMatchObject({ code: "DENIED" });
    const again = raw(s.socketPath);
    await hello(again);
    again.send({ t: "auth", key: "cursor", name: "Cursor", proof: null });
    expect(await again.next((f) => f.t === "refused")).toMatchObject({ code: "DENIED" });
    expect(s.server.pending()).toEqual([]);
    expect(s.audit.recent().map((e) => e.outcome)).toEqual(["refused", "denied"]);
  });

  it("at most one card per client and three in all; a card goes away when its helper quits", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const open = async (key: string) => { const c = raw(s.socketPath); await hello(c); c.send({ t: "auth", key, name: key, proof: null }); return c; };
    const a = await open("a"); await a.next((f) => f.t === "pending");
    await (await open("b")).next((f) => f.t === "pending");
    await (await open("c")).next((f) => f.t === "pending");
    expect(await (await open("d")).next((f) => f.t === "refused")).toMatchObject({ code: "BUSY" });
    expect(s.server.pending()).toHaveLength(3);
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.server.pending().map((p) => p.key).sort()).toEqual(["b", "c"]);
  });

  it("Allow issues a token that is stored sealed, never in plaintext; the next connection proves it and is ready at once", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { token } = await approved(s);
    const file = fs.readFileSync(path.join(s.userData, "mcp-access.json"), "utf8");
    expect(file).not.toContain(token);
    expect(fs.statSync(path.join(s.userData, "mcp-access.json")).mode & 0o777).toBe(0o600);
    const c = raw(s.socketPath);
    const nonce = await hello(c);
    c.send({ t: "auth", key: "claude-desktop", name: "claude-ai", proof: proofFor(token, nonce, "claude-desktop") });
    expect(await c.next((f) => f.t === "ready")).toMatchObject({ client: { name: "Claude Desktop" } });
    expect(s.server.pending()).toEqual([]);
  });

  it("replay: a proof captured from one connection doesn't open another (fresh nonce), and a wrong token asks the owner again", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { token } = await approved(s);
    const first = raw(s.socketPath);
    const n1 = await hello(first);
    const captured = { t: "auth", key: "claude-desktop", name: "claude-ai", proof: proofFor(token, n1, "claude-desktop") };
    first.send(captured);
    await first.next((f) => f.t === "ready");
    const second = raw(s.socketPath);
    const n2 = await hello(second);
    expect(n2).not.toBe(n1);
    second.send(captured);
    await second.next((f) => f.t === "pending");
    expect(second.frames.some((f) => f.t === "ready")).toBe(false);
    expect((await call(second, "list_bots")).error).toMatchObject({ code: "PENDING" });
    // Another key's valid token proves nothing for this key either.
    const third = raw(s.socketPath);
    const n3 = await hello(third);
    third.send({ t: "auth", key: "cursor", name: "Cursor", proof: proofFor(token, n3, "cursor") });
    await third.next((f) => f.t === "pending");
  });

  it("Revoke: its open connection closes now, its token stops working, and it's out of Settings", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { c, token, clientId } = await approved(s);
    expect((await call(c, "list_bots")).ok).toBe(true);
    expect(s.store.views().map((v) => v.id)).toEqual([clientId]);
    expect(s.server.revoke(clientId)).toBe(true);
    expect(await c.next((f) => f.t === "refused")).toMatchObject({ code: "REVOKED" });
    expect(s.store.views()).toEqual([]);
    const again = raw(s.socketPath);
    const n = await hello(again);
    again.send({ t: "auth", key: "claude-desktop", name: "claude-ai", proof: proofFor(token, n, "claude-desktop") });
    await again.next((f) => f.t === "pending");
    expect(s.audit.recent()[0]).toMatchObject({ outcome: "revoked", clientId });
  });
});

describe("tools, audit and limits", () => {
  it("routes the five tools to the host's mcp* commands with the approved client, and audits client, tool, Bot and time", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { c, clientId } = await approved(s);
    const before = Date.now();
    expect(await call(c, "list_bots")).toMatchObject({ ok: true, result: { bots: [{ name: "Piper" }] } });
    expect(await call(c, "ask_bot", { bot: "Piper", message: "hi" })).toMatchObject({ ok: true, result: { reply: "Hi from Piper" } });
    expect(await call(c, "start_task", { bot: "Piper", task: "tidy" })).toMatchObject({ ok: true, result: { status: "queued" } });
    expect(await call(c, "task_status", { id: "mcp_1" })).toMatchObject({ ok: true, result: { status: "running" } });
    expect(await call(c, "task_result", { id: "mcp_1" })).toMatchObject({ ok: true, result: { reply: "Done." } });
    const ref = { clientId, clientName: "Claude Desktop" };
    expect(s.calls).toEqual([
      { cmd: "mcpListBots", args: {} },
      { cmd: "mcpStartTask", args: { ...ref, bot: "Piper", text: "hi", waitMs: MCP_LIMITS.askWaitMs } },
      { cmd: "mcpStartTask", args: { ...ref, bot: "Piper", text: "tidy", waitMs: 0 } },
      { cmd: "mcpTaskStatus", args: { ...ref, taskId: "mcp_1" } },
      { cmd: "mcpTaskResult", args: { ...ref, taskId: "mcp_1" } },
    ]);
    const log = s.audit.recent();
    expect(log.slice(0, 5).map((e) => [e.tool, e.bot, e.outcome, e.client, e.clientId])).toEqual([
      ["task_result", "Piper", "ok", "Claude Desktop", clientId],
      ["task_status", "Piper", "ok", "Claude Desktop", clientId],
      ["start_task", "Piper", "ok", "Claude Desktop", clientId],
      ["ask_bot", "Piper", "ok", "Claude Desktop", clientId],
      ["list_bots", null, "ok", "Claude Desktop", clientId],
    ]);
    for (const e of log.slice(0, 5)) expect(e.at).toBeGreaterThanOrEqual(before);
    // The log is on disk (0600) and survives a restart.
    expect(fs.statSync(path.join(s.userData, "mcp-audit.jsonl")).mode & 0o777).toBe(0o600);
    expect(McpAudit.in(s.userData).recent()).toHaveLength(log.length);
  });

  it("anything but the five tools is refused and audited, and never reaches the host: no approvals, settings, secrets or memory", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { c } = await approved(s);
    for (const tool of ["resolveAutoReviewApproval", "resolve_approval", "getHostSettings", "setBotSecrets", "getAgentMemories", "sendPrompt", "readWorkspaceFile"]) {
      expect(await call(c, tool, { id: "x", approvalId: "a", choice: "once" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    }
    expect(s.calls).toEqual([]);
    expect(s.audit.recent()[0]).toMatchObject({ tool: "readWorkspaceFile", outcome: "refused" });
  });

  it("bad arguments are refused before the host: no Bot, empty or oversize text, no task id", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const { c } = await approved(s);
    expect((await call(c, "ask_bot", { message: "hi" })).error).toMatchObject({ code: "INVALID" });
    expect((await call(c, "ask_bot", { bot: "Piper", message: "  " })).error).toMatchObject({ code: "INVALID" });
    expect((await call(c, "start_task", { bot: "Piper", task: "x".repeat(MCP_LIMITS.messageMaxChars + 1) })).error).toMatchObject({ code: "INVALID" });
    expect((await call(c, "task_result", {})).error).toMatchObject({ code: "INVALID" });
    expect(s.calls).toEqual([]);
  });

  it("rate limits apply per client: over the limit is refused, audited as limited, and doesn't reach the host", async () => {
    const s = setup({ limiter: new McpRateLimiter(Date.now, { callsPerMinute: 3, runsPerHour: 1 }) });
    await s.server.start(s.socketPath);
    const { c } = await approved(s);
    expect((await call(c, "ask_bot", { bot: "Piper", message: "one" })).ok).toBe(true);
    expect(await call(c, "start_task", { bot: "Piper", task: "two" })).toMatchObject({ ok: false, error: { code: "LIMITED" } });
    expect((await call(c, "list_bots")).ok).toBe(true);
    expect((await call(c, "list_bots")).ok).toBe(true);
    expect(await call(c, "list_bots")).toMatchObject({ ok: false, error: { code: "LIMITED" } });
    expect(s.calls.map((x) => x.cmd)).toEqual(["mcpStartTask", "mcpListBots", "mcpListBots"]);
    expect(s.audit.recent()[0]).toMatchObject({ outcome: "limited" });
  });

  it("the limiter's windows slide: a minute later calls work again; an hour later runs do", () => {
    let t = 0;
    const l = new McpRateLimiter(() => t);
    for (let i = 0; i < MCP_LIMITS.runsPerHour; i++) { t += 61_000; expect(l.take("c", "ask_bot")).toBeNull(); }
    expect(l.take("c", "ask_bot")).toBeGreaterThan(0);
    expect(l.take("other", "ask_bot")).toBeNull();
    t += 3_600_000;
    expect(l.take("c", "start_task")).toBeNull();
    for (let i = 1; i < MCP_LIMITS.callsPerMinute; i++) expect(l.take("c", "task_status")).toBeNull();
    expect(l.take("c", "task_status")).toBe(60);
    t += 60_000;
    expect(l.take("c", "task_status")).toBeNull();
  });

  it("an oversize frame or garbage closes the connection", async () => {
    const s = setup();
    await s.server.start(s.socketPath);
    const c = raw(s.socketPath);
    await hello(c);
    c.sock.write("x".repeat(MCP_LIMITS.frameMaxBytes + 10));
    expect(await c.next((f) => f.t === "refused")).toMatchObject({ code: "TOO_BIG" });
    const d = raw(s.socketPath);
    await hello(d);
    d.sock.write("not json\n");
    expect(await d.next((f) => f.t === "refused")).toMatchObject({ code: "BAD_FRAME" });
  });
});

describe("names, snippets and replies", () => {
  it("client keys and names are one clean line; the three known clients get their own names", () => {
    expect(clientKey("Claude Code")).toBe("claude-code");
    expect(clientKey("../../etc")).toBe("etc");
    expect(clientKey("")).toBeNull();
    expect(clientName("claude-desktop", "Totally Legit")).toBe("Claude Desktop");
    expect(clientName("x", "Evil\n[TRUSTED]<b>")).toBe("Evil TRUSTED b");
  });

  it("the snippets name this install's helper and socket for each client, and quote paths with spaces", () => {
    const sock = "/Users/me/Library/Application Support/Synapse/mcp/mcp.sock";
    const sn = mcpSnippets({ command: "/Applications/Synapse.app/Contents/Resources/mcp/synapse-mcp", args: [], env: {} }, sock);
    expect(JSON.parse(sn.claudeDesktop)).toEqual({ mcpServers: { synapse: { command: "/Applications/Synapse.app/Contents/Resources/mcp/synapse-mcp", args: ["--client", "claude-desktop"], env: { SYNAPSE_MCP_SOCKET: sock } } } });
    expect(JSON.parse(sn.cursor).mcpServers.synapse.args).toEqual(["--client", "cursor"]);
    expect(sn.claudeCode).toBe(`claude mcp add synapse --scope user -e SYNAPSE_MCP_SOCKET='${sock}' -- '/Applications/Synapse.app/Contents/Resources/mcp/synapse-mcp' --client claude-code`);
  });

  it("what the MCP client reads: the Bot's own words, or one line with the task id", () => {
    const t = { id: "mcp_9", bot: { id: "b", name: "Piper" }, createdAt: 1, endedAt: null };
    expect(formatResult("ask_bot", { ...t, status: "done", reply: "Hello" })).toBe("Hello");
    expect(formatResult("ask_bot", { ...t, status: "waiting", reply: null })).toBe("Piper is waiting for the owner's OK in Synapse. Task id: mcp_9. Check back with task_result.");
    expect(formatResult("start_task", { ...t, status: "queued", reply: null })).toBe("Started. Piper is queued. Task id: mcp_9");
    expect(formatResult("list_bots", { bots: [{ id: "b", name: "Piper", description: "Research" }] })).toBe("Piper (id b) — Research");
  });
});

describe("no network port, ever", () => {
  it("the MCP code never listens on a port or opens an HTTP server", () => {
    const root = path.resolve(__dirname, "../../src");
    const files = [...fs.readdirSync(path.join(root, "main", "mcp")).map((f) => path.join(root, "main", "mcp", f)), ...fs.readdirSync(path.join(root, "mcp")).map((f) => path.join(root, "mcp", f))];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/node:(http|https|http2|dgram)"/);
      expect(src, f).not.toMatch(/\.listen\((?!socketPath)/);
      expect(src, f).not.toMatch(/net\.connect\((?!this\.o\.socketPath)/);
    }
  });
});
