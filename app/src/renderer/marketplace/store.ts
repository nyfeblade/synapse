import { create } from "zustand";
import { LIMITS5, type CatalogEntry, type CatalogSearchResult, type MarketplaceView } from "@synapse/shared";
import { call } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { nativeCall } from "../native";

const RECENT_KEY = "marketplace.recent";
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]; } catch { return []; } };
let templateAdder: ((e: CatalogEntry) => void) | null = null;
export function registerTemplateAdder(fn: (e: CatalogEntry) => void): void { templateAdder = fn; }
export function hasTemplateAdder(): boolean { return templateAdder !== null; }

type Page = "home" | "results" | "detail" | "manage";
interface MarketplaceState {
  open: boolean; page: Page; detailId: string | null; view: MarketplaceView | null; query: string; results: CatalogSearchResult | null;
  waiting: Record<string, string>; recent: string[]; error: string | null;
  openMarketplace(o?: { detailId?: string; page?: "manage" }): void; close(): void; load(): Promise<void>; setQuery(q: string): Promise<void>; showAll(): void;
  add(e: CatalogEntry): Promise<void>; reopen(e: CatalogEntry): Promise<void>; openDetail(id: string): void; closeDetail(): void;
}

/**
 * Start (or restart) one server's OAuth flow and hand the page to the browser: `startMcpAuth` plus
 * the browser tab, which is the whole of authorization in this process. The catalog pill's
 * Authorize and Reopen reach it through `add` and `reopen` below; Manage plugins → Installed
 * (bug 53) calls it directly, because an already-added server has nothing left to install —
 * `add()` goes through `installPlugin`, which is keyed by CATALOG id and means nothing for a server
 * the user typed in themselves. `ConnectCard` still holds its own copy of these two lines.
 */
export async function authorize(serverId: string): Promise<void> {
  const { authorizationUrl } = await call("startMcpAuth", { serverId });
  if (authorizationUrl) await nativeCall("openExternal", { url: authorizationUrl });
}

let synced = false;
// Task 34 fuzz: a double-clicked Add must install once and open one authorization tab.
const adding = new Set<string>();
export const useMarketplace = create<MarketplaceState>((set, get) => ({
  open: false, page: "home", detailId: null, view: null, query: "", results: null, waiting: {}, recent: readRecent(), error: null,
  openMarketplace: (o) => {
    set({ open: true, page: o?.page ?? (o?.detailId ? "detail" : "home"), detailId: o?.detailId ?? null });
    // Task 34 fuzz: a failed load is shown in the modal instead of escaping as an uncaught rejection.
    const reload = () => void get().load().catch((err: unknown) => set({ error: err instanceof Error ? err.message : String(err) }));
    if (!synced) {
      synced = true;
      subscribeChannel("catalog", reload);
      subscribeChannel("mcp-servers", reload);
    }
    reload();
  },
  close: () => set({ open: false, query: "", results: null, page: "home", error: null }),
  load: async () => {
    const view = await call("getMarketplace", {});
    // Task 34 fuzz: an entry that's "available" again (removed in Manage plugins) isn't waiting any more;
    // a stale wait showed a Reopen that failed with "No remote MCP server".
    const all = [...view.featuredBots, ...view.fromTeam, ...view.featuredPlugins, ...(view.forYou?.entries ?? []), ...view.categories.flatMap((c) => c.entries)];
    const waiting = Object.fromEntries(Object.entries(get().waiting).filter(([id]) => adding.has(id) || all.find((x) => x.id === id)?.state !== "available"));
    set({ view, waiting });
  },
  setQuery: async (q) => {
    set({ query: q });
    if (!q.trim()) return set({ results: null, page: get().page === "results" ? "home" : get().page });
    const r = await call("searchCatalog", { query: q, limit: 20 });
    if (get().query === q) set({ results: r });
  },
  // Only with results to show: ↵ in an empty search used to switch to a blank page (Task 34 fuzz).
  showAll: () => { if (get().results) set({ page: "results" }); },
  openDetail: (id) => {
    const recent = [id, ...get().recent.filter((x) => x !== id)].slice(0, LIMITS5.recentMarketplaceMax);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* storage unavailable */ }
    set({ page: "detail", detailId: id, recent });
  },
  // Nothing else left the detail page: searching only renders on home/results, so a listing was a dead end.
  closeDetail: () => set({ page: get().results && get().query.trim() ? "results" : "home", detailId: null }),
  add: async (e) => {
    if (e.kind === "bot-template") return templateAdder?.(e);
    if (adding.has(e.id)) return;
    adding.add(e.id);
    set({ error: null });
    try {
      const r = await call("installPlugin", { id: e.id });
      if (r.openUrl) await nativeCall("openExternal", { url: r.openUrl });
      else if (r.needsAuth && r.serverIds[0]) {
        set({ waiting: { ...get().waiting, [e.id]: r.serverIds[0] } });
        await authorize(r.serverIds[0]);
      }
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) }); // Task 34 fuzz: shown in the modal, not thrown
    } finally {
      adding.delete(e.id);
    }
  },
  reopen: async (e) => {
    const serverId = get().waiting[e.id];
    if (!serverId) return;
    set({ error: null });
    try {
      await authorize(serverId);
    } catch (err) {
      // Task 34 fuzz: the connector was removed (or the link can't be made) — drop the stale wait so Add comes back.
      const { [e.id]: _gone, ...rest } = get().waiting;
      set({ waiting: rest, error: err instanceof Error ? err.message : String(err) });
      await get().load().catch(() => {});
    }
  },
}));
