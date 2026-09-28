// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNIPPET_CLOSE, SNIPPET_OPEN, STR, STR5 } from "@synapse/shared";
import { useVoice } from "../../src/renderer/voice/VoiceOverlay";
import { CommandPalette } from "../../src/renderer/components/CommandPalette";
import { useOverlays } from "../../src/renderer/overlays";
import { defaultRows, marketRows, withShortcuts } from "../../src/renderer/palette-rows";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { useComputer } from "../../src/renderer/computer-state";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

const names = ["Courier", "Scout", "Ledger", "Planner", "Scribe", "Fixer"];
function seed() {
  const bots = Object.fromEntries(names.map((n, i) => [n.toLowerCase(), { ...botFixture(n.toLowerCase(), n), updatedAt: 100 - i }]));
  bots.hidden = { ...botFixture("hidden", "Hidden One"), settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true } };
  useUi.setState({ bots, pinned: ["scout"], view: { kind: "chat", botId: "courier" }, settings: { ...settingsFixture(), themePreference: "light" } } as never);
}

describe("command palette (PAL-01…04)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  afterEach(cleanup);
  beforeEach(() => {
    bridge = installFakeBridge({
      search: { results: [{ kind: "message", botId: "ledger", entryId: "t4s1", snippet: `the ${SNIPPET_OPEN}invoice${SNIPPET_CLOSE} is due`, createdAt: 1 }] },
      setHostSettings: (a: { themePreference: string }) => ({ ...settingsFixture(), themePreference: a.themePreference }),
    });
    seed();
    useOverlays.setState({ open: "palette" });
  });

  it("before typing: pinned Bots first, then the rest, then Chat Settings, the board's Settings rows, Theme and the Marketplace rows (PAL-04) — with ⌘1…⌘9", () => {
    const open = vi.fn();
    const market = marketRows([
      { id: "marketplace", title: STR.marketplace, subtitle: "Search plugins and Bots", icon: { kind: "grid" }, onSelect: open },
      { id: "mkt:curated:linear", title: "Linear", subtitle: "Marketplace", icon: { kind: "logo", name: "Linear", logo: null }, onSelect: () => {} },
    ]);
    const rows = withShortcuts(defaultRows({ bots: useUi.getState().bots, pinned: ["scout"], currentBotId: "courier", theme: "light", actions: {} as never }, market));
    expect(rows.map((r) => r.title)).toEqual(["Scout", "Courier", "Ledger", "Planner", "Scribe", "Fixer", STR.chatSettings, STR.settingsGeneral, STR.settingsComputer, STR.settingsUsage, "Theme: Light", STR.marketplace, "Linear"]);
    expect(rows.map((r) => r.shortcut)).toEqual(["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘6", "⌘7", "⌘8", "⌘9", null, null, null, null]);
    // UI polish pass: the Computer and Usage rows are live deep links now, not disabled stubs.
    expect(rows.find((r) => r.title === STR.settingsComputer)!.disabled).toBeFalsy();
    expect(rows.find((r) => r.title === STR.settingsUsage)!.disabled).toBeFalsy();
    const m = rows.find((r) => r.title === STR.marketplace)!;
    expect(m).toMatchObject({ subtitle: "Search plugins and Bots", icon: "store" });
    expect(m.disabled).toBeFalsy();
    m.run();
    expect(open).toHaveBeenCalled();
    expect(rows.find((r) => r.title === "Linear")).toMatchObject({ logo: { name: "Linear", logo: null } });
    expect(rows.some((r) => r.title === "Hidden One")).toBe(false);
  });

  it("the live palette lists catalog results from the Marketplace provider and opens the entry", async () => {
    bridge = installFakeBridge({
      search: { results: [] },
      searchCatalog: { plugins: [{ id: "curated:vault", name: "1Password", kind: "plugin", source: "curated", description: "", category: null, logo: null, action: "add", state: "available" }], bots: [] },
    });
    useMarketplace.setState({ open: false, recent: [] });
    render(<CommandPalette />);
    expect(await screen.findByRole("option", { name: new RegExp(STR.marketplace) })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: STR.search }), { target: { value: "1pass" } });
    fireEvent.click(await screen.findByRole("option", { name: /1Password/ }));
    expect(useMarketplace.getState()).toMatchObject({ open: true, detailId: "curated:vault" });
    expect(useOverlays.getState().open).toBeNull();
  });

  it("renders the board's dialog and ⌘2 opens the second row", () => {
    const openBot = vi.fn(async () => {});
    useUi.setState({ openBot } as never);
    render(<CommandPalette />);
    const dlg = screen.getByRole("dialog", { name: STR.search });
    expect(within(dlg).getByRole("textbox", { name: STR.search })).toBeTruthy();
    expect(within(dlg).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(openBot).toHaveBeenCalledWith("courier");
    expect(useOverlays.getState().open).toBeNull();
  });

  it("↵ on the Theme row cycles without closing", async () => {
    render(<CommandPalette />);
    const input = screen.getByRole("textbox", { name: STR.search });
    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Theme: Dark")).toBeTruthy();
    expect(useOverlays.getState().open).toBe("palette");
  });

  it("openBot and jumpTo close Computer so they do not land under it (bug 46 leftover)", async () => {
    const openBot = vi.fn(async () => {});
    const jumpTo = vi.fn(async () => {});
    useUi.setState({ openBot, jumpTo } as never);
    useComputer.setState({ open: { botId: "courier" } });
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(openBot).toHaveBeenCalledWith("courier");
    expect(useComputer.getState().open).toBeNull();
    useComputer.setState({ open: { botId: "courier" } });
    fireEvent.change(screen.getByRole("textbox", { name: STR.search }), { target: { value: "invoice" } });
    fireEvent.click(await screen.findByRole("option", { name: /Ledger.*invoice.*is due/ }));
    expect(jumpTo).toHaveBeenCalledWith("ledger", "t4s1");
    expect(useComputer.getState().open).toBeNull();
  });

  it("typed search shows message results and selecting one jumps to it", async () => {
    const jumpTo = vi.fn(async () => {});
    useUi.setState({ jumpTo } as never);
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole("textbox", { name: STR.search }), { target: { value: "invoice" } });
    const row = await screen.findByRole("option", { name: /Ledger.*invoice.*is due/ });
    expect(row.querySelector("mark")?.textContent).toBe("invoice");
    fireEvent.click(row);
    expect(jumpTo).toHaveBeenCalledWith("ledger", "t4s1");
    expect(bridge.calls.some(([c]) => c === "search")).toBe(true);
  });

  it("typed queries match actions such as Show Hidden Bots", async () => {
    render(<CommandPalette />);
    fireEvent.change(screen.getByRole("textbox", { name: STR.search }), { target: { value: "hidden" } });
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(STR.showHiddenBots) }));
    expect(useOverlays.getState().open).toBe("hidden-bots");
  });

  // Phase 2 (bug 213): one action to a group call.
  it("'call scout and ledger' (or 'call scout ledger') + Enter starts one call with both", async () => {
    render(<CommandPalette />);
    const box = screen.getByRole("textbox", { name: STR.search });
    fireEvent.change(box, { target: { value: "call scout ledger" } });
    const row = await screen.findByRole("option", { name: new RegExp(STR5.paletteCallBots(["Scout", "Ledger"])) });
    expect(row.getAttribute("aria-selected")).toBe("true"); // the top row: Enter is the one action
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useVoice.getState()).toMatchObject({ openFor: "scout", adding: ["ledger"] });
    act(() => useVoice.getState().close());
    expect(useVoice.getState().adding).toEqual([]);
  });

  it("with a call already open, 'call scout ledger' brings them into it (never does nothing)", async () => {
    act(() => useVoice.getState().open("courier"));
    render(<CommandPalette />);
    const box = screen.getByRole("textbox", { name: STR.search });
    fireEvent.change(box, { target: { value: "call scout ledger" } });
    await screen.findByRole("option", { name: new RegExp(STR5.paletteCallBots(["Scout", "Ledger"])) });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useVoice.getState()).toMatchObject({ openFor: "courier", adding: ["scout", "ledger"] });
    act(() => useVoice.getState().close());
  });
});
