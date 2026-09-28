// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, computerTitle, type DisplayInfo, type TeachStatus } from "@synapse/shared";
import { App } from "../../src/renderer/App";
import { useComputer } from "../../src/renderer/computer-state";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

/**
 * Bug 42 (root cause of bug 5) — "Teach a task" opened its form on a surface the user cannot see.
 *
 * WHY THESE ASSERT CONTAINMENT RATHER THAN CSS VISIBILITY: jsdom has no layout engine and no
 * stacking, so `.computer-view` (position: fixed; inset: 0; opaque background; z-index 40) covering
 * a still-mounted ChatView is invisible to any jsdom assertion — a test that asserted the form is
 * merely *mounted* passes on the broken code, which is exactly the trap this file exists to avoid.
 * The user-visible claim is therefore expressed as "the form is inside the surface that is on top",
 * and the CSS contract that makes that equivalent to "the user can see it" is pinned next door in
 * teach-cover-css.test.ts (the same technique as layout-fit.test.ts).
 */

const rfb = { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect: vi.fn(), focus: vi.fn(), sendKey: vi.fn(), clipboardPasteFrom: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: () => rfb }));

const display = (botId: string, index: number): DisplayInfo => ({ botId, index, display: `:${index}`, cdpPort: 9220 + index, running: true, generation: 1 });
const rec = (p: Partial<TeachStatus> = {}): TeachStatus => ({ state: "RECORDING", botId: "a", sessionId: "teach-1", sessionDir: "/w/t", startedAtMs: Date.now(), elapsedMs: 0, goal: "File an expense", ...p });

const SCOUT = botFixture("a", "Scout");
const LEDGER = botFixture("b", "Ledger");

function boot(extra: Record<string, unknown> = {}) {
  return installFakeBridge({
    listAgents: { agents: [SCOUT, LEDGER], activeAgentId: "a" },
    openAgent: (args: never) => ({ agent: [SCOUT, LEDGER].find((x) => x.id === (args as unknown as { id: string }).id) ?? null }),
    getAgentTranscriptTail: { entries: [] },
    getAgentAutomations: { routines: [] },
    getDisplays: { displays: [display("a", 2), display("b", 3)], waiting: [] },
    ...extra,
  });
}

/** The whole app, with Scout's chat open and the computer view raised over it. */
async function appWithComputerOpen(on: "a" | "b" = "a") {
  render(<App />);
  await screen.findByPlaceholderText("Message Scout");
  await waitFor(() => expect(useComputer.getState().displays.a).toBeTruthy());
  act(() => useComputer.getState().openComputer(on));
  return screen.getByRole("dialog", { name: computerTitle() });
}

const setupForm = (root: HTMLElement = document.body) => within(root).queryAllByLabelText("The result you want");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has none; ChatView's transcript scrolls on mount
  useUi.setState({ ...initialState(), settings: settingsFixture() });
  useComputer.setState({ open: null, displays: {}, displaysLoad: "loading", displaysError: null, waiting: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("bug 42: Teach a task is reachable from the surface it was clicked on", () => {
  it("the title-bar pill opens the setup form INSIDE the full-screen computer view, not behind it", async () => {
    boot();
    const dialog = await appWithComputerOpen("a");

    fireEvent.click(within(dialog).getByRole("button", { name: STR.teachTask }));

    // The claim: a user looking at the computer view can see and use the form.
    expect(setupForm(dialog)).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Start recording" })).toBeTruthy();
    // And there is exactly one of it in the whole app — no second copy mounted under the cover.
    expect(setupForm()).toHaveLength(1);
  });

  it("the recording bar and its Stop & save are inside the computer view while recording from it", async () => {
    boot();
    const dialog = await appWithComputerOpen("a");
    act(() => { useUi.setState({ teach: rec({ botId: "a" }) }); });

    expect(within(dialog).getByText(STR.teachWatching("Scout"))).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: STR.teachStopSave })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: STR.teachStopSave })).toHaveLength(1);
  });

  it("teaching the Bot whose screen is on show, not the Bot whose chat is open", async () => {
    const bridge = boot({ startTeachRecording: { status: rec({ botId: "b", goal: "Reconcile the ledger" }) } });
    // Scout's chat is open; the monitor switcher puts Ledger's screen on the stage (CMP-09).
    const dialog = await appWithComputerOpen("b");

    fireEvent.click(within(dialog).getByRole("button", { name: STR.teachTask }));
    expect(setupForm(dialog)).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText("The result you want"), { target: { value: "Reconcile the ledger" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" })); });
    expect(bridge.calls).toContainEqual(["startTeachRecording", { id: "b", goal: "Reconcile the ledger" }]);
  });

  it("leaving the computer view without recording leaves no pending setup for a chat to pop open later", async () => {
    boot();
    const dialog = await appWithComputerOpen("b");
    fireEvent.click(within(dialog).getByRole("button", { name: STR.teachTask }));
    expect(useUi.getState().teachSetupFor).toBe("b");

    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Exit fullscreen" })); });

    expect(setupForm()).toHaveLength(0);
    expect(useUi.getState().teachSetupFor).toBeNull();
  });

  it("a recording started from the computer view can still be stopped after leaving it", async () => {
    boot();
    const dialog = await appWithComputerOpen("b");
    act(() => { useUi.setState({ teach: rec({ botId: "b" }) }); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Exit fullscreen" })); });

    // Scout's chat is what is on screen now; the one recording in the app is Ledger's (TCH-01).
    expect(screen.getByText(STR.teachWatching("Ledger"))).toBeTruthy();
    expect(screen.getAllByRole("button", { name: STR.teachStopSave })).toHaveLength(1);
  });
});

describe("bug 42, the class: a control must not mutate state owned by a surface it does not belong to", () => {
  it("every Teach entry point puts its form on the surface the user is looking at", async () => {
    // Entry point 1 of 3, the composer "+" menu (TCH-01), with no computer view up.
    boot();
    render(<App />);
    await screen.findByPlaceholderText("Message Scout");
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.teachATask }));
    expect(setupForm()).toHaveLength(1);
    cleanup();

    // Entry point 2 of 3, the screen preview's hover row in the details panel. The panel starts
    // closed (smooth pass, Task 5), so this entry point needs it open before it can be reached.
    useUi.setState({ ...initialState(), settings: settingsFixture(), panel: "details" });
    useComputer.setState({ open: null, displays: {}, displaysLoad: "loading", displaysError: null, waiting: [] });
    boot();
    render(<App />);
    await screen.findByPlaceholderText("Message Scout");
    const panel = screen.getByRole("complementary", { name: "Conversation details" });
    fireEvent.click(within(panel).getByRole("button", { name: STR.teachTask }));
    expect(setupForm()).toHaveLength(1);
    cleanup();

    // Entry point 3 of 3, the computer view's title bar — the one bug 42 was found on.
    useUi.setState({ ...initialState(), settings: settingsFixture() });
    useComputer.setState({ open: null, displays: {}, displaysLoad: "loading", displaysError: null, waiting: [] });
    boot();
    const dialog = await appWithComputerOpen("a");
    fireEvent.click(within(dialog).getByRole("button", { name: STR.teachTask }));
    expect(setupForm(dialog)).toHaveLength(1);
  });

  it("while the computer view is up, no teach UI is mounted outside it", async () => {
    boot();
    const dialog = await appWithComputerOpen("a");
    act(() => { useUi.setState({ teach: rec({ botId: "a" }), teachSetupFor: null }); });

    const inDialog = within(dialog).getAllByText(STR.teachWatching("Scout")).length;
    expect(inDialog).toBe(1);
    expect(screen.getAllByText(STR.teachWatching("Scout"))).toHaveLength(inDialog);
  });
});
