// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, STRC, computerTitle } from "@synapse/shared";
import { App } from "../../src/renderer/App";
import { useComputer } from "../../src/renderer/computer-state";
import { overlayDepth, resetOverlayStack, topOverlay } from "../../src/renderer/overlay-stack";
import { resetTriggerHistory } from "../../src/renderer/overlay-trigger";
import { useOverlays } from "../../src/renderer/overlays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice } from "../../src/renderer/voice/VoiceOverlay";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

// ---------------------------------------------------------------------------
// Bug 31, the behaviour — the three biggest surfaces, driven TWO AT A TIME.
//
// overlay-stack.test.tsx proves the primitive against synthetic <Dialog>s, and
// keyboard-layers.test.tsx proves each surface on its own. Neither drives two of the
// app's three biggest surfaces together, and "who is on top when one opens over
// another" is the only question bug 31 is actually about. Everything here opens a real
// surface over another real surface and then presses a real key.
//
// The three, and what each of them is:
//   SettingsModal  <Dialog>            — the primitive's markup and behaviour.
//   ComputerView   useOverlayLayer     — draws its own full-window frame (no scrim).
//   VoiceOverlay   useOverlayLayer     — draws its own scrim and panel.
// All three are on the stack. What was never asserted is that the stack's order and the
// order the user SEES agree: the stack ranks layers by the moment they pushed, and the
// stylesheet ranks them by z-index, and nothing tied the two together. A layer can be
// top of the stack — owning Escape and the focus trap — while painting underneath the
// layer the user is looking at.
// ---------------------------------------------------------------------------

const bots = { courier: botFixture("courier", "Courier") };

function boot() {
  installFakeBridge({ listAgents: { agents: [bots.courier], activeAgentId: "courier" }, openAgent: { agent: bots.courier }, getAgentTranscriptTail: { entries: [] }, getWorkflows: { workflows: [] } });
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots, settings: settingsFixture(), view: { kind: "chat", botId: "courier" }, transcripts: { courier: [] } } as never);
}

beforeEach(() => boot());
afterEach(() => {
  cleanup();
  act(() => { resetOverlayStack(); useOverlays.setState({ open: null }); useComputer.setState({ open: null } as never); useVoice.getState().close(); });
  resetTriggerHistory();
});

const settingsDialog = () => screen.queryByRole("dialog", { name: STR.settings });
const computerDialog = () => screen.queryByRole("dialog", { name: computerTitle() });
const voiceDialog = () => screen.queryByRole("dialog", { name: STR5.startVoiceChat });

/** The panel of whichever layer currently owns Escape. */
function topPanel(): HTMLElement | null {
  const id = topOverlay();
  if (!id) return null;
  for (const d of screen.queryAllByRole("dialog")) if (document.activeElement && d.contains(document.activeElement)) return d;
  return null;
}

describe("bug 31 — Settings over the computer view", () => {
  it("Escape closes Settings and leaves the computer view up; the next Escape closes the computer view", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useComputer.getState().openComputer("courier"));
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    expect(overlayDepth(), "both surfaces must be on the one stack").toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(settingsDialog()).toBeNull());
    expect(useComputer.getState().open, "the computer view must survive Settings' Escape").not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useComputer.getState().open).toBeNull());
    expect(overlayDepth()).toBe(0);
  });

  it("keeps Settings on top when the computer view opens underneath it: Escape still closes Settings first", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    // The Take-over route (BoxHelpCard) and a display event can both flip `open` while Settings is
    // up. The computer view paints at z-index 40, under the .scrim Settings lives in at 50 — so
    // whichever pushed last, the layer the user can SEE is Settings, and Escape belongs to it.
    act(() => useComputer.getState().openComputer("courier"));
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    expect(overlayDepth()).toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(settingsDialog()).toBeNull());
    expect(useComputer.getState().open, "Escape must not reach past the surface on top of it").not.toBeNull();
  });

  it("keeps focus in the surface the user can see, not in the one underneath it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    act(() => useComputer.getState().openComputer("courier"));
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    expect(settingsDialog()!.contains(document.activeElement), "focus belongs in the visible layer, not behind the scrim").toBe(true);
    expect(topPanel()).toBe(settingsDialog());
  });
});

describe("bug 31 — Settings over the voice overlay", () => {
  /** Opens voice mode from the real control: Composer's round dark button. */
  async function openVoice(): Promise<HTMLElement> {
    const opener = await screen.findByRole("button", { name: STR5.startVoiceChat });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(voiceDialog()).not.toBeNull());
    return opener;
  }

  it("Escape closes Settings and leaves voice mode running; the next Escape ends voice mode", async () => {
    render(<App />);
    const account = await screen.findByRole("button", { name: STR.openAccountMenu });
    await openVoice();
    account.focus();
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    expect(overlayDepth()).toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(settingsDialog()).toBeNull());
    expect(useVoice.getState().openFor, "voice mode must survive Settings' Escape").toBe("courier");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useVoice.getState().openFor).toBeNull());
  });

  // The voice overlay's scrim is `position: absolute` inside `.main`, so the sidebar stays live
  // while it is up — that is how the account button is reachable to open Settings over it at all.
  // Settings therefore hands focus back to a control the voice overlay does NOT cover, and the
  // primitive deliberately does not take it away again ("does not steal focus back if the user has
  // already moved it somewhere else", overlay-stack.test.tsx). What must never happen is the thing
  // the audit found five times over: the unwind ending on <body>.
  it("unwinds without ever stranding focus on <body>", async () => {
    render(<App />);
    const account = await screen.findByRole("button", { name: STR.openAccountMenu });
    await openVoice();
    account.focus();
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement, "Settings goes back to the account button").toBe(account));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useVoice.getState().openFor).toBeNull());
    const landed = document.activeElement as HTMLElement;
    expect(landed, "the unwind must not end on <body>").not.toBe(document.body);
    expect(landed.isConnected, "…nor on a node that has left the document").toBe(true);
  });

  it("one Escape per layer: two stacked surfaces are never closed by one press", async () => {
    render(<App />);
    const account = await screen.findByRole("button", { name: STR.openAccountMenu });
    await openVoice();
    account.focus();
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    const before = overlayDepth();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(overlayDepth()).toBe(before - 1));
  });
});

describe("bug 31 — the computer view is the page layer, and says so", () => {
  it("a transient surface opened over it goes on top of it, whichever pushed last", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useUi.getState().openSettings());
    await waitFor(() => expect(settingsDialog()).not.toBeNull());
    const settingsId = topOverlay();
    act(() => useComputer.getState().openComputer("courier"));
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    expect(topOverlay(), "the page-level computer view never covers a modal").toBe(settingsId);
  });

  // The reachable stacked pair over the computer view: ⌘K is deliberately not suppressed, so the
  // palette is the one surface a user can raise from inside it. Both openers are real controls.
  it("gives each layer back to the control that opened it, innermost first", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    const glyph = await screen.findByRole("button", { name: STRC.computerGlyph });
    glyph.focus();
    fireEvent.click(glyph);
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: STR.search });
    expect(overlayDepth()).toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: STR.search })).toBeNull());
    expect(useComputer.getState().open, "the palette's Escape stops at the palette").not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useComputer.getState().open).toBeNull());
    await waitFor(() => expect(document.activeElement, "the computer view goes back to the glyph that opened it").toBe(screen.getByRole("button", { name: STRC.computerGlyph })));
  });

  it("and it is still a layer: opened on its own it owns Escape", async () => {
    render(<App />);
    await screen.findByRole("button", { name: STR.openAccountMenu });
    act(() => useComputer.getState().openComputer("courier"));
    await waitFor(() => expect(computerDialog()).not.toBeNull());
    expect(overlayDepth()).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useComputer.getState().open).toBeNull());
  });
});
