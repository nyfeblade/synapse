import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME } from "@synapse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConformanceFlags } from "../brain/conformance/flags";
import { buildBotEnv } from "../brain/spawn-options";
import type { HostConfig } from "../config";
import type { CommandConnector, Connector } from "./proxy";
import { applySentinel, scrubClaudeAuth } from "../auth/auth-env";

/**
 * Streamable HTTP first; servers that answer 404/405 get the older SSE transport.
 *
 * `headers` arrives as an argument rather than being read off `s`, because `s.headers` is always {}
 * since the header-vault fix — the values live sealed and the pool resolves them at connect time,
 * the same shape as a command server's env. This is the ONLY place a header credential is used.
 */
export function httpConnector(authProviderFor: (serverId: string) => OAuthClientProvider | undefined, fetchFor: (serverId: string) => FetchLike | undefined): Connector {
  return async (s, headers = {}) => {
    const url = new URL(s.url!);
    // Bug 363: the server's fetch (the guarded one unless the owner added it) carries every request, redirect and
    // OAuth discovery/token call the transport makes.
    const fetch = fetchFor(s.id);
    const opts = { authProvider: authProviderFor(s.id), requestInit: { headers }, ...(fetch ? { fetch } : {}) };
    const client = new Client({ name: APP_NAME.toLowerCase(), version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, opts));
    } catch (e) {
      if (!/\b(404|405)\b/.test(String(e))) throw e;
      await client.connect(new SSEClientTransport(url, opts));
    }
    return {
      listTools: async () => (await client.listTools()).tools,
      callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as never,
      close: () => client.close(),
    };
  };
}

/**
 * The root helper that starts a host-proxied command MCP server (box/files/bot-mcp-as-box). Ruling (final box
 * verification): these servers carry API keys, so they run as their own uid MCP_USER, never box, and a Bot can't
 * read their env through /proc/<pid>/environ.
 */
export const MCP_AS_BOX = "/usr/local/libexec/bot-mcp-as-box";
export const MCP_USER = "boxmcp";
export const MCP_HOME = "/var/lib/boxmcp";

/**
 * Open item 1: how a host-proxied command server is started. On the box (setpriv) it runs as user box through the
 * root helper; its env values go in a one-shot 0600 file under host-private run/ (read and deleted by the helper),
 * never in argv or the Bot's env. Elsewhere (FUZZ, same-uid) it runs directly with the minimal env plus its vault env.
 */
export function commandServerSpawn(o: { cfg: HostConfig; runAs: ConformanceFlags["runAs"] }, s: { id: string; command: string; args: string[] }, env: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } {
  const clean = Object.fromEntries(Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\r\n\0]/.test(v)));
  // Final secfix item 7: the server's env is the Bot env baseline (buildBotEnv, never a Claude login or key) + its vault
  // values, with any login a vault value tried to add scrubbed again.
  const full: Record<string, string> = applySentinel(scrubClaudeAuth({ ...buildBotEnv({ cfg: o.cfg, botId: `mcp-${s.id}` }), ...clean }));
  if (o.runAs === "setpriv") {
    Object.assign(full, { HOME: MCP_HOME, USER: MCP_USER, LOGNAME: MCP_USER });
    const dir = path.join(o.cfg.hostPrivate, "run");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `mcp-${s.id.replace(/[^a-z0-9-]/gi, "")}-${randomBytes(8).toString("hex")}.env`);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, Object.entries(full).map(([k, v]) => `${k}=${v}\n`).join("")); } finally { fs.closeSync(fd); }
    return { command: "sudo", args: ["-n", MCP_AS_BOX, file, "--", s.command, ...s.args], env: { PATH: "/usr/bin:/bin" } };
  }
  return { command: s.command, args: s.args, env: full };
}

export function stdioConnector(o: { cfg: HostConfig; runAs: ConformanceFlags["runAs"] }): CommandConnector {
  return async (s, env) => {
    const sp = commandServerSpawn(o, { id: s.id, command: s.command!, args: s.args ?? [] }, env);
    const client = new Client({ name: APP_NAME.toLowerCase(), version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: sp.command, args: sp.args, env: sp.env, cwd: fs.existsSync(o.cfg.workspace) ? o.cfg.workspace : undefined, stderr: "ignore" }));
    return {
      listTools: async () => (await client.listTools()).tools,
      callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as never,
      close: () => client.close(),
    };
  };
}
