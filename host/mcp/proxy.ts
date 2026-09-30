import path from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS5, MCP_HEADER_REDACTED, STR5, type McpServerView } from "@synapse/shared";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { hostOutDir } from "../util/host-out";
import { writeHostOwnedFile } from "../util/host-owned-file";
import { log } from "../util/log";
import type { McpRegistry, RegistryServer } from "./registry";

export interface RemoteConnection {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
/** PLG header auth: `headers` are the server's sealed header values, resolved at connect time — the
 *  remote twin of CommandConnector's `env`. The record's own `headers` is always {}. */
export type Connector = (s: RegistryServer, headers: Record<string, string>) => Promise<RemoteConnection>;
/** Open item 1: starts a host-proxied command server with its vault env (only that process gets it). */
export type CommandConnector = (s: RegistryServer, env: Record<string, string>) => Promise<RemoteConnection>;

type Status = McpServerView["status"];
interface Entry { conn: RemoteConnection | null; tools: Tool[]; status: Status; error: string | null; connecting: Promise<Status> | null }

const isAuthError = (e: unknown) =>
  e instanceof UnauthorizedError
  || /\b401\b|unauthori[sz]ed|invalid_token|dynamic client registration|incompatible auth server/i.test(String(e));
const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], isError });

export class McpProxyPool {
  private entries = new Map<string, Entry>();
  private askedFor = new Set<string>();

  constructor(private d: { registry: McpRegistry; connect: Connector; connectCommand?: CommandConnector; workspace: string; now(): number; onAuthNeeded?(serverId: string, botId: string | null): void; onStatus?(): void }) {}

  status(serverId: string): Status { return this.entries.get(serverId)?.status ?? "unknown"; }
  error(serverId: string): string | null { return this.entries.get(serverId)?.error ?? null; }
  /** I6: the remote tool's own readOnlyHint annotation (undefined when unknown). */
  readOnlyHint(serverId: string, tool: string): boolean | undefined {
    return (this.entries.get(serverId)?.tools ?? []).find((t) => t.name === tool)?.annotations?.readOnlyHint;
  }

  toolDescriptions(serverId: string): Map<string, string> {
    return new Map((this.entries.get(serverId)?.tools ?? []).map((t) => [t.name, t.description ?? ""]));
  }

  setAuthNeededHandler(fn: (serverId: string, botId: string | null) => void): void {
    this.d.onAuthNeeded = fn;
  }

  markWaiting(serverId: string): void {
    const e = this.entry(serverId);
    e.status = "waiting-auth";
    this.d.onStatus?.();
  }

  ensure(serverId: string): Promise<Status> {
    const e = this.entry(serverId);
    if (e.conn && e.status === "connected") return Promise.resolve("connected");
    e.connecting ??= (async () => {
      const s = this.d.registry.get(serverId);
      if (!s || !this.d.registry.hostProxied(s)) return (e.status = "unknown");
      if (!s.enabled) return (e.status = "disabled");
      try {
        if (s.kind === "command" && !this.d.connectCommand) throw new Error("Local servers with keys aren't available here.");
        e.conn = s.kind === "command" ? await this.d.connectCommand!(s, this.d.registry.envFor(s.id)) : await this.d.connect(s, this.d.registry.headersFor(s.id));
        e.tools = await e.conn.listTools();
        e.status = "connected";
        e.error = null;
      } catch (err) {
        e.conn = null;
        e.tools = [];
        e.status = isAuthError(err) ? (e.status === "waiting-auth" ? "waiting-auth" : "needs-auth") : "failed";
        // Scrubbed BEFORE it is stored: e.error is published to the renderer on every status change
        // and read back into Bot-facing text, and an HTTP client that echoes the request it sent
        // (or a server that quotes the key back in its 401) would otherwise put the credential in
        // both. Truncating after the scrub, so a half-redacted value can't survive the slice.
        e.error = e.status === "failed" ? this.scrub(serverId, String((err as Error).message ?? err)).slice(0, 300) : null;
      } finally {
        e.connecting = null;
        this.d.onStatus?.();
      }
      return e.status;
    })();
    return e.connecting;
  }

  /** One fresh in-process server per Bot spawn: an McpServer instance serves exactly one transport. */
  sdkServers(botId: string): Record<string, McpSdkServerConfigWithInstance> {
    const out: Record<string, McpSdkServerConfigWithInstance> = {};
    // 4.3b: a server (one account) not granted to this Bot never enters its spawn set.
    for (const s of this.d.registry.list().filter((x) => this.d.registry.hostProxied(x) && x.enabled && this.d.registry.grantedTo(x, botId))) out[s.id] = this.serverFor(s.id, botId);
    return out;
  }

  async restart(serverId?: string): Promise<void> {
    for (const [id, e] of this.entries) {
      if (serverId && id !== serverId) continue;
      await e.conn?.close().catch(() => {});
      this.entries.delete(id);
      for (const key of this.askedFor) if (key.startsWith(`${id}:`)) this.askedFor.delete(key);
    }
    if (serverId) await this.ensure(serverId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.conn?.close().catch(() => {})));
    this.entries.clear();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { conn: null, tools: [], status: "unknown", error: null, connecting: null }));
    return e;
  }

  private authNeeded(serverId: string, botId: string): void {
    const key = `${serverId}:${botId}`;
    if (this.askedFor.has(key)) return;
    this.askedFor.add(key);
    this.d.onAuthNeeded?.(serverId, botId);
  }

  private serverFor(serverId: string, botId: string): McpSdkServerConfigWithInstance {
    const mcp = new McpServer({ name: serverId, version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Bug 58: no connect card from here. The CLI lists every server at every spawn, so a card asked
      // for at listing time reached the user on turns that never touched the server — "a PostHog auth
      // card every message". A server that needs sign-in is a quiet state in Manage plugins (Authorize,
      // Turn off); the card belongs to the moment the Bot calls it (call() below) or asks for it
      // (AuthenticateMcpServer, InstallPlugin, AddMcpServer), as PLG-05 says.
      await this.ensure(serverId);
      const off = new Set(this.d.registry.disabledTools(serverId));
      return { tools: (this.entries.get(serverId)?.tools ?? []).filter((t) => !off.has(t.name)) };
    });
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => this.call(serverId, botId, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    return { type: "sdk", name: serverId, instance: mcp as unknown as McpSdkServerConfigWithInstance["instance"] };
  }

  private async call(serverId: string, botId: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const s = this.d.registry.get(serverId);
    const name = s ? (s.label ? `${s.name} (${s.label})` : s.name) : serverId;
    // 4.3b: re-checked at call time (a grant can change while a session is warm).
    if (s && !this.d.registry.grantedTo(s, botId)) return text(`${name} isn't turned on for this Bot. The user can allow it in this Bot's settings.`, true);
    if (this.d.registry.disabledTools(serverId).includes(tool)) return text(`The user turned off ${tool} for ${name}. Don't use it.`, true);
    const status = await this.ensure(serverId);
    const e = this.entries.get(serverId);
    // Bug 54: a Bot spawned while the server was on keeps its in-process copy until the next turn
    // respawns it without one. Until then, say what is actually true — not the connect-card line,
    // which claims a card was shown and asks the Bot to wait for a sign-in nobody needs.
    if (status === "disabled") return text(`The user turned off ${name}. Don't use it.`, true);
    if (status !== "connected" || !e?.conn) {
      if (status === "needs-auth" || status === "waiting-auth") this.authNeeded(serverId, botId);
      return text(status === "failed" ? `${name} isn't reachable right now: ${e?.error ?? "unknown error"}` : STR5.connectorAuthNeeded(name), true);
    }
    try {
      const r = await e.conn.callTool(tool, args);
      return this.spill(serverId, botId, tool, r);
    } catch (err) {
      if (isAuthError(err)) {
        e.status = "needs-auth";
        e.conn = null;
        this.d.onStatus?.();
        this.authNeeded(serverId, botId);
        return text(STR5.connectorAuthNeeded(name), true);
      }
      return text(`${name} returned an error: ${this.scrub(serverId, String((err as Error).message ?? err)).slice(0, 500)}`, true);
    }
  }

  /**
   * Replace any of this server's sealed values (header credentials, command env) that appear in a
   * string with the redaction. The values never pass through here in the healthy case; this exists
   * because the strings we forward on are written by code we do not own — an SDK's request dump, a
   * server's own 401 body — and "the remote never quotes your key back" is not a promise anyone
   * can make on their behalf.
   */
  private scrub(serverId: string, message: string): string {
    let out = message;
    for (const v of this.d.registry.sealedValues(serverId)) out = out.split(v).join(MCP_HEADER_REDACTED);
    return out;
  }

  /**
   * Final secfix round 3, ruling 4: an oversized tool result is bothost writing a file into a folder
   * the Bot can see, so it goes through the same host-owned chain as screenshots and saved webhook
   * bodies — /workspace/.host-out/mcp-output, every component bothost-owned and never a symlink,
   * the file itself O_EXCL|O_NOFOLLOW and verified before a byte is written. The old spill dir,
   * /workspace/.bot/mcp-output, sat inside a box-owned 2775 directory: the Bot could rename it away,
   * put a symlink in its place, and have bothost truncate any file it pointed at (the filename is
   * fully Bot-predictable — serverId, tool name and the millisecond). When the write is refused the
   * Bot gets a bounded excerpt and no path, never a silent write somewhere else.
   */
  private spill(serverId: string, botId: string, tool: string, r: CallToolResult): CallToolResult {
    const joined = (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (Buffer.byteLength(joined) <= LIMITS5.mcpOutputSpillBytes) return r;
    // P5 review minor: slugged names, so a remote tool name can't steer the file out of the spill dir.
    const slug = (x: string, fb: string) => x.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || fb;
    const dir = path.join(hostOutDir(this.d.workspace, "mcp-output"), slug(botId, "bot")); // bug #61: per-Bot, tool-guarded
    const body = joined.slice(0, LIMITS5.mcpOutputSpillMaxChars);
    const file = writeHostOwnedFile(this.d.workspace, dir, `${slug(serverId, "server")}-${slug(tool, "tool")}-${this.d.now()}.txt`, body, 0o640);
    if (!file) {
      log.warn("mcp spill refused", { serverId, tool, dir });
      return text(`The output was too large to keep in full, and it couldn't be written to a file, so here is the first part of it:\n\n${joined.slice(0, LIMITS5.mcpOutputSpillBytes)}`, r.isError === true);
    }
    return text(`The output was large, so it was saved to ${file} (${body.length} chars). Read the parts you need from that file.`, r.isError === true);
  }
}
