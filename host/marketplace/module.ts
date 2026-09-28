import { GatewayError } from "../gateway/errors";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { Catalog } from "./catalog";

export function createMarketplaceModule(ctx: ModuleContext, catalog: Catalog): HostModule {
  const changed = () => ctx.hub.publish({ channel: "catalog", payload: { changedAt: ctx.now() } });
  return {
    name: "marketplace",
    start: () => catalog.refresh(),
    observers: [{ onEvent: (_b, e) => { if (e.kind === "session") changed(); } }],
    handlers: {
      getMarketplace: () => catalog.view(),
      searchCatalog: (a) => catalog.search(String(a.query ?? ""), Math.min(a.limit ?? 20, 50)),
      getCatalogEntry: (a) => ({ entry: catalog.get(a.id) ?? (() => { throw new GatewayError("NOT_FOUND", `No catalog entry ${a.id}`, 404); })(), detail: catalog.detail(a.id) }),
      listPlugins: () => ({ entries: catalog.entries().filter((e) => e.kind === "plugin" && e.state !== "available" && e.state !== "unavailable") }),
      installPlugin: async (a) => { const r = await catalog.install(a.id); changed(); return r; },
      uninstallPlugin: async (a) => { await catalog.uninstall(a.id); changed(); return {}; },
    },
  };
}
