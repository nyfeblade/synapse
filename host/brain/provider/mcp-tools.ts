import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BotToolDef, BotToolResult, ToolImage } from "../types";

/**
 * MCP servers for provider Bots (spec §3 v1 and P2). The Claude brain hands `phase5.mcpServers(botId)` to the CLI; a
 * provider Bot's brain runs in bothost, so it is its own MCP client here:
 * - `sdk` servers (the Bot's connectors, the host-proxied remote and keyed command servers) over an in-memory pair;
 * - `stdio` servers (keyless local command servers) spawned the way the host already spawns a keyed one: through the
 *   `bot-mcp-as-box` helper as the MCP user with a clean env file (connect.ts commandServerSpawn), never as bothost.
 * Each tool becomes a registry entry under its Claude canonical name (`mcp__<server>__<tool>`), so the approval gate,
 * the classifier, the reviewer and the outside-content fence see exactly what they see for a Claude Bot. The handler is
 * only reachable through the tool loop's gate ticket, like every other tool.
 */
export type ProviderMcpConfig =
  | { type: "sdk"; name?: string; instance: unknown }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: string; [k: string]: unknown };

export interface McpToolEntry { canonical: string; def: BotToolDef; jsonSchema: Record<string, unknown> }

interface Conn { key: unknown; client: Client; close(): Promise<void> }

export interface ProviderMcpDeps {
  servers(botId: string): Record<string, ProviderMcpConfig>;
  /** Tool names the user turned off (`mcp__<server>__<tool>`), left out of the list. */
  disallowed?(): string[];
  /** How a keyless command server is spawned (connect.ts commandServerSpawn, env {}). */
  spawn(id: string, command: string, args: string[]): { command: string; args: string[]; env: Record<string, string> };
  cwd?: string;
  log?(msg: string, fields?: Record<string, unknown>): void;
  /** Listing budget per server; a slow or broken server is skipped for this turn, never blocks it. */
  listTimeoutMs?: number;
}

const NAME = "synapse-provider-bot";
const LIST_TIMEOUT_MS = 5_000;
const IMAGE_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

/** A CallToolResult as a BotToolResult: text parts joined, images kept, anything else summarised. */
export function mcpResultToBot(r: { content?: unknown; isError?: unknown; structuredContent?: unknown }): BotToolResult {
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const c of Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : []) {
    if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
    else if (c.type === "image" && typeof c.data === "string" && IMAGE_TYPES.has(String(c.mimeType))) images.push({ data: c.data, mimeType: c.mimeType as ToolImage["mimeType"] });
    else if (c.type === "resource" && c.resource && typeof (c.resource as { text?: unknown }).text === "string") texts.push(String((c.resource as { text: string }).text));
    else if (c.type) texts.push(`[${String(c.type)} content]`);
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  return { text: texts.join("\n") || (r.isError ? "Error" : "(no output)"), ...(r.isError === true ? { isError: true } : {}), ...(images.length ? { images } : {}) };
}

export class ProviderMcpClients {
  private conns = new Map<string, Map<string, Conn>>();
  constructor(private d: ProviderMcpDeps) {}

  /** The Bot's MCP tools for this turn, in a stable order (server id, then the server's own order). */
  async tools(botId: string): Promise<McpToolEntry[]> {
    const servers = this.d.servers(botId);
    const off = new Set(this.d.disallowed?.() ?? []);
    const mine = this.conns.get(botId) ?? new Map<string, Conn>();
    this.conns.set(botId, mine);
    for (const [id, c] of mine) if (!(id in servers)) { mine.delete(id); await c.close().catch(() => {}); }
    const ids = Object.keys(servers).filter((id) => id !== "bot").sort();
    const lists = await Promise.all(ids.map(async (id) => {
      try {
        const conn = await this.connect(botId, id, servers[id]!);
        if (!conn) return [];
        const { tools } = await withTimeout(conn.client.listTools(), this.d.listTimeoutMs ?? LIST_TIMEOUT_MS, `${id} tools/list`);
        return tools.filter((t) => !off.has(`mcp__${id}__${t.name}`)).map((t): McpToolEntry => ({
          canonical: `mcp__${id}__${t.name}`,
          jsonSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          def: {
            name: `mcp__${id}__${t.name}`, description: t.description ?? t.name, schema: {}, readOnly: t.annotations?.readOnlyHint === true,
            handler: async (args) => mcpResultToBot((await conn.client.callTool({ name: t.name, arguments: args })) as { content?: unknown; isError?: unknown; structuredContent?: unknown }),
          },
        }));
      } catch (e) {
        this.d.log?.("provider mcp: server skipped this turn", { botId, server: id, error: e instanceof Error ? e.message : String(e) });
        const c = mine.get(id);
        mine.delete(id);
        await c?.close().catch(() => {});
        return [];
      }
    }));
    return lists.flat();
  }

  private async connect(botId: string, id: string, cfg: ProviderMcpConfig): Promise<Conn | null> {
    const mine = this.conns.get(botId)!;
    // An sdk server is identified by its instance (a module may build a fresh one per spawn); stdio by what it runs.
    const key = cfg.type === "sdk" ? (cfg as { instance: unknown }).instance : cfg.type === "stdio" ? JSON.stringify([cfg.command, cfg.args ?? []]) : null;
    if (key === null) { this.d.log?.("provider mcp: unsupported server type", { botId, server: id, type: cfg.type }); return null; }
    const have = mine.get(id);
    if (have && have.key === key) return have;
    if (have) { mine.delete(id); await have.close().catch(() => {}); }
    const client = new Client({ name: NAME, version: "1.0.0" });
    let conn: Conn;
    try {
      if (cfg.type === "sdk") {
        const server = (cfg as { instance: McpServer }).instance;
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        await withTimeout(client.connect(a), this.d.listTimeoutMs ?? LIST_TIMEOUT_MS, `${id} connect`);
        conn = { key, client, close: async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); } };
      } else {
        const s = cfg as { command: string; args?: string[] };
        const sp = this.d.spawn(id, s.command, s.args ?? []);
        await withTimeout(client.connect(new StdioClientTransport({ command: sp.command, args: sp.args, env: sp.env, cwd: this.d.cwd, stderr: "ignore" })), this.d.listTimeoutMs ?? LIST_TIMEOUT_MS, `${id} connect`);
        conn = { key, client, close: () => client.close() };
      }
    } catch (e) { await client.close().catch(() => {}); throw e; } // a half-started server never lingers
    mine.set(id, conn);
    return conn;
  }

  async close(botId?: string): Promise<void> {
    for (const [b, m] of this.conns) {
      if (botId !== undefined && b !== botId) continue;
      await Promise.all([...m.values()].map((c) => c.close().catch(() => {})));
      this.conns.delete(b);
    }
  }
}
