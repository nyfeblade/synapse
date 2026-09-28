import { STR5, type CatalogEntry } from "@synapse/shared";
import { call } from "../bridge";
import { useMarketplace } from "./store";

export interface MarketplacePaletteRow { id: string; title: string; subtitle: string; icon: { kind: "grid" } | { kind: "logo"; name: string; logo: string | null }; onSelect(): void }

const openRow: () => MarketplacePaletteRow = () => ({
  id: "marketplace", title: STR5.marketplace, subtitle: STR5.paletteMarketplaceSub, icon: { kind: "grid" },
  onSelect: () => useMarketplace.getState().openMarketplace(),
});
const entryRow = (e: CatalogEntry): MarketplacePaletteRow => ({
  id: `mkt:${e.id}`, title: e.name, subtitle: STR5.paletteResultSub, icon: { kind: "logo", name: e.name, logo: e.logo },
  onSelect: () => { const m = useMarketplace.getState(); m.openMarketplace({ detailId: e.id }); m.openDetail(e.id); },
});

export async function marketplacePaletteRows(query: string): Promise<MarketplacePaletteRow[]> {
  const q = query.trim();
  if (!q) {
    const recent = await Promise.all(useMarketplace.getState().recent.slice(0, 3).map((id) => call("getCatalogEntry", { id }).then((r) => r.entry).catch(() => null)));
    return [openRow(), ...recent.filter((e): e is CatalogEntry => !!e).map(entryRow)];
  }
  const r = await call("searchCatalog", { query: q, limit: 8 }).catch(() => ({ plugins: [], bots: [] }));
  const head = STR5.marketplace.toLowerCase().startsWith(q.toLowerCase()) ? [openRow()] : [];
  return [...head, ...r.plugins.map(entryRow), ...r.bots.map(entryRow)];
}
