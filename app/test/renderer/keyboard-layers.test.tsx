// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, STRG, STR5 } from "@synapse/shared";
import { App } from "../../src/renderer/App";
import { ComputerView } from "../../src/renderer/components/ComputerView";
import { Overlays } from "../../src/renderer/components/Overlays";
import { useComputer } from "../../src/renderer/computer-state";
import { ConnectGoogleSheet } from "../../src/renderer/google/ConnectGoogleSheet";
import { useGoogle } from "../../src/renderer/google/store";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { overlayDepth, resetOverlayStack } from "../../src/renderer/overlay-stack";
import { resetTriggerHistory } from "../../src/renderer/overlay-trigger";
import { useOverlays } from "../../src/renderer/overlays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { ExportSheet } from "../../src/renderer/templates/ExportSheet";
import { useTemplates } from "../../src/renderer/templates/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

// ---------------------------------------------------------------------------
// The ten defects the keyboard audit found by driving the real app with Playwright,
// pressing real keys and reading document.activeElement after each one. Every one of
// them is a CROSS-LAYER failure: the audit found WCAG 2.4.11 clean *within* a surface
// and every failure at the seam between two. They are retired here by the overlay
// stack and the <Dialog> primitive, not one at a time.
//
// jsdom-level: focus(), document.activeElement, focusin, Tab handling and event
// propagation are all real here — these assert the same facts Playwright asserted.
// Contract-level: nothing in this file. The two contract-level assertions in this
// change live in message-actions-keyboard.test.tsx and focus-rings.test.ts, where
// jsdom cannot match :hover / :focus-visible.
// ---------------------------------------------------------------------------

const bots = { courier: botFixture("courier", "Courier"), hidden: { ...botFixture("hidden", "Hidden One"), settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true } } };

const MKT_VIEW = {
  installed: { count: 0, logos: [] }, featuredBots: [], fromTeam: [], featuredPlugins: [], categories: [], claudeAi: { detected: false, count: 0 },
  forYou: { because: "GitHub", entries: [{ id: "curated:linear", name: "Linear", kind: "plugin", source: "curated", description: "Linear things", category: "Code", logo: null, action: "add", state: "available" }] },
};

function boot(over: Record<string, unknown> = {}) {
  installFakeBridge({ listAgents: { agents: [bots.courier], activeAgentId: "courier" }, openAgent: { agent: bots.courier }, getAgentTranscriptTail: { entries: [] }, getWorkflows: { workflows: [] } });
  Element.prototype.scrollIntoView = () => {};
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots, settings: settingsFixture(), view: { kind: "chat", botId: "courier" }, transcripts: { courier: [] }, ...over } as never);
}

afterEach(() => {
  cleanup();
  act(() => { resetOverlayStack(); useOverlays.setState({ open: null }); useMarketplace.setState({ open: false, page: "home", detailId: null } as never); useGoogle.setState({ open: false } as never); useTemplates.setState({ sheet: null } as never); useComputer.setState({ open: null } as never); });
  resetTriggerHistory();
});
beforeEach(() => boot());

/** The app's focusable set, as the keyboard sees it. */
const focusableIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")].filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);

/**
 * Press Tab n times and report every element focus landed on.
 *
 * jsdom does NOT implement Tab's own focus move, so "focus never left the dialog" is vacuous on its
 * own — focus would sit still and pass. A trap is only proven if it ACTIVELY moves focus, which is
 * what this records: the caller asserts both that the stops are inside the surface and that there
 * were several distinct ones. (Playwright's Tab does move focus, which is how the audit caught the
 * palette letting the very first Tab out.)
 */
function tabWalk(n: number): HTMLElement[] {
  const stops: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    fireEvent.keyDown(document.activeElement ?? window, { key: "Tab" });
    stops.push(document.activeElement as HTMLElement);
  }
  return stops;
}

// ---------------------------------------------------------------------------
// Defects 1 and 2: global chords fired underneath an open overlay.
// ---------------------------------------------------------------------------
describe("global chords are suppressed while an overlay is open (defects 1, 2)", () => {
  // "⌘N while Settings is open navigates the app behind the modal and puts focus in a
  //  text field under the scrim — everything typed goes somewhere invisible."
  it("⌘N does not navigate the app behind an open Settings modal", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    const dialog = await screen.findByRole("dialog", { name: STR.settings });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(useUi.getState().view.kind, "⌘N must not navigate underneath a modal").toBe("chat");
    expect(dialog.contains(document.activeElement), "focus must stay inside the modal").toBe(true);
  });

  // "⌘, while the palette is open opens Settings *underneath* it and focuses it there."
  it("⌘, does not open Settings underneath the command palette", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: STR.search });
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(useUi.getState().settingsOpen, "Settings must not open under the palette").toBe(false);
    expect(palette.contains(document.activeElement)).toBe(true);
  });

  it("still runs both chords when nothing is covering the app", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(useUi.getState().settingsOpen).toBe(true);
    act(() => useUi.getState().closeSettings());
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(useUi.getState().view.kind).toBe("new-chat");
  });
});

// ---------------------------------------------------------------------------
// Defect 3: the palette had no trap and returned focus to <body>.
// ---------------------------------------------------------------------------
describe("the command palette is a real dialog (defect 3)", () => {
  it("traps Tab: the FIRST Tab used to leave it, and the 12 stops after that were behind the scrim", async () => {
    render(<App />);
    const opener = await screen.findByRole("button", { name: STR.openAccountMenu });
    opener.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: STR.search });
    const stops = tabWalk(13);
    stops.forEach((el, i) => expect(palette.contains(el), `tab stop ${i + 1} left the palette`).toBe(true));
    // …and the trap is doing the holding, not jsdom's lack of a default Tab action: put focus on a
    // control behind the scrim and the very next Tab pulls it back in.
    opener.focus();
    expect(palette.contains(document.activeElement)).toBe(false);
    fireEvent.keyDown(opener, { key: "Tab" });
    expect(palette.contains(document.activeElement), "Tab from behind the scrim must come back in").toBe(true);
  });

  it("returns focus to what opened it, not to <body>", async () => {
    render(<App />);
    const opener = await screen.findByRole("button", { name: STR.openAccountMenu });
    opener.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: STR.search });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

// ---------------------------------------------------------------------------
// Defect 4: five surfaces put focus on <body> when they open.
// ---------------------------------------------------------------------------
describe("every surface moves focus into itself when it opens (defect 4)", () => {
  const opener = () => {
    const b = document.createElement("button");
    b.textContent = "opener";
    document.body.append(b);
    b.focus();
    return b;
  };

  it("Hidden Bots", () => {
    const o = opener();
    render(<Overlays />);
    act(() => useOverlays.getState().openOverlay("hidden-bots"));
    const d = screen.getByRole("dialog", { name: STR.hiddenBots });
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(o);
    o.remove();
  });

  it("Manage plugins and skills", async () => {
    const o = opener();
    render(<Overlays />);
    act(() => useOverlays.getState().openOverlay("skills"));
    const d = await screen.findByRole("dialog", { name: STR.managePluginsAndSkills });
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(o));
    o.remove();
  });

  it("the export sheet", async () => {
    const o = opener();
    act(() => useTemplates.setState({ sheet: { kind: "export", botId: "courier", draft: null, error: null } } as never));
    render(<ExportSheet />);
    const d = await screen.findByRole("dialog", { name: STR5.reviewTemplate });
    expect(d.contains(document.activeElement)).toBe(true);
    o.remove();
  });

  it("the Connect Google sheet", () => {
    const o = opener();
    act(() => useGoogle.setState({ open: true } as never));
    render(<ConnectGoogleSheet />);
    const d = screen.getByRole("dialog", { name: STRG.connectGoogle });
    expect(d.contains(document.activeElement)).toBe(true);
    o.remove();
  });
});

// ---------------------------------------------------------------------------
// Defect 5: Marketplace and ComputerView never moved focus in and never trapped.
// ---------------------------------------------------------------------------
describe("Marketplace and ComputerView are dialogs now (defect 5)", () => {
  it("Marketplace takes focus and holds Tab: it used to let Tab walk the whole app behind the modal", () => {
    const behind = document.createElement("button");
    document.body.append(behind);
    behind.focus();
    act(() => useMarketplace.setState({ open: true, page: "home", query: "", results: null, waiting: {}, recent: [], detailId: null, view: MKT_VIEW } as never));
    render(<MarketplaceModal />);
    const d = screen.getByRole("dialog", { name: STR5.marketplace });
    expect(d.contains(document.activeElement)).toBe(true);
    const stops = tabWalk(8);
    stops.forEach((el, i) => { expect(d.contains(el), `tab stop ${i + 1} left the modal`).toBe(true); expect(el).not.toBe(behind); });
    expect(new Set(stops).size).toBeGreaterThan(1);
    behind.remove();
  });

  // The audit listed "Marketplace detail" among the five surfaces that focus <body>. It is a page
  // change inside one dialog rather than a new layer, so the primitive cannot see it — the surface
  // has to move focus to the top of the new view itself.
  it("the Marketplace detail page takes focus instead of dropping it on <body>", () => {
    act(() => useMarketplace.setState({ open: true, page: "home", query: "", results: null, waiting: {}, recent: [], detailId: null, view: MKT_VIEW } as never));
    render(<MarketplaceModal />);
    act(() => useMarketplace.setState({ page: "detail", detailId: "curated:linear" } as never));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label"), "focus belongs at the top of the new page").toBe(STR5.back);
  });

  it("ComputerView takes focus and holds Tab", () => {
    const behind = document.createElement("button");
    document.body.append(behind);
    behind.focus();
    act(() => useComputer.setState({ open: { botId: "courier" }, displays: {} } as never));
    render(<ComputerView />);
    const d = screen.getByRole("dialog");
    expect(d.contains(document.activeElement)).toBe(true);
    const stops = tabWalk(6);
    stops.forEach((el, i) => expect(d.contains(el), `tab stop ${i + 1} left the computer view`).toBe(true));
    expect(new Set(stops).size).toBeGreaterThan(1);
    behind.remove();
  });
});

// ---------------------------------------------------------------------------
// Defect 6: one Escape closed two stacked surfaces.
// ---------------------------------------------------------------------------
describe("one Escape closes exactly one layer (defect 6)", () => {
  it("ComputerView + palette: Escape closes the palette and leaves ComputerView up", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useComputer.setState({ open: { botId: "courier" }, displays: {} } as never));
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: STR.search });
    expect(overlayDepth()).toBe(2);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: STR.search })).toBeNull());
    expect(useComputer.getState().open, "ComputerView must survive the palette's Escape").not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useComputer.getState().open).toBeNull());
  });

  it("Marketplace + Connect Google: Escape closes the sheet and leaves the Marketplace up", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useMarketplace.setState({ open: true, page: "home", query: "", results: null, waiting: {}, recent: [], detailId: null, view: MKT_VIEW } as never));
    await screen.findByRole("dialog", { name: STR5.marketplace });
    act(() => useGoogle.setState({ open: true } as never));
    await screen.findByRole("dialog", { name: STRG.connectGoogle });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useGoogle.getState().open).toBe(false));
    expect(useMarketplace.getState().open, "the Marketplace must survive the sheet's Escape").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 7: Settings opened from the account menu returned focus to <body>.
// ---------------------------------------------------------------------------
describe("the menu-opened route restores the real trigger (defect 7)", () => {
  it("Settings opened from the account menu goes back to the account button, not <body>", async () => {
    render(<App />);
    const account = await screen.findByRole("button", { name: STR.openAccountMenu });
    account.focus();
    fireEvent.click(account);
    const item = await screen.findByRole("menuitem", { name: STR.settings });
    item.focus();
    fireEvent.click(item); // the menu item unmounts in the same commit the modal mounts in
    const dialog = await screen.findByRole("dialog", { name: STR.settings });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement, "a detached menu item is not a trigger").toBe(account));
  });
});

// ---------------------------------------------------------------------------
// Defect 8: Escape inside a Settings text input threw away the whole modal.
// ---------------------------------------------------------------------------
describe("Escape in a field with pending content cancels the field, not the modal (defect 8)", () => {
  it("keeps Settings open when Escape cancels a half-typed auto-review rule", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings("auto-review")); // new-user walk finding 22: its own section
    await screen.findByRole("dialog", { name: STR.settings });
    const field = await screen.findByLabelText("Add rule"); // Safety v2: Settings → Rules' plain-English field
    fireEvent.change(field, { target: { value: "reply to emails" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value, "the field's own edit is what Escape cancels").toBe("");
    expect(useUi.getState().settingsOpen, "…and it stops there").toBe(true);
  });

  it("still closes Settings on Escape when the field is empty", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    await screen.findByRole("dialog", { name: STR.settings });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useUi.getState().settingsOpen).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// The whole point: every open surface holds every tab stop.
// ---------------------------------------------------------------------------
describe("no tab stop ever lands behind a scrim", () => {
  it("Settings holds all of them", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    const dialog = await screen.findByRole("dialog", { name: STR.settings });
    const inside = focusableIn(dialog);
    expect(inside.length).toBeGreaterThan(3);
    const stops = tabWalk(inside.length + 2);
    stops.forEach((el, i) => expect(dialog.contains(el), `tab stop ${i + 1} escaped`).toBe(true));
    expect(new Set(stops).size, "every control in the dialog is reachable").toBe(inside.length);
  });
});
