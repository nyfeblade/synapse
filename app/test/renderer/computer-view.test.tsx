// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITSC, STRC, type BoxHelpView, type TranscriptEntry } from "@synapse/shared";
import { useComputer } from "../../src/renderer/computer-state";
import { useUi } from "../../src/renderer/store";
import { ComputerView, pendingBoxHelp } from "../../src/renderer/components/ComputerView";
import { ctrlChord, isMacChord } from "../../src/renderer/vnc/keys";

// Matches RfbLike's `(e: CustomEvent) => void` rather than a looser `(e?: Event)`: noVNC really
// does dispatch CustomEvents, so the narrower type is the faithful one and the widened mock was
// only ever hiding a mismatch from the compiler.
type Listener = (e: CustomEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const rfb = {
  viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "",
  disconnect: vi.fn(), focus: vi.fn(), sendKey: vi.fn(), clipboardPasteFrom: vi.fn(),
  addEventListener: (type: string, fn: Listener) => {
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(fn);
  },
  removeEventListener: (type: string, fn: Listener) => { listeners.get(type)?.delete(fn); },
};
function emitRfb(type: string): void {
  for (const fn of listeners.get(type) ?? []) fn(new CustomEvent(type));
}
const dialed = vi.hoisted(() => [] as string[]);
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: (_el: HTMLElement, url: string) => (dialed.push(url), rfb) }));

const req = (over: Partial<BoxHelpView> = {}): BoxHelpView => ({ id: "bh_1", botId: "b", instruction: "Sign in to Northwind Air", reason: "auth", domain: null, idpDomain: null, screenshotDataUrl: null, status: "pending", inControl: true, createdAt: 1, settledAt: null, ...over });
const entry = (r: BoxHelpView): TranscriptEntry => ({ kind: "send-message", id: "t3s1", requestId: "r", createdAt: 1, message: { type: "box-help", request: r } });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("computer view (CMP-09, CMP-18)", () => {
  const calls: { cmd: string; args: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    listeners.clear();
    dialed.length = 0;
    rfb.disconnect.mockClear();
    (window as unknown as { synapse: unknown }).synapse = {
      vncUrl: () => "ws://x", call: async (cmd: string, args: unknown) => { calls.push({ cmd, args }); return { ok: true, result: { request: req() } }; },
    };
    useUi.setState({ bots: { b: { id: "b", profile: { name: "Scout", avatarShape: "pebble", avatarColor: "#3472d9" } } } as never, transcripts: { b: [entry(req())] } as never });
    useComputer.setState({ open: { botId: "b" }, displays: { b: { botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 } } });
  });

  it("new-user walk finding 14: with no run and nobody driving it says Idle, and one screen has no ':2' button", () => {
    useUi.setState({ transcripts: { b: [] } as never });
    render(<ComputerView />);
    expect(screen.getByText(STRC.idle)).toBeTruthy();
    expect(screen.queryByText(/in use/)).toBeNull();
    expect(screen.queryByRole("button", { name: ":2" })).toBeNull();
  });

  it("new-user walk finding 14: several screens are named by their Bots", () => {
    useUi.setState({ transcripts: { b: [] } as never, bots: { b: { id: "b", profile: { name: "Scout", avatarShape: "pebble", avatarColor: "#3472d9" } }, c: { id: "c", profile: { name: "Ledger", avatarShape: "pebble", avatarColor: "#3472d9" } } } as never });
    useComputer.setState({ displays: { b: { botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 }, c: { botId: "c", index: 3, display: ":3", cdpPort: 9225, running: true, generation: 1 } } });
    render(<ComputerView />);
    expect(screen.getByRole("button", { name: "Ledger" })).toBeTruthy();
    expect(screen.queryByText(":3")).toBeNull();
  });

  it("shows the title bar, the in-control status bar, and hands back with I'm done", async () => {
    render(<ComputerView />);
    expect(screen.getByRole("dialog", { name: "Bots' computer" })).toBeTruthy();
    expect(screen.getByText("Scout")).toBeTruthy();
    expect(screen.getByText("Bots' computer, in use")).toBeTruthy();
    // Phase 4 (integration): the title-bar pill is the real TeachPill now, enabled for a one-to-one Bot.
    expect((screen.getByRole("button", { name: "Teach a task" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("You're in control")).toBeTruthy();
    expect(screen.getByText("Scout is paused until you hand it back")).toBeTruthy();
    expect(rfb.viewOnly).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "I'm done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual({ cmd: "handBackForeverBox", args: { id: "b", requestId: "bh_1", outcome: "done" } });
    expect(useComputer.getState().open).toBeNull();
  });

  it("a Bot without a screen isn't dialed (fuzz: Open computer on a 4th Bot → VNC 502); it connects once assigned", async () => {
    const { act } = await import("@testing-library/react");
    dialed.length = 0;
    useComputer.setState({ displays: {} });
    render(<ComputerView />);
    expect(dialed).toEqual([]);
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [{ botId: "b", index: 3, display: ":3", cdpPort: 9225, running: true, generation: 1 }], waiting: [] } }));
    expect(dialed).toEqual(["ws://x"]);
  });

  it("Exit fullscreen returns to the chat without handing back", () => {
    render(<ComputerView />);
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(calls).toEqual([]);
    expect(useComputer.getState().open).toBeNull();
  });

  it("Escape closes the computer view and returns focus to the trigger (controller ruling 3)", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    render(<ComputerView />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useComputer.getState().open).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("offers Take over when a request is pending but the user isn't driving yet", async () => {
    useUi.setState({ transcripts: { b: [entry(req({ inControl: false }))] } as never });
    render(<ComputerView />);
    expect(rfb.viewOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual({ cmd: "setTakeoverActive", args: { id: "b", requestId: "bh_1", active: true } });
  });

  it("maps Cmd chords to Ctrl and finds the pending request", () => {
    expect(isMacChord({ metaKey: true, key: "v" })).toBe("v");
    expect(isMacChord({ metaKey: true, key: "q" })).toBeNull();
    const r = { ...rfb, sendKey: vi.fn() };
    ctrlChord(r, "c");
    expect(r.sendKey.mock.calls).toEqual([[0xffe3, "ControlLeft", true], [0x63, "KeyC", true], [0x63, "KeyC", false], [0xffe3, "ControlLeft", false]]);
    expect(pendingBoxHelp([entry(req({ status: "handed_back" }))])).toBeNull();
  });

  it("names a failed VNC dial and offers Retry (bug 38)", () => {
    render(<ComputerView />);
    expect(screen.getByText(STRC.connecting)).toBeTruthy();
    act(() => emitRfb("disconnect"));
    expect(screen.getByText(STRC.cantReach)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a 15s VNC timeout is the same failure as a dropped dial (bug 38)", () => {
    vi.useFakeTimers();
    render(<ComputerView />);
    expect(screen.getByText(STRC.connecting)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(LIMITSC.previewStatusTimeoutMs); });
    expect(screen.getByText(STRC.cantReach)).toBeTruthy();
  });

  it("while in control, Tab inside the live canvas is not trapped (bug 32)", () => {
    render(<ComputerView />);
    const canvas = document.querySelector(".cv-canvas") as HTMLElement;
    canvas.focus();
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement, "Tab must reach the remote, not the next chrome control").toBe(canvas);
  });

  it("F6 moves focus from the live canvas to the title bar, where Tab is trapped again (bug 32)", () => {
    render(<ComputerView />);
    const canvas = document.querySelector(".cv-canvas") as HTMLElement;
    canvas.focus();
    fireEvent.keyDown(window, { key: "F6" });
    const bar = document.querySelector(".cv-titlebar") as HTMLElement;
    expect(bar.contains(document.activeElement)).toBe(true);
    const before = document.activeElement;
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).not.toBe(before);
    expect(document.querySelector(".computer-view")!.contains(document.activeElement)).toBe(true);
  });

  // Bug 32, the way OUT. Tab belongs to the remote while the user drives it, so a keyboard user needs
  // a key that leaves — and one they can find without already knowing it. DESIGN DECISION (the
  // research is silent): ⌘Esc releases the keyboard to the app's controls, stated on screen in the
  // in-control bar as "⌘ Esc  Release keyboard". F6 (the platform's next-pane key) does the same, but
  // it cannot be the advertised one: on a Mac laptop F6 is a media key without fn. ⌘Esc is free on
  // macOS (⌘⌥Esc is Force Quit, not this) and is not a chord the remote is sent (isMacChord maps
  // only ⌘A/C/V/X/Z). noVNC's key handler is on the canvas; `remoteKeys` stands in for it.
  const remoteKeys = (canvas: HTMLElement) => {
    const seen: string[] = [];
    canvas.addEventListener("keydown", (e) => seen.push(`${e.metaKey ? "Meta+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`));
    return seen;
  };

  it("while in control, the way out of the remote is on screen and names its key (bug 32)", () => {
    render(<ComputerView />);
    const hint = screen.getByText(STRC.releaseKeyboard);
    expect(hint.closest(".cv-status"), "the hint lives in the in-control bar the user is already looking at").toBeTruthy();
    expect(hint.closest(".cv-leave-hint")!.textContent, "it names the key, not just the outcome").toContain("Esc");
    const canvas = document.querySelector(".cv-canvas") as HTMLElement;
    const described = (canvas.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(described, "a screen-reader user focused on the remote hears the way out too").toContain(STRC.releaseKeyboard);
  });

  it("the way-out hint is not shown while only watching — Tab is the app's then", () => {
    useUi.setState({ transcripts: { b: [] } as never });
    render(<ComputerView />);
    expect(screen.queryByText(STRC.releaseKeyboard)).toBeNull();
  });

  it("⌘Esc releases the keyboard: focus goes to the title bar, the remote never sees it, the view stays open (bug 32)", () => {
    render(<ComputerView />);
    const canvas = document.querySelector(".cv-canvas") as HTMLElement;
    const seen = remoteKeys(canvas);
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Escape", metaKey: true });
    expect(document.querySelector(".cv-titlebar")!.contains(document.activeElement), "focus is back on the app's controls").toBe(true);
    expect(seen, "the release chord must not also be typed on the Bot's Mac").toEqual([]);
    expect(useComputer.getState().open, "releasing the keyboard is not closing the view").toEqual({ botId: "b" });
  });

  it("F6 never reaches the remote either, and Tab / Shift+Tab inside the canvas do (bug 32)", () => {
    render(<ComputerView />);
    const canvas = document.querySelector(".cv-canvas") as HTMLElement;
    const seen = remoteKeys(canvas);
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Tab" });
    fireEvent.keyDown(canvas, { key: "Tab", shiftKey: true });
    expect(document.activeElement, "both Tabs stay on the remote").toBe(canvas);
    fireEvent.keyDown(canvas, { key: "F6" });
    expect(seen).toEqual(["Tab", "Shift+Tab"]);
  });

  it("a dial that connects clears the note, and one that drops LATER is named with a Retry that redials (bug 38)", () => {
    render(<ComputerView />);
    act(() => emitRfb("connect"));
    expect(screen.queryByText(STRC.connecting), "a live picture carries no note").toBeNull();
    expect(screen.queryByText(STRC.cantReach)).toBeNull();
    act(() => emitRfb("disconnect"));
    expect(screen.getByText(STRC.cantReach), "a session that drops mid-view is named, not left frozen").toBeTruthy();
    const before = dialed.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(dialed.length, "Retry dials again").toBe(before + 1);
    expect(screen.getByText(STRC.connecting)).toBeTruthy();
  });

  it("does not put a Terminal control in the app chrome — the terminal is on the box dock", () => {
    render(<ComputerView />);
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("CMP-06: opening the computer without a box-help request still offers Take over", async () => {
    useUi.setState({ transcripts: { b: [] } as never });
    render(<ComputerView />);
    expect(rfb.viewOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(rfb.viewOnly).toBe(false);
    expect(calls).toEqual([]);
    expect(screen.getByText("You're in control")).toBeTruthy();
    expect(screen.queryByText("Scout is paused until you hand it back")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I'm done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(rfb.viewOnly).toBe(true);
    expect(useComputer.getState().open).toEqual({ botId: "b" });
    expect(calls).toEqual([]);
  });

  describe("headless: the window is hidden (minimized, hidden, fully covered)", () => {
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    };
    afterEach(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); });

    it("while only watching, the VNC connection closes when hidden and redials when shown again", () => {
      useUi.setState({ transcripts: { b: [] } as never });
      render(<ComputerView />);
      expect(dialed).toHaveLength(1);
      setHidden(true);
      expect(rfb.disconnect).toHaveBeenCalledTimes(1);
      expect(dialed, "no redial while hidden").toHaveLength(1);
      setHidden(false);
      expect(dialed).toHaveLength(2);
    });

    it("while the user is in control, hiding the window keeps the connection (the Bot is paused on the user)", () => {
      render(<ComputerView />);
      expect(screen.getByText("You're in control")).toBeTruthy();
      setHidden(true);
      expect(rfb.disconnect).not.toHaveBeenCalled();
      expect(dialed).toHaveLength(1);
    });
  });
});

