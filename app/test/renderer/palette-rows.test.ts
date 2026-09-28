// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketplacePaletteRows } from "../../src/renderer/marketplace/palette-rows";
import { useMarketplace } from "../../src/renderer/marketplace/store";

const entry = (id: string, name: string, kind = "plugin") => ({ id, name, kind, source: "curated", description: "", category: null, logo: null, action: "add", state: "available" });
beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: { query?: string; id?: string }) => ({ ok: true, result: cmd === "searchCatalog" ? { plugins: [entry("curated:vault", "1Password")], bots: [entry("starter:inbox-zero", "Inbox Zero", "bot-template")] } : { entry: entry(a.id!, a.id === "curated:linear" ? "Linear" : "Sentry"), detail: {} } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
  useMarketplace.setState({ open: false, recent: ["curated:linear", "curated:sentry"] });
});

describe("palette Marketplace rows (PAL-04)", () => {
  it("before typing: the Marketplace row and the last opened entries", async () => {
    const rows = await marketplacePaletteRows("");
    expect(rows.map((r) => [r.title, r.subtitle])).toEqual([["Marketplace", "Search plugins and Bots"], ["Linear", "Marketplace"], ["Sentry", "Marketplace"]]);
    rows[0]!.onSelect();
    expect(useMarketplace.getState().open).toBe(true);
  });

  it("typed queries match catalog plugins and Bot templates; selecting opens the entry's detail", async () => {
    const rows = await marketplacePaletteRows("1pass");
    expect(rows.map((r) => r.title)).toEqual(["1Password", "Inbox Zero"]);
    expect(rows[0]!.icon).toEqual({ kind: "logo", name: "1Password", logo: null });
    rows[0]!.onSelect();
    expect(useMarketplace.getState()).toMatchObject({ open: true, page: "detail", detailId: "curated:vault" });
    expect((await marketplacePaletteRows("mark"))[0]!.title).toBe("Marketplace");
  });
});
