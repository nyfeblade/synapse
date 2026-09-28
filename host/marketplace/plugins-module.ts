import type { HostModule, ModuleContext } from "../phase5/types";
import type { Catalog } from "./catalog";
import type { PluginMarketplaces } from "./plugin-marketplaces";

export function createPluginMarketplacesModule(ctx: ModuleContext, pm: PluginMarketplaces, catalog: Catalog): HostModule {
  const changed = () => { catalog.refresh(); ctx.hub.publish({ channel: "catalog", payload: { changedAt: ctx.now() } }); };
  return {
    name: "plugin-marketplaces",
    handlers: {
      listPluginMarketplaces: () => ({ marketplaces: pm.marketplaces() }),
      addPluginMarketplace: async (a) => { const m = await pm.add(String(a.source ?? "")); changed(); return { marketplace: m }; },
      removePluginMarketplace: (a) => { pm.remove(a.name); changed(); return {}; },
    },
  };
}
