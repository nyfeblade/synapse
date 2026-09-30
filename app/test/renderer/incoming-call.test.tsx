// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRV, type IncomingCallView } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { IncomingCall } from "../../src/renderer/voice/IncomingCall";
import { useBotCalls } from "../../src/renderer/voice/bot-calls-store";
import * as CallSounds from "../../src/renderer/voice/call-sounds";

// The ring (call-sounds.ts) is mocked here: these tests care about WHEN it starts and stops, not
// how it synthesizes — that's call-sounds.test.ts.
vi.mock("../../src/renderer/voice/call-sounds", () => ({ startRing: vi.fn(), useCallSoundsEnabled: vi.fn(), playHangUp: vi.fn() }));

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
let policy: Record<string, unknown> = { ring: true };
const bot = (id: string, name: string) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} });
const ring = (over: Partial<IncomingCallView> = {}): IncomingCallView => ({ callId: "r1", botId: "n", reason: "The build finished. Want me to deploy?", since: 1, expiresAt: 45_001, firstCall: false, ...over });
const ringStop = vi.fn();
/** Resolved when IncomingCall sends "calls.ring": the same step in which it marks the ring ready to show. */
let onRingSent: () => void = () => {};
/** Per-call policies, answered in order (one "calls.policy" per call); empty → `policy`. */
let policies: Record<string, unknown>[] = [];

/**
 * Puts one Bot call in the list and waits, INSIDE act, for IncomingCall's policy decision to land. act
 * then flushes the render and its passive effects together, so the ring tone (useRingTone, an effect)
 * has started by the time the dialog can be seen. Waiting on the dialog alone (findByRole) races them:
 * the dialog is in the DOM a React scheduler task before the effect that starts the ring runs, and
 * findByRole's trailing setTimeout(0) can win that task (bug-log 450).
 */
async function showRing(...views: IncomingCallView[]): Promise<void> {
  if (!views.length) views = [ring()];
  let left = views.length;
  const sent = new Promise<void>((res) => { onRingSent = () => { if (--left === 0) res(); }; });
  await act(async () => { useBotCalls.getState().set(views); await sent; });
}

beforeEach(() => {
  subs.clear(); invoked.length = 0; calls.length = 0; policy = { ring: true }; policies = [];
  ringStop.mockClear();
  vi.mocked(CallSounds.useCallSoundsEnabled).mockReturnValue(true);
  vi.mocked(CallSounds.startRing).mockImplementation(() => ({ stop: ringStop }));
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      calls.push([cmd, a]);
      if (cmd === "answerBotCall") return { ok: true, result: { botId: "n", reason: "The build finished. Want me to deploy?" } };
      if (cmd === "startCall") return { ok: true, result: { callId: "c1", chatId: "n", anchorId: "n", participantIds: ["n"] } };
      if (cmd === "openAgent") return { ok: true, result: { agent: bot("n", "Nova"), entries: [], hasMore: false } };
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "calls.ring") onRingSent();
        return { ok: true, result: n === "calls.policy" ? (policies.shift() ?? policy) : n === "dictation.speak" ? { spoken: true } : {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  useUi.setState({ ...initialState(), bots: { n: bot("n", "Nova") } } as never);
  useBotCalls.setState({ calls: [], opening: null, handled: new Set() });
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const answered = () => calls.filter(([c]) => c === "answerBotCall").map(([, a]) => a);

describe("a Bot calls you", () => {
  it("rings in the app with the Bot's name, avatar and reason, and a Mac notification", async () => {
    render(<IncomingCall />);
    act(() => useBotCalls.getState().set([ring()]));
    const dlg = await screen.findByRole("alertdialog", { name: STRV.incomingCall("Nova") });
    expect(dlg.textContent).toContain("The build finished. Want me to deploy?");
    expect(screen.getByRole("button", { name: STRV.acceptCall })).toBeTruthy();
    expect(screen.getByRole("button", { name: STRV.declineCall })).toBeTruthy();
    expect(screen.getByRole("button", { name: STRV.messageInstead })).toBeTruthy();
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "calls.ring" && a.botId === "n")).toBe(true));
  });

  it("quiet hours or Focus: no ring; it's answered as missed with the reason why", async () => {
    policy = { ring: false, why: "quiet hours" };
    render(<IncomingCall />);
    act(() => useBotCalls.getState().set([ring()]));
    await vi.waitFor(() => expect(answered()).toEqual([{ callId: "r1", answer: "missed", why: "quiet hours" }]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invoked.some(([n]) => n === "calls.ring")).toBe(false);
  });

  it("0.1.4 first-run: Focus unknown (unreadable): the call rings quietly, with the sound left to macOS's notification", async () => {
    policy = { ring: true, sound: false };
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      render(<IncomingCall />);
      act(() => useBotCalls.getState().set([ring()]));
      expect(await screen.findByRole("alertdialog")).toBeTruthy();
      await vi.waitFor(() => expect(invoked.find(([n]) => n === "calls.ring")?.[1]).toMatchObject({ botId: "n", osSound: true }));
      expect(CallSounds.startRing).not.toHaveBeenCalled();
    } finally { focus.mockRestore(); }
  });

  it("Focus known off: the app's own ring plays and the notification stays silent", async () => {
    policy = { ring: true, sound: true };
    render(<IncomingCall />);
    act(() => useBotCalls.getState().set([ring()]));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "calls.ring")).toBe(true));
    expect(invoked.find(([n]) => n === "calls.ring")?.[1].osSound).toBeUndefined();
    await vi.waitFor(() => expect(CallSounds.startRing).toHaveBeenCalled());
  });

  it("decline and message-instead answer the host; a first call can be refused for good", async () => {
    render(<IncomingCall />);
    act(() => useBotCalls.getState().set([ring({ firstCall: true })]));
    expect((await screen.findByRole("alertdialog")).textContent).toContain(STRV.firstCallNote("Nova"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRV.dontAllowCalls("Nova") })); });
    expect(answered()).toEqual([{ callId: "r1", answer: "decline", allow: false }]);
    act(() => useBotCalls.getState().set([ring({ callId: "r2" })]));
    const msg = await screen.findByRole("button", { name: STRV.messageInstead });
    await act(async () => { fireEvent.click(msg); });
    expect(answered()[1]).toEqual({ callId: "r2", answer: "message" });
    act(() => useBotCalls.getState().set([ring({ callId: "r3" })]));
    const decline = await screen.findByRole("button", { name: STRV.declineCall });
    await act(async () => { fireEvent.click(decline); });
    expect(answered()[2]).toEqual({ callId: "r3", answer: "decline" });
  });

  it("accept starts the voice call with that Bot, and the Bot opens with why it called", async () => {
    render(<><IncomingCall /><VoiceOverlay botId="n" /></>);
    act(() => useBotCalls.getState().set([ring()]));
    const accept = await screen.findByRole("button", { name: STRV.acceptCall });
    await act(async () => { fireEvent.click(accept); });
    expect(answered()).toEqual([{ callId: "r1", answer: "accept" }]);
    await vi.waitFor(() => expect(useVoice.getState().openFor).toBe("n"));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    const sessionId = invoked.find(([n]) => n === "dictation.start")![1].sessionId;
    act(() => subs.get("dictation")!({ sessionId, type: "ready" }));
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a.text).join(" ")).toContain("The build finished"));
    expect(useBotCalls.getState().opening).toBeNull();
  });
});

describe("the ring while a Bot's call sits unanswered", () => {
  it("starts once the ring shows, and stops (with its fade) the instant the user accepts", async () => {
    render(<><IncomingCall /><VoiceOverlay botId="n" /></>);
    await showRing();
    const accept = screen.getByRole("button", { name: STRV.acceptCall });
    expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
    expect(ringStop).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(accept); });
    expect(ringStop).toHaveBeenCalledTimes(1);
  });

  it("stops on decline", async () => {
    render(<IncomingCall />);
    await showRing();
    const decline = screen.getByRole("button", { name: STRV.declineCall });
    expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(decline); });
    expect(ringStop).toHaveBeenCalledTimes(1);
  });

  it("stops when the host times out an unanswered ring or the Bot withdraws it (both just clear the list)", async () => {
    render(<IncomingCall />);
    await showRing();
    screen.getByRole("alertdialog");
    expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
    // The host publishes the calls list without this ring, on a 30 s timeout (missed) exactly as it
    // would on a withdrawal — the app doesn't tell the two apart, so it can't ring after either.
    act(() => useBotCalls.getState().set([]));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(ringStop).toHaveBeenCalledTimes(1);
  });

  it("a queued call gets its own ring: a quiet call, then a normal one, rings once the normal one shows", async () => {
    policies = [{ ring: true, sound: false }, { ring: true, sound: true }];
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      render(<IncomingCall />);
      await showRing(ring({ callId: "r1" }), ring({ callId: "r2" }));
      expect(CallSounds.startRing).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRV.declineCall })); });
      expect(answered()).toEqual([{ callId: "r1", answer: "decline" }]);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
    } finally { focus.mockRestore(); }
  });

  it("a queued call gets its own ring: a normal call, then a quiet one, goes silent once the quiet one shows", async () => {
    policies = [{ ring: true, sound: true }, { ring: true, sound: false }];
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      render(<IncomingCall />);
      await showRing(ring({ callId: "r1" }), ring({ callId: "r2" }));
      expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRV.declineCall })); });
      expect(answered()).toEqual([{ callId: "r1", answer: "decline" }]);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(ringStop).toHaveBeenCalledTimes(1);
      expect(CallSounds.startRing).toHaveBeenCalledTimes(1);
    } finally { focus.mockRestore(); }
  });

  it("never rings when Settings → Voice, 'Call sounds' is off", async () => {
    vi.mocked(CallSounds.useCallSoundsEnabled).mockReturnValue(false);
    render(<IncomingCall />);
    await showRing();
    screen.getByRole("alertdialog");
    expect(CallSounds.startRing).not.toHaveBeenCalled();
  });

  it("never rings under quiet hours / Focus — the call is answered as missed before the ring can show", async () => {
    policy = { ring: false, why: "Focus is on" };
    render(<IncomingCall />);
    act(() => useBotCalls.getState().set([ring()]));
    await vi.waitFor(() => expect(answered()).toEqual([{ callId: "r1", answer: "missed", why: "Focus is on" }]));
    expect(CallSounds.startRing).not.toHaveBeenCalled();
  });
});
