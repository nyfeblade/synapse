import path from "node:path";
import type { NativeHandler } from "../native";
import type { Call } from "../gateway-call";
import { McpSocketServer, type McpPendingView } from "./server";
import { McpAudit, McpStore, type McpAuditEntry, type McpClientView, type Sealer } from "./store";

/** How an MCP client starts the helper on this install. */
export interface McpLaunch { command: string; args: string[]; env: Record<string, string> }
export interface McpSnippets { claudeDesktop: string; claudeCode: string; cursor: string }

/** What Settings → System → MCP shows. */
export interface McpStatusView {
  enabled: boolean;
  error: string | null;
  clients: McpClientView[];
  pending: McpPendingView[];
  snippets: McpSnippets;
}

/** The socket every snippet names: `<userData>/mcp/mcp.sock`. */
export const mcpSocketPath = (userData: string): string => path.join(userData, "mcp", "mcp.sock");

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Copyable config for the three clients. Synapse never writes these files: the owner pastes them.
 * Each names its client key (--client), so the card and Settings say which app it is.
 */
export function mcpSnippets(launch: McpLaunch, socketPath: string): McpSnippets {
  const json = (key: string) => JSON.stringify({
    mcpServers: { synapse: { command: launch.command, args: [...launch.args, "--client", key], env: { ...launch.env, SYNAPSE_MCP_SOCKET: socketPath } } },
  }, null, 2);
  const env = Object.entries({ ...launch.env, SYNAPSE_MCP_SOCKET: socketPath }).map(([k, v]) => `-e ${k}=${sq(v)}`).join(" ");
  return {
    claudeDesktop: json("claude-desktop"),
    claudeCode: `claude mcp add synapse --scope user ${env} -- ${[launch.command, ...launch.args].map(sq).join(" ")} --client claude-code`,
    cursor: json("cursor"),
  };
}

export interface McpWireDeps {
  userData: string;
  reg(name: string, fn: NativeHandler): void;
  emit(channel: string, payload: unknown): void;
  /** The host's gateway, or null while Synapse isn't connected to it. */
  call(): Call | null;
  launch: McpLaunch;
  seal: Sealer | null;
  /** A new card: draw the owner's eye (the Dock bounces). */
  attention?(): void;
  log(line: string): void;
  /** Tests only. */
  server?: McpSocketServer;
  socketPath?: string;
}

/**
 * 0.1.4 — Synapse's MCP server, off by default. Nothing listens, ticks or reads until the switch is on: the file
 * that holds the switch is read once at launch, and the audit log only when Settings asks for it or a call comes in.
 */
export function registerMcp(d: McpWireDeps) {
  const store = McpStore.in(d.userData, d.seal);
  const audit = McpAudit.in(d.userData);
  const socketPath = d.socketPath ?? mcpSocketPath(d.userData);
  let error: string | null = null;
  let seen = new Set<string>();
  const changed = () => {
    const now = new Set(server.pending().map((p) => p.id));
    if ([...now].some((id) => !seen.has(id))) d.attention?.();
    seen = now;
    d.emit("mcp", { type: "changed" });
  };
  const server = d.server ?? new McpSocketServer({
    store, audit, log: d.log, onChange: changed,
    call: () => { const c = d.call(); if (!c) throw new Error("Synapse isn't connected to its computer yet. Try again in a moment."); return c; },
  });

  const status = (): McpStatusView => ({
    enabled: store.read().enabled && server.listening,
    error,
    clients: store.views(),
    pending: server.pending(),
    snippets: mcpSnippets(d.launch, socketPath),
  });

  const turnOn = async (): Promise<void> => {
    try {
      await server.start(socketPath);
      error = null;
    } catch (e) {
      error = (e as Error).message;
      d.log(`mcp: couldn't start: ${error}`);
    }
  };

  d.reg("mcp.status", () => status());
  d.reg("mcp.enable", async () => { store.setEnabled(true); await turnOn(); changed(); return status(); });
  d.reg("mcp.disable", async () => { store.setEnabled(false); error = null; await server.stop(); changed(); return status(); });
  d.reg("mcp.allow", (a: { id?: unknown }) => { server.approve(String(a?.id ?? "")); return status(); });
  d.reg("mcp.deny", (a: { id?: unknown }) => { server.deny(String(a?.id ?? "")); return status(); });
  d.reg("mcp.revoke", (a: { id?: unknown }) => { server.revoke(String(a?.id ?? "")); return status(); });
  d.reg("mcp.audit", (): { entries: McpAuditEntry[] } => ({ entries: audit.recent() }));

  return {
    server,
    store,
    status,
    /** At launch: listen only if the owner turned it on. */
    resume: async () => { if (store.read().enabled) await turnOn(); },
    /** At quit: the socket goes with the app. */
    dispose: () => server.stop(),
  };
}
