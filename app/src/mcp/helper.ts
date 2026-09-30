import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_LIMITS, MCP_OPEN_SYNAPSE, type McpBotView, type McpTaskResultView, type McpTaskView, type McpToolName } from "@synapse/shared";
import { proofFor } from "../main/mcp/store";

/**
 * 0.1.4 — the stdio MCP helper an MCP client (Claude Desktop, Claude Code, Cursor …) launches.
 * docs/superpowers/specs/2026-09-29-synapse-mcp-design.md.
 *
 * It holds no power of its own: every tool goes over Synapse's private Unix socket, where the app checks this
 * process's uid, this client's token (an HMAC over the connection's nonce), its limits, and audits the call. The tool
 * list is static, so `initialize` and `tools/list` never wait on Synapse; the socket is dialled after `initialized`.
 */

const TOOLS = [
  { name: "list_bots", description: "List the Synapse Bots you can ask.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "ask_bot", description: "Ask a Synapse Bot something and wait for its reply. Actions that need the owner's OK wait for it in Synapse.",
    inputSchema: { type: "object", properties: { bot: { type: "string", description: "The Bot's name or id." }, message: { type: "string", maxLength: MCP_LIMITS.messageMaxChars } }, required: ["bot", "message"], additionalProperties: false },
  },
  {
    name: "start_task", description: "Give a Synapse Bot a task to work on. Returns a task id for task_status and task_result.",
    inputSchema: { type: "object", properties: { bot: { type: "string", description: "The Bot's name or id." }, task: { type: "string", maxLength: MCP_LIMITS.messageMaxChars } }, required: ["bot", "task"], additionalProperties: false },
  },
  { name: "task_status", description: "Check a task started with start_task or ask_bot.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "task_result", description: "Get a task's reply.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
] as const;

/** The socket's folder must be this user's own private folder, or the helper won't talk to what's in it. */
export function checkPrivate(socketPath: string, uid = process.getuid?.() ?? -1): string | null {
  try {
    const dir = fs.lstatSync(path.dirname(socketPath));
    if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return "Synapse's MCP folder isn't private, so the helper won't use it.";
    const s = fs.lstatSync(socketPath);
    if (!s.isSocket() || s.uid !== uid) return "Synapse's MCP socket isn't this user's, so the helper won't use it.";
    return null;
  } catch {
    return MCP_OPEN_SYNAPSE;
  }
}

export interface LinkOpts { socketPath: string; key: () => string; name: () => string; version: () => string }
type Frame = Record<string, unknown>;

/** One authenticated connection to Synapse, made on first use and again after it drops. */
export class SynapseLink {
  private sock: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private waits = new Map<number, { sock: net.Socket; resolve: (f: Frame) => void; reject: (e: Error) => void }>();

  constructor(private o: LinkOpts) {}

  private tokenFile(): string { return path.join(path.dirname(this.o.socketPath), "tokens", `${this.o.key()}.token`); }

  private readToken(): string | null {
    try {
      const f = this.tokenFile();
      const st = fs.lstatSync(f);
      if (!st.isFile() || st.uid !== (process.getuid?.() ?? -1) || (st.mode & 0o077) !== 0) return null;
      return fs.readFileSync(f, "utf8").trim() || null;
    } catch { return null; }
  }

  private saveToken(token: string): void {
    const f = this.tokenFile();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(f), 0o700);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const bad = checkPrivate(this.o.socketPath);
      if (bad) return reject(new Error(bad));
      const sock = net.connect(this.o.socketPath);
      this.sock = sock;
      let buf = "";
      let settled = false;
      /** Why Synapse turned this connection away (revoked, denied, off …): what a call in flight reports. */
      let refusal: string | null = null;
      // Only this connection's own calls fail with it: a late close of an old socket never touches a newer one.
      const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } this.drop(sock, e); };
      sock.on("error", () => fail(new Error(refusal ?? MCP_OPEN_SYNAPSE)));
      sock.on("close", () => fail(new Error(refusal ?? MCP_OPEN_SYNAPSE)));
      sock.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let f: Frame;
          try { f = JSON.parse(line) as Frame; } catch { continue; }
          if (f.t === "hello" && typeof f.nonce === "string") {
            const token = this.readToken();
            this.write({ t: "auth", key: this.o.key(), name: this.o.name(), version: this.o.version(), proof: token ? proofFor(token, f.nonce, this.o.key()) : null });
          } else if (f.t === "approved" && typeof f.token === "string") {
            try { this.saveToken(f.token); } catch { /* works for this session; asks again next time */ }
            if (!settled) { settled = true; resolve(); }
          } else if (f.t === "ready") {
            if (!settled) { settled = true; resolve(); }
          } else if (f.t === "refused") {
            refusal = typeof f.message === "string" ? f.message.slice(0, 300) : "Synapse refused the connection.";
            fail(new Error(refusal));
          } else if (f.t === "result" && typeof f.id === "number") {
            this.waits.get(f.id)?.resolve(f);
            this.waits.delete(f.id);
          }
          // "pending": the owner hasn't answered the card yet; keep waiting.
        }
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private write(f: Frame): void { this.sock?.write(`${JSON.stringify(f)}\n`); }

  private drop(sock: net.Socket, e: Error): void {
    sock.destroy();
    if (this.sock === sock) { this.sock = null; this.ready = null; }
    for (const [id, w] of this.waits) if (w.sock === sock) { this.waits.delete(id); w.reject(e); }
  }

  async call(tool: McpToolName, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const id = ++this.seq;
    const sock = this.sock;
    if (!sock) throw new Error(MCP_OPEN_SYNAPSE);
    const f = await new Promise<Frame>((resolve, reject) => {
      this.waits.set(id, { sock, resolve, reject });
      this.write({ t: "call", id, tool, args });
    });
    if (f.ok !== true) throw new Error(String((f.error as { message?: unknown } | undefined)?.message ?? "Synapse couldn't do that."));
    return f.result;
  }

  close(): void { if (this.sock) this.drop(this.sock, new Error("closed")); }
}

const STATUS: Record<string, string> = {
  queued: "is queued", running: "is working on it", waiting: "is waiting for the owner's OK in Synapse", done: "finished", failed: "couldn't finish", stopped: "was stopped",
};

/** What the MCP client sees: the Bot's own words when there are some, otherwise one plain line with the task id. */
export function formatResult(tool: McpToolName, r: unknown): string {
  if (tool === "list_bots") {
    const { bots: list } = r as { bots: McpBotView[] };
    return list.length ? list.map((b) => `${b.name} (id ${b.id})${b.description ? ` — ${b.description}` : ""}`).join("\n") : "No Bots yet.";
  }
  const t = r as McpTaskResultView & McpTaskView;
  const line = `${t.bot.name} ${STATUS[t.status] ?? t.status}. Task id: ${t.id}`;
  if (tool === "start_task") return `Started. ${line}`;
  if (tool === "task_status") return line;
  if (typeof t.reply === "string" && t.reply) return t.reply;
  if (t.status === "done") return `${t.bot.name} didn't reply. Task id: ${t.id}`;
  return tool === "ask_bot" ? `${line}. Check back with task_result.` : line;
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const i = argv.indexOf("--client");
  const clientArg = i >= 0 ? argv[i + 1] : undefined;
  const socketPath = env.SYNAPSE_MCP_SOCKET || path.join(os.homedir(), "Library", "Application Support", "Synapse", "mcp", "mcp.sock");
  const server = new Server({ name: "synapse", version: "1.0.0" }, { capabilities: { tools: {} } });
  const info = () => server.getClientVersion();
  const key = () => (clientArg || info()?.name || "mcp-client").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "mcp-client";
  const link = new SynapseLink({ socketPath, key, name: () => info()?.name ?? key(), version: () => info()?.version ?? "" });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = req.params.name as McpToolName;
    if (!TOOLS.some((t) => t.name === tool)) return { content: [{ type: "text", text: `Unknown tool ${String(tool).slice(0, 40)}.` }], isError: true };
    try {
      const r = await link.call(tool, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: formatResult(tool, r) }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });
  // Dial Synapse as soon as the client says who it is, so a first-time card shows while the user is still typing.
  server.oninitialized = () => { void link.connect().catch(() => {}); };
  server.onclose = () => { link.close(); process.exit(0); };
  await server.connect(new StdioServerTransport());
}

