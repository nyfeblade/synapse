// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { useUi } from "../../src/renderer/store";
import { useCall } from "../../src/renderer/voice/call-store";
import { CallButton, useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { Transcript } from "../../src/renderer/components/Transcript";

// Voice calls: the header button, the call screen (timer, waveform, captions, approvals, group
// avatars), streamed speech, and the call markers in the chat.

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
const VOICES = [
  { id: "v.zoe", name: "Zoe", lang: "en-US", quality: "premium", siri: false, personal: false },
  { id: "v.ava", name: "Ava", lang: "en-US", quality: "premium", siri: false, personal: false },
];
const bot = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {}, ...over });

beforeEach(() => {
  subs.clear(); invoked.length = 0; calls.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => { calls.push([cmd, a]); return { ok: true, result: { entryId: "t1u" } }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        return { ok: true, result: n === "dictation.speak" ? { spoken: true } : n === "audio.voices.list" ? { voices: VOICES, chosen: null } : {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  useUi.setState({ ...initialState(), bots: { a: bot("a", "Planner") } } as never);
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);

describe("Start a voice call", () => {
  it("is a headset button in the chat header that opens the call", () => {
    render(<CallButton botId="a" />);
    const b = screen.getByRole("button", { name: STR5.startVoiceChat });
    expect(b.getAttribute("title")).toBe(STR5.startVoiceChat);
    fireEvent.click(b);
    expect(useVoice.getState().openFor).toBe("a");
  });
});

describe("the call screen", () => {
  it("marks the call in the chat, shows a timer, and ends with the call's length", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useVoice.getState().open("a");
    const { unmount } = render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(calls).toContainEqual(["noteVoiceCall", { id: "a", phase: "started" }]));
    expect(screen.getByTestId("call-timer").textContent).toBe("0:00");
    await act(async () => { vi.advanceTimersByTime(65_000); });
    expect(screen.getByTestId("call-timer").textContent).toBe("1:05");
    act(() => useVoice.getState().close());
    unmount();
    const ended = calls.find(([c, a]) => c === "noteVoiceCall" && a.phase === "ended")!;
    expect(ended[1].durationMs as number).toBeGreaterThanOrEqual(65_000);
    vi.useRealTimers();
  });

  it("speaks the streamed reply sentence by sentence in the Bot's voice, and captions both sides", async () => {
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    fire({ type: "final", text: "what's the plan" });
    act(() => useUi.setState({ typing: { a: { typing: true, partialText: "First we pack. Then we" } } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]).toMatchObject({ text: "First we pack.", queue: true }); // bug 153: the full stop goes with the words
    expect(["v.zoe", "v.ava"]).toContain(spoken()[0]!.voice);
    const captions = screen.getByLabelText(STR5.callCaptions);
    expect(within(captions).getByText("what's the plan")).toBeTruthy();
    expect(within(captions).getByText("First we pack.")).toBeTruthy();
    act(() => useUi.setState({ typing: { a: { typing: false, partialText: null } }, transcripts: { a: [{ kind: "send-message", id: "t2a", createdAt: 3, message: { type: "text", content: "First we pack. Then we drive." } }] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[1]).toMatchObject({ text: "Then we drive." });
    // The latency marks reach voice.log.
    fire({ type: "speak-audio", id: spoken()[0]!.id });
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.mark").map(([, a]) => a.what)).toEqual(expect.arrayContaining(["sent", "first-text", "first-audio"])));
  });

  it("the waveform follows the microphone level", async () => {
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fire({ type: "level", mic: -30, out: null });
    expect(screen.getByRole("meter", { name: STR5.callMicLevel }).getAttribute("aria-valuenow")).toBe("50");
  });

  it("the speaking Bot's mouth moves with its voice level; listening, it rests", async () => {
    let t = 0;
    const q: (() => void)[] = [];
    setAvatarClock({ now: () => t, raf: (cb) => { q.push(cb); return 1; }, caf: () => {} });
    const frames = (ms: number) => { for (let x = 0; x < ms; x += 1000 / 60) { t += 1000 / 60; const cb = q.shift(); if (cb) act(() => cb()); } };
    try {
      useVoice.getState().open("a");
      render(<VoiceOverlay botId="a" />);
      await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
      await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
      const face = () => screen.getByRole("dialog").querySelector(".voice-avatar svg")!;
      frames(300);
      expect(face().getAttribute("data-mouth")).toBe("smile");
      fire({ type: "final", text: "what's the plan" });
      act(() => useUi.setState({ typing: { a: { typing: true, partialText: "First we pack. Then we" } } } as never));
      await vi.waitFor(() => expect(spoken()).toHaveLength(1));
      fire({ type: "speak-audio", id: spoken()[0]!.id });
      await vi.waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe(STR5.speaking));
      fire({ type: "level", mic: -60, out: -12 });
      frames(300);
      expect(face().getAttribute("data-mouth")).toBe("speak");
      const ry = () => Number(face().querySelector("[data-part=mouth-fill]")!.getAttribute("d")!.match(/A([\d.]+) ([\d.]+)/)![2]);
      const loud = ry();
      fire({ type: "level", mic: -60, out: -58 });
      frames(300);
      expect(ry()).toBeLessThan(loud);
    } finally { setAvatarClock(null); }
  });

  it("an approval during the call shows its card in the call, and the Bot asks for it in one line", async () => {
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    const approval = { approvalId: "ap1", requestId: "r1", surface: "bash", title: "Run the deploy script", reason: "", summary: "deploy", locationLine: null, details: null, command: "./deploy.sh", items: [], hasProposedRule: false, status: "pending", cause: null, verdict: null, ruleAddedText: null, createdAt: 1, settledAt: null };
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t3a", createdAt: 3, message: { type: "auto-review-approval", approval } }] } } as never));
    // Bug 142: the card is read aloud as a short question (what it does, then "Should I go ahead?"), so a
    // spoken "yes" / "no" is an informed answer.
    await vi.waitFor(() => expect(spoken().map((s) => s.text).join(" ")).toContain("deploy. Should I go ahead?"));
    expect(screen.getByRole("dialog").textContent).toContain("Run the deploy script");
  });

  it("hang up is a red button that ends the call", async () => {
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    const b = screen.getByRole("button", { name: STR5.endVoiceChat });
    expect(b.className).toContain("hang-up");
    fireEvent.click(b);
    expect(useVoice.getState().openFor).toBeNull();
  });
});

describe("group call", () => {
  beforeEach(() => {
    useUi.setState({ ...initialState(), bots: { g: bot("g", "Trip", { group: { memberIds: ["n", "l", "s"] } }), n: bot("n", "Nova"), l: bot("l", "Ledger"), s: bot("s", "Scout"), x: bot("x", "Piper") } } as never);
  });

  it("shows every member, speaks each in its own voice, one at a time, and can add or remove Bots", async () => {
    useVoice.getState().open("g");
    render(<VoiceOverlay botId="g" />);
    const row = screen.getByRole("list", { name: STR5.callParticipants });
    expect(within(row).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Nova", "Ledger", "Scout"]);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    await act(async () => { await Promise.resolve(); });
    fire({ type: "final", text: "Nova and Ledger, where to" }); // bug 134: an unasked Bot would raise a hand instead
    act(() => useUi.setState({ transcripts: { g: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "n", name: "Nova" }, message: { type: "text", content: "The coast." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "The coast is cheaper in May." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1)); // Ledger waits for Nova
    fire({ type: "speak-end", id: spoken()[0]!.id, interrupted: false });
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[0]!.voice).not.toBe(spoken()[1]!.voice);
    fireEvent.click(screen.getByRole("button", { name: STR5.callRemoveBot("Scout") }));
    expect(calls).toContainEqual(["setGroupMembers", { id: "g", memberIds: ["n", "l"] }]);
    fireEvent.click(screen.getByRole("button", { name: STR5.callAddBot }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Piper" }));
    expect(calls).toContainEqual(["setGroupMembers", { id: "g", memberIds: ["n", "l", "s", "x"] }]);
  });
});

describe("an interrupted reply in the chat", () => {
  it("is cut at the last spoken sentence and marked (interrupted)", () => {
    useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t9a", createdAt: 3, message: { type: "text", content: "Once upon a time. There was a fox." } }] } } as never);
    act(() => useCall.getState().markInterrupted("t9a", "Once upon a time."));
    render(<Transcript botId="a" />);
    expect(screen.getByText("Once upon a time.")).toBeTruthy();
    expect(screen.queryByText(/There was a fox/)).toBeNull();
    expect(screen.getByText(STR5.interrupted)).toBeTruthy();
  });
});
