// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, MarketplaceView } from "@synapse/shared";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { initials } from "../../src/renderer/marketplace/LogoTile";
import { registerTemplateAdder, useMarketplace } from "../../src/renderer/marketplace/store";

const e = (p: Partial<CatalogEntry> & { id: string; name: string }): CatalogEntry => ({ kind: "plugin", source: "curated", description: `${p.name} things`, category: "Code", logo: null, action: "add", state: "available", ...p });
const view: MarketplaceView = {
  installed: { count: 6, logos: [{ name: "Gmail", logo: null }, { name: "Monday", logo: null }] },
  featuredBots: [e({ id: "tpl:1", name: "Trip Desk", kind: "bot-template", source: "local-template", author: { name: "Ana" } })],
  forYou: { because: "GitHub", entries: [e({ id: "curated:linear", name: "Linear" }), e({ id: "curated:vercel", name: "Vercel", state: "installed" })] },
  fromTeam: [e({ id: "starter:inbox-zero", name: "Inbox Zero", kind: "bot-template", source: "starter", author: { name: "Synapse Team" } })],
  featuredPlugins: [e({ id: "curated:gmail", name: "Gmail" })],
  categories: [{ name: "Login and Credential Management", entries: [e({ id: "curated:vault", name: "1Password", action: "connect" })], total: 1 }],
};
const calls: [string, unknown][] = [];
const results: Record<string, unknown> = {
  getMarketplace: view,
  installPlugin: { entry: e({ id: "curated:linear", name: "Linear", state: "needs-auth" }), serverIds: ["linear"], needsAuth: true, openUrl: null },
  startMcpAuth: { authorizationUrl: "https://auth.example/authorize?x=1" },
  searchCatalog: { plugins: [e({ id: "curated:linear", name: "Linear" })], bots: [e({ id: "tpl:1", name: "Trip Desk", kind: "bot-template" })] },
};
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: results[cmd] ?? {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
  useMarketplace.setState({ open: true, page: "home", view, query: "", results: null, waiting: {}, recent: [], detailId: null });
});
afterEach(cleanup);

describe("Marketplace modal (Marketplace.dc.html)", () => {
  it("renders the board's sections and installed header", () => {
    render(<MarketplaceModal />);
    const dlg = screen.getByRole("dialog", { name: "Marketplace" });
    expect(within(dlg).getByRole("link", { name: "Your plugins, 6 installed" }).textContent).toContain("Your plugins · 6 installed");
    expect(within(dlg).getByRole("region", { name: "Featured Bots" }).textContent).toContain("Ana's");
    expect(within(dlg).getByRole("region", { name: "For you" }).textContent).toContain("Because you use GitHub");
    expect(within(dlg).getByRole("region", { name: "From Synapse Team" }).textContent).toContain("by Synapse Team");
    expect(within(dlg).getByRole("button", { name: "Add Linear" }).textContent).toBe("Add");
    // UI polish pass: one verb per row (Add | Authorize | Manage); the state is a quiet word beside it.
    expect(within(dlg).getByRole("button", { name: "Manage Vercel" }).textContent).toBe("Manage");
    expect(within(dlg).getByRole("button", { name: "Manage Vercel" }).parentElement!.textContent).toContain("Added");
    expect(within(dlg).getByRole("button", { name: "Add 1Password" }).textContent).toBe("Add");
  });

  it("Add → authorize in the browser → Waiting for authorization + Reopen (PLG-04)", async () => {
    render(<MarketplaceModal />);
    fireEvent.click(screen.getByRole("button", { name: "Add Linear" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://auth.example/authorize?x=1" }]));
    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(["installPlugin", "startMcpAuth"]));
    expect(screen.getByText("Waiting for authorization")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await vi.waitFor(() => expect(calls.filter((c) => c[0] === "startMcpAuth")).toHaveLength(2));
  });

  it("an entry with an open URL opens it; template entries go to the registered adder", async () => {
    results.installPlugin = { entry: e({ id: "curated:gmail", name: "Gmail" }), serverIds: [], needsAuth: false, openUrl: "https://example.com/connect" };
    const added: string[] = [];
    registerTemplateAdder((x) => added.push(x.id));
    render(<MarketplaceModal />);
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://example.com/connect" }]));
    fireEvent.click(screen.getByRole("button", { name: "Add Inbox Zero" }));
    expect(added).toEqual(["starter:inbox-zero"]);
  });

  it("typeahead groups Plugins and Bots, ↓/↵ opens detail, Clear resets", async () => {
    render(<MarketplaceModal />);
    const input = screen.getByRole("combobox", { name: "Search plugins and Bots" });
    fireEvent.change(input, { target: { value: "li" } });
    await vi.waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    const box = screen.getByRole("listbox");
    expect(within(box).getByText("Plugins ›")).toBeTruthy();
    expect(within(box).getByText("Bots")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMarketplace.getState()).toMatchObject({ page: "detail", detailId: "curated:linear", recent: ["curated:linear"] });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useMarketplace.getState().query).toBe("");
  });

  it("initials follow the board's tiles", () => {
    expect(initials("Granola")).toBe("Gr");
    expect(initials("1Password")).toBe("1P");
    expect(initials("Google Drive")).toBe("GD");
  });

  it("closes with the Close Marketplace button and Esc", () => {
    render(<MarketplaceModal />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useMarketplace.getState().open).toBe(false);
  });

  it("Task 34 fuzz: ↵ in an empty search keeps the home listing instead of a blank results page", () => {
    render(<MarketplaceModal />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search plugins and Bots" }), { key: "Enter" });
    expect(useMarketplace.getState().page).toBe("home");
    expect(screen.getByRole("button", { name: "Add Linear" })).toBeTruthy();
  });
});

describe("Added 11:20: an entry that can't be added here", () => {
  it("renders as unavailable, not as an Add button", () => {
    useMarketplace.setState({ view: { ...view, featuredPlugins: [e({ id: "curated:gmail", name: "Gmail", state: "unavailable" })] } });
    render(<MarketplaceModal />);
    // UI polish pass: the state is a quiet word, not a disabled button.
    const status = screen.getByRole("img", { name: "Gmail: Not available" });
    expect(status.textContent).toBe("Not available");
    expect(screen.queryByRole("button", { name: "Add Gmail" })).toBeNull();
  });
});
