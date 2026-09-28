import { GOOGLE_SERVER_ID, STR5, STRG, googleToolsMounted, GOOGLE_TOOL_NAMES, type ConnectCardView, type GoogleBotStatusView } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { Catalog } from "../marketplace/catalog";
import { mcpServerViews, type McpServices } from "../mcp/module";
import { postCard } from "../phase5/cards";
import type { TurnSlot } from "../runner/turn-slot";

const err = (text: string): BotToolResult => ({ text, isError: true });

export function connectCardFor(catalog: Catalog, mcp: McpServices, serverId: string | null, catalogId: string | null): ConnectCardView {
  const server = serverId ? mcp.registry.get(serverId) : undefined;
  const entry = catalogId ? catalog.get(catalogId) : server?.catalogId ? catalog.get(server.catalogId) : undefined;
  const name = server ? (server.label ? `${server.name} (${server.label})` : server.name) : entry?.name ?? "Connector";
  const state = server ? (mcp.pool.status(server.id) === "connected" ? "connected" : "added") : "available";
  return { kind: "connect", serverId: server?.id ?? null, catalogId: catalogId ?? server?.catalogId ?? null, name, logo: entry?.logo ?? null, toolCount: mcp.pool.toolDescriptions(server?.id ?? "").size || entry?.toolCount || 0, state };
}

/**
 * The eight connector tools whose every code path starts by looking up a connector that is already
 * installed — each one answers "No MCP server <id>." when nothing is. They are therefore uncallable,
 * not merely unlikely, on a Bot whose user has installed nothing, and a tool that cannot be called
 * still costs its JSON schema on every model call of the session. Measured with the CLI's own
 * /context accounting (2026-09-19): 1,136 tokens per turn, every turn, for tools with no target.
 *
 * Google is deliberately NOT a reason to mount them: it is the built-in connector, it is not in the
 * MCP registry, and sections/plugins.md already tells the Bot that neither AuthenticateMcpServer nor
 * RestartMcpServers changes anything about it. GetMcpServerStatus — which does answer for Google —
 * stays mounted for everyone.
 */
export const MANAGE_INSTALLED_TOOLS: readonly string[] = [
  "AuthenticateMcpServer", "RestartMcpServers", "SetMcpInstructions", "SetMcpToolEnabled",
  "RenameMcpAccount", "RemoveMcpAccount", "UninstallMcpServer", "UninstallPlugin",
];

/** Whether there is any installed connector for MANAGE_INSTALLED_TOOLS to act on. */
export function hasInstalledConnector(d: { catalog: Catalog; mcp: McpServices }): boolean {
  if (d.mcp.registry.list().length > 0) return true;
  return d.catalog.entries().some((e) => e.kind === "plugin" && e.state !== "available" && e.state !== "unavailable");
}

export function createPluginTools(d: { botId: string; slot(): TurnSlot | null; catalog: Catalog; mcp: McpServices; bots: BotService; now(): number; onCard?(serverId: string | null): void; google?(): GoogleBotStatusView }): BotToolDef[] {
  const display = (id: string) => { const s = d.mcp.registry.get(id); return s ? (s.label ? `${s.name} (${s.label})` : s.name) : null; };
  // The built-in Google connector is not in the MCP registry, so it used to be invisible to every tool here: the
  // Marketplace said "connected" while GetMcpServerStatus said "No connectors are installed". These read the same
  // per-Bot view the spawn set is built from, so the two can no longer disagree.
  const gStatus = (): GoogleBotStatusView | null => { const v = d.google?.(); return v && v.state !== "not-configured" ? v : null; };
  const gLine = (v: GoogleBotStatusView): string =>
    `- ${STRG.google} (built-in) \u2014 ${STRG.botStateLabel[v.state]} [${GOOGLE_SERVER_ID}]${googleToolsMounted(v) ? `: ${GOOGLE_TOOL_NAMES.join(", ")}` : ""}\n  ${STRG.botNextStep(v)}`;
  const gShort = (v: GoogleBotStatusView): string => (v.state === "ready" ? " (on for this Bot)" : v.state === "off-for-bot" ? " (connected to the account, but off for this Bot \u2014 you have no tools from it)" : ` (${STRG.botStateLabel[v.state]})`);
  // Returns whether a card was actually posted. `d.slot()` can be null by the time an awaited
  // catalog.install()/pool.ensure() resolves, if the turn has already moved on — callers must vary
  // their returned tool text accordingly rather than unconditionally claiming a card was shown.
  const card = (serverId: string | null, catalogId: string | null): boolean => {
    const slot = d.slot();
    if (slot) postCard({ bots: d.bots, now: d.now }, d.botId, slot, connectCardFor(d.catalog, d.mcp, serverId, catalogId));
    d.onCard?.(serverId);
    return !!slot;
  };
  const tool = (name: string, description: string, readOnly: boolean, schema: BotToolDef["schema"], handler: (a: Record<string, unknown>) => Promise<BotToolResult>): BotToolDef => ({ name, description, readOnly, schema, handler: async (a) => { try { return await handler(a); } catch (e) { return err((e as Error).message); } } });

  const all: BotToolDef[] = [
    tool("SearchPlugins", "Search the Marketplace catalog of plugins and connectors.", true, { query: z.string() }, async (a) => {
      const r = d.catalog.search(String(a.query), 10).plugins;
      const g = gStatus();
      return { text: r.length ? r.map((e) => `- ${e.name} (${e.id}): ${e.description} [${e.state}]${e.source === "google" && g ? gShort(g) : ""}`).join("\n") : "No plugins match." };
    }),
    tool("GetPlugin", "Get details about one catalog plugin.", true, { plugin_id: z.string() }, async (a) => {
      const e = d.catalog.get(String(a.plugin_id));
      if (!e) return err(`No plugin ${String(a.plugin_id)}.`);
      const det = d.catalog.detail(e.id);
      const g = e.source === "google" ? gStatus() : null;
      // The catalog state is the user's *account*; this connector is per-Bot, so say what it means for this Bot.
      const perBot = g ? `\nFor this Bot: ${STRG.botStateLabel[g.state]}. ${STRG.botNextStep(g)}` : "";
      return { text: `${e.name} (${e.id}) — ${det.sourceLabel}, ${e.state}\n${det.longDescription}${det.tools.length ? `\nTools: ${det.tools.join(", ")}` : ""}${perBot}${e.state === "available" && !g ? "\nInstall it with InstallPlugin." : ""}` };
    }),
    tool("InstallPlugin", "Install a catalog plugin for every Bot. Installs that add a local program ask the user first.", false, { plugin_id: z.string() }, async (a) => {
      const r = await d.catalog.install(String(a.plugin_id));
      if (r.needsAuth) {
        const posted = card(r.serverIds[0] ?? null, r.entry.id);
        return { text: posted
          ? `Installed ${r.entry.name}. The user needs to authorize it; a connect card was shown. Its tools work after they finish.`
          : `Installed ${r.entry.name}. The user needs to authorize it; a connect card will be shown once they're back in a live turn. Its tools work after they finish.` };
      }
      return { text: `Installed ${r.entry.name}. Its tools are available from your next turn.` };
    }),
    tool("UninstallPlugin", "Uninstall a plugin for every Bot.", false, { plugin_id: z.string() }, async (a) => {
      const e = d.catalog.get(String(a.plugin_id));
      if (!e) return err(`No plugin ${String(a.plugin_id)}.`);
      await d.catalog.uninstall(e.id);
      return { text: `Uninstalled ${e.name}.` };
    }),
    tool("AddMcpServer", "Add a custom MCP server (url for remote servers, or command for a local one).", false,
      // env/headers are free-form objects: z.looseObject({}), never z.record() — the Agent SDK's bundled
      // JSON-schema driver crashes on zod 4.6's record processor and fails the whole "bot" tools/list (mcpfix).
      { name: z.string(), url: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.looseObject({}).optional(), headers: z.looseObject({}).optional() },
      async (a) => {
        const s = d.mcp.registry.add({ name: String(a.name), url: a.url as string | undefined, command: a.command as string | undefined, args: a.args as string[] | undefined, env: a.env as Record<string, string> | undefined, headers: a.headers as Record<string, string> | undefined }, "custom");
        if (s.kind === "remote" && (await d.mcp.pool.ensure(s.id)) === "needs-auth") {
          const posted = card(s.id, null);
          return { text: posted
            ? `Added ${s.name} (server id ${s.id}). The user needs to authorize it; a connect card was shown.`
            : `Added ${s.name} (server id ${s.id}). The user needs to authorize it; a connect card will be shown once they're back in a live turn.` };
        }
        return { text: `Added ${s.name} (server id ${s.id}). Its tools are available from your next turn.` };
      }),
    tool("UninstallMcpServer", "Remove a custom MCP server.", false, { server_id: z.string() }, async (a) => removeServer(String(a.server_id))),
    tool("GetMcpServerStatus", "Show connector status and tools.", true, { server_id: z.string().optional() }, async (a) => {
      const views = mcpServerViews(d.mcp).filter((v) => !a.server_id || v.id === a.server_id);
      const lines = views.map((v) => `- ${v.label ? `${v.name} (${v.label})` : v.name} — ${STR5.statusLabel[v.status]} [${v.id}]${v.tools.length ? `: ${v.tools.filter((t) => t.enabled).map((t) => t.name).join(", ")}` : ""}`);
      // The built-in Google connector is not in the MCP registry, so without this the answer was "No connectors
      // are installed." while the Marketplace said "connected" about the same account.
      const g = !a.server_id || a.server_id === GOOGLE_SERVER_ID ? gStatus() : null;
      if (g) lines.unshift(gLine(g));
      if (!lines.length) return { text: a.server_id ? `No MCP server ${String(a.server_id)}.` : "No connectors are installed." };
      return { text: lines.join("\n") };
    }),
    tool("SetMcpInstructions", "Save standing instructions for how Bots should use a connector (≤500 chars).", false, { server_id: z.string(), instructions: z.string() }, async (a) => {
      const id = String(a.server_id);
      d.mcp.registry.setInstructions(id, String(a.instructions));
      return { text: `Saved instructions for ${display(id) ?? id}.` };
    }),
    tool("RestartMcpServers", "Reconnect one connector or all of them.", false, { server_id: z.string().optional() }, async (a) => {
      // Restarting cannot mount a server that was never in this session's spawn set, so say so rather than
      // reporting a restart that changed nothing.
      const g = gStatus();
      if (a.server_id === GOOGLE_SERVER_ID) return { text: g ? `${STRG.google} is the built-in connector, not a restartable MCP server. ${STRG.botNextStep(g)}` : `No MCP server ${String(a.server_id)}.` };
      await d.mcp.pool.restart(a.server_id as string | undefined);
      const note = !a.server_id && g && !googleToolsMounted(g) ? `\n${STRG.google} is the built-in connector and is not affected by a restart. ${STRG.botNextStep(g)}` : "";
      return { text: (a.server_id ? `Restarted ${display(String(a.server_id)) ?? a.server_id}.` : "Restarted all connectors.") + note };
    }),
    tool("AuthenticateMcpServer", "Ask the user to sign in to a connector. Shows a connect card; the user finishes in their browser.", false, { server_id: z.string() }, async (a) => {
      const id = String(a.server_id);
      const g = id === GOOGLE_SERVER_ID ? gStatus() : null;
      // Google's sign-in lives in Settings -> Connected accounts, and the per-Bot toggle is a separate step; a
      // connect card here would be a dead end.
      if (g) return { text: STRG.botNextStep(g), isError: !googleToolsMounted(g) };
      if (!d.mcp.registry.get(id)) return err(`No MCP server ${id}.`);
      const posted = card(id, null);
      return { text: posted
        ? `A connect card for ${display(id)} was shown. The user completes sign-in in their browser.`
        : `A connect card for ${display(id)} will be shown once the user is back in a live turn. The user completes sign-in in their browser.` };
    }),
    tool("RemoveMcpAccount", "Remove one account (instance) of a connector.", false, { server_id: z.string() }, async (a) => removeServer(String(a.server_id))),
    tool("RenameMcpAccount", "Label a connector account, e.g. \"work\".", false, { server_id: z.string(), label: z.string() }, async (a) => {
      const id = String(a.server_id);
      const before = display(id);
      if (!before) return err(`No MCP server ${id}.`);
      d.mcp.registry.rename(id, String(a.label));
      return { text: `Renamed ${before} to ${display(id)}.` };
    }),
    tool("SetMcpToolEnabled", "Turn one connector tool on or off for every Bot.", false, { server: z.string(), tool: z.string(), enabled: z.boolean() }, async (a) => {
      const id = String(a.server);
      d.mcp.registry.setToolEnabled(id, String(a.tool), Boolean(a.enabled));
      return { text: `Turned ${a.enabled ? "on" : "off"} ${String(a.tool)} for ${display(id) ?? id}.` };
    }),
  ];

  // The five that always have something to do — search, read details, read status, install, add —
  // stay; the eight that need a target appear with the first target. sections/plugins.md is gated on
  // the same predicate, so the prose and the tool list can never disagree.
  const manage = new Set(MANAGE_INSTALLED_TOOLS);
  return hasInstalledConnector(d) ? all : all.filter((t) => !manage.has(t.name));

  async function removeServer(id: string): Promise<BotToolResult> {
    const name = display(id);
    if (!name) return err(`No MCP server ${id}.`);
    await d.mcp.pool.restart(id);
    d.mcp.oauth.forget(id);
    d.mcp.registry.remove(id);
    return { text: `Removed ${name}.` };
  }
}
