import { STR5 } from "@synapse/shared";
import type { McpServices } from "../mcp/module";
import { postCard } from "../phase5/cards";
import { fillTemplate, loadPrompt } from "../prompts";
import type { HostModule, ModuleContext } from "../phase5/types";
import { connectCardFor, createPluginTools, hasInstalledConnector } from "../tools/plugin-tools";
import type { Catalog } from "./catalog";
import type { GoogleServices } from "../google/module";

export function createConnectorToolsModule(ctx: ModuleContext, o: { catalog: Catalog; mcp: McpServices; google?: GoogleServices }): HostModule {
  const posted = new Set<string>();
  const awaiting = new Map<string, Set<string>>(); // serverId → Bots that showed a connect card for it
  const await_ = (serverId: string | null, botId: string) => { if (serverId) awaiting.set(serverId, new Set([...(awaiting.get(serverId) ?? []), botId])); };
  o.mcp.pool.setAuthNeededHandler((serverId, botId) => {
    const slot = botId ? ctx.slot(botId) : null;
    if (!botId || !slot) return;
    const key = `${slot.requestId}:${serverId}`;
    if (posted.has(key)) return;
    posted.add(key);
    postCard(ctx, botId, slot, connectCardFor(o.catalog, o.mcp, serverId, null));
    await_(serverId, botId);
  });
  // EVT-02 wake #13 "MCP auth finished": each Bot that asked for the connector is resumed once.
  o.mcp.authorized.add((serverId) => {
    const s = o.mcp.registry.get(serverId);
    for (const botId of awaiting.get(serverId) ?? []) {
      ctx.enqueueHidden(botId, { source: "mcp-auth", lane: "background", silenceAllowed: false, text: fillTemplate(loadPrompt("wakes/mcp-auth-done.md"), { server: s ? s.name : serverId }) });
    }
    awaiting.delete(serverId);
  });
  // PLG-06: @-mentions match any catalog plugin (installed or not — the Bot can install it itself)
  // plus any custom MCP server the user added directly, which isn't in the catalog.
  const connectorNames = () => new Map([
    ...o.catalog.entries().filter((e) => e.kind === "plugin").map((e) => [e.name.toLowerCase(), e.name] as const),
    ...o.mcp.registry.list().map((s) => [s.name.toLowerCase(), s.name] as const),
  ]);
  return {
    name: "connector-tools",
    botTools: (botId, slot) => createPluginTools({ botId, slot, catalog: o.catalog, mcp: o.mcp, bots: ctx.bots, now: ctx.now, onCard: (sid) => await_(sid, botId), ...(o.google ? { google: () => o.google!.botStatus(botId) } : {}) }),
    // Hand-test bug A: the Bot had all thirteen plugin/connector tools and nothing in the prompt ever
    // said so, or when to reach for them. The guidance hangs off the same module that registers the
    // tools — the way sections/computer.md hangs off Phase 3 (host/app.ts extraSystemAppend) — so it can
    // only appear when the tools it names exist, and a tool added here without a matching line fails
    // host/test/marketplace/plugin-prompt.test.ts. Catalog shape per spec D8-A (PLG-01).
    //
    // The second half is gated on the same predicate as the eight manage-an-installed-connector tools,
    // so the prose and the tool list can never disagree. Both halves are constants, and the gate moves
    // only when the user installs or removes something, so the composed text is stable turn to turn —
    // which is what keeps this whole system block a prompt-cache READ rather than a re-write.
    systemAppendExtra: () => [
      loadPrompt("sections/plugins.md").trimEnd(),
      ...(hasInstalledConnector({ catalog: o.catalog, mcp: o.mcp }) ? [loadPrompt("sections/plugins-installed.md").trimEnd()] : []),
    ].join("\n"),
    handlers: {},
    wrapHandlers: (base) => ({
      sendPrompt: async (a) => {
        const names = connectorNames();
        const hints = (a.mentions ?? []).map((m) => names.get(m.toLowerCase())).filter((n): n is string => !!n).map(STR5.mentionHint);
        if (!hints.length) return base.sendPrompt!(a);
        // Through the base handler, so attachments, replies, skills and group routing still apply.
        return base.sendPrompt!({ ...a, hints } as typeof a);
      },
    }),
  };
}
