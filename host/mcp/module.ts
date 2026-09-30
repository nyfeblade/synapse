import { subkey, vaultKeySync } from "../secrets/crypto";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerView } from "@synapse/shared";
import type { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { HostModule, ModuleContext } from "../phase5/types";
import { httpConnector, stdioConnector } from "./connect";
import { McpOAuth } from "./oauth";
import { McpProxyPool, type CommandConnector, type Connector } from "./proxy";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { hostGuardedFetch } from "../net/guarded-fetch";
import { McpRegistry } from "./registry";
import { GatewayError } from "../gateway/errors";

/**
 * Bug 363: the fetch a remote server's requests (and its OAuth) use. The guarded fetch for every server, except one the
 * OWNER added in the app (ownerPrivateReach), which uses the plain fetch and may reach the Mac or the LAN.
 */
export function mcpFetchFor(registry: McpRegistry, guarded: FetchLike): (serverId: string) => FetchLike | undefined {
  return (serverId) => (registry.get(serverId)?.ownerPrivateReach === true ? undefined : guarded);
}

export interface McpServices { registry: McpRegistry; pool: McpProxyPool; oauth: McpOAuth; authorized: Set<(serverId: string) => void> }

export function mcpServerViews(s: McpServices): McpServerView[] {
  const own = s.registry.list().map((r) =>
    s.registry.hostProxied(r)
      ? s.registry.view(r.id, s.oauth.pendingFor(r.id) ? "waiting-auth" : s.pool.status(r.id), s.pool.toolDescriptions(r.id), s.pool.error(r.id))
      : s.registry.view(r.id, s.registry.sessionTools(r.id).length ? "connected" : "unknown"),
  );
  return own;
}

export function createMcpServices(ctx: ModuleContext, o: { connect?: Connector; connectCommand?: CommandConnector; authFn?: typeof auth } = {}): McpServices {
  const dir = path.join(ctx.cfg.hostPrivate, "mcp");
  const publish = () => ctx.hub.publish({ channel: "mcp-servers", payload: { servers: mcpServerViews(svc) } });
  const vaultKey = vaultKeySync(ctx.cfg.hostPrivate);
  const registry = new McpRegistry({ dir, settings: ctx.settings, now: ctx.now, onChange: () => publish(), envKey: subkey(vaultKey, "bots/mcp-env/v1"), headerKey: subkey(vaultKey, "bots/mcp-headers/v1") });
  let oauth: McpOAuth;
  const fetchFor = mcpFetchFor(registry, hostGuardedFetch());
  const pool = new McpProxyPool({
    registry, workspace: ctx.cfg.workspace, now: ctx.now,
    connect: o.connect ?? httpConnector((id) => oauth.providerFor(id), fetchFor),
    connectCommand: o.connectCommand ?? stdioConnector({ cfg: ctx.cfg, get runAs() { return ctx.flags().runAs; } }),
    onStatus: () => publish(),
  });
  oauth = new McpOAuth({
    dir, registry, now: ctx.now, authFn: o.authFn, fetchFor, key: subkey(vaultKey, "bots/mcp-oauth/v1"), legacyKey: vaultKey,
    onWaiting: (id) => pool.markWaiting(id),
    onAuthorized: async (id) => { await pool.restart(id); publish(); for (const fn of authorized) fn(id); },
  });
  const authorized = new Set<(serverId: string) => void>();
  const svc: McpServices = { registry, pool, oauth, authorized };
  return svc;
}

export function createMcpModule(ctx: ModuleContext, s: McpServices): HostModule {
  const view = (id: string) => mcpServerViews(s).find((v) => v.id === id)!;
  return {
    name: "mcp",
    observers: [{ onEvent: (_botId, e) => { if (e.kind === "session") s.registry.noteSessionTools(e.tools); } }],
    mcpServers: (botId): Record<string, McpServerConfig> => ({ ...s.registry.commandServerConfigs(botId), ...s.pool.sdkServers(botId) }),
    disallowedTools: () => s.registry.disallowedToolNames(),
    systemAppendExtra: (botId) => s.registry.systemAppendExtra(botId),
    stop: () => s.pool.closeAll(),
    handlers: {
      listMcpServers: () => ({ servers: mcpServerViews(s) }),
      addMcpServer: async (a) => {
        // Bug 363: the gateway command is the owner's add-server form in the app, the only door that keeps private reach.
        const r = s.registry.add(a, "custom", null, { ownerPrivateReach: true });
        if (s.registry.hostProxied(r)) await s.pool.ensure(r.id);
        return { server: view(r.id) };
      },
      removeMcpServer: async (a) => {
        await s.pool.restart(a.serverId);
        s.oauth.forget(a.serverId);
        s.registry.remove(a.serverId);
        return {};
      },
      renameMcpAccount: (a) => { s.registry.rename(a.serverId, a.label); return { server: view(a.serverId) }; },
      setMcpServerBots: (a) => {
        const botId = String(a?.botId ?? "");
        if (!ctx.bots.has(botId)) throw new GatewayError("NOT_FOUND", "No such Bot.", 404);
        s.registry.setBot(String(a?.serverId ?? ""), botId, a?.enabled === true, ctx.bots.ids());
        return { server: view(String(a.serverId)) };
      },
      setMcpToolEnabled: (a) => { s.registry.setToolEnabled(a.serverId, a.tool, a.enabled); return { server: view(a.serverId) }; },
      setMcpServerEnabled: async (a) => {
        s.registry.setEnabled(a.serverId, a.enabled);
        await s.pool.restart(a.serverId);
        return { server: view(a.serverId) };
      },
      setMcpInstructions: (a) => { s.registry.setInstructions(a.serverId, a.instructions); return { server: view(a.serverId) }; },
      setMcpServerTrusted: (a) => { s.registry.setTrusted(a.serverId, a.trusted === true); return { server: view(a.serverId) }; },
      // PLG header auth. The value is sealed by setHeader and is not read back here; the restart is
      // what makes "Replace" mean something — a live connection is still holding the old key.
      setMcpServerHeader: async (a) => {
        s.registry.setHeader(a.serverId, String(a.name ?? "").trim(), a.value === null ? null : String(a.value));
        await s.pool.restart(a.serverId);
        return { server: view(a.serverId) };
      },
      restartMcpServers: async (a) => { await s.pool.restart(a.serverId); return {}; },
      startMcpAuth: async (a) => ({ authorizationUrl: await s.oauth.start(a.serverId) }),
      completeMcpOAuth: (a) => s.oauth.complete(a),
      setOAuthLoopbackPort: (a) => { s.oauth.setLoopbackPort(Number(a.port)); return {}; },
    },
  };
}
