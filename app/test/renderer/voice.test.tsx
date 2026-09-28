// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS5, STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { formatClock } from "../../src/renderer/transcript-items";
import { languageOptions, plainText } from "../../src/renderer/voice/tts";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { VoiceSettings } from "../../src/renderer/voice/VoiceSettings";

describe("speech helpers", () => {
  it("strips markdown for speech and names languages in their own words", () => {
    expect(plainText("**Done.** See [the doc](https://x.y) and `code`.\n- one\n- two")).toBe("Done. See the doc and code. one. two");
    expect(languageOptions([{ name: "Majed", lang: "ar-EG" }, { name: "Samantha", lang: "en-US" }, { name: "Alex", lang: "en-US" }])).toEqual([{ lang: "ar-EG", label: "Arabic (Egypt)" }, { lang: "en-US", label: "English (United States)" }]);
    expect(formatClock(91_000)).toBe("01:31");
  });
});

describe("VoiceLoop (CHAT-08)", () => {
  it("sends after silence, speaks the Bot's reply, and barge-in cancels speech", async () => {
    let now = 0;
    const log: string[] = [];
    let finishSpeech: () => void = () => {};
    const loop = new VoiceLoop({ start: () => log.push("start"), stop: () => log.push("stop"), send: (t, d) => log.push(`send:${t}:${d}`), speak: (t) => { log.push(`speak:${t}`); return new Promise<void>((r) => { finishSpeech = r; }); }, cancelSpeech: () => { log.push("cancel"); finishSpeech(); }, now: () => now, silenceMs: 1200 });
    loop.begin();
    now = 100; loop.onPartial("what's on");
    now = 900; loop.onPartial("what's on my calendar");
    now = 2200; loop.tick();
    expect(log).toEqual(["start", "stop"]);
    loop.onFinal("what's on my calendar");
    expect(log.at(-1)).toBe("send:what's on my calendar:800");
    expect(loop.state).toBe("thinking");
    loop.onBotText("You have **two** meetings.");
    await Promise.resolve();
    expect(log).toContain("speak:You have two meetings.");
    expect(loop.state).toBe("speaking");
    expect(log).toContain("start");
    loop.onPartial("wait");
    expect(log).toContain("cancel");
    loop.end();
    expect(loop.state).toBe("idle");
  });
});

describe("voice settings card (B5–B7)", () => {
  beforeEach(() => {
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [{ name: "Samantha", lang: "en-US" }, { name: "Daniel", lang: "en-GB" }], addEventListener: () => {}, removeEventListener: () => {} };
    (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async () => ({ ok: true, result: { agent: {} } })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} } };
    useUi.setState({ ...initialState(), bots: {
      a: { id: "a", profile: { name: "Planner" }, settings: { voice: null, speechRate: 1, spokenLanguage: null } },
      b: { id: "b", profile: { name: "Courier" }, settings: { voice: "Daniel" } },
    } as never });
  });
  afterEach(cleanup);

  it("lists Not set first, marks voices used by other Bots, and saves changes", async () => {
    render(<VoiceSettings botId="a" />);
    const voice = screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
    expect(voice.options[0]!.textContent).toBe("Not set");
    expect([...voice.options].find((o) => o.value === "Daniel")!.title).toBe("Used by Courier");
    fireEvent.change(screen.getByRole("combobox", { name: "Speed" }), { target: { value: "1.5" } });
    await vi.waitFor(() => expect(window.synapse.call).toHaveBeenCalledWith("setAgentVoice", { id: "a", speechRate: 1.5 }));
    expect([...(screen.getByRole("combobox", { name: "Speed" }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["0.75x", "1x", "1.25x", "1.5x", "2x"]);
    expect((screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement).options[0]!.textContent).toBe("Auto-detect");
  });
});

// ---------------------------------------------------------------------------
// Voice-mode restart (user report: "voice chat and dictation don't work properly").
// Apple's SFSpeechRecognizer ends a session with {"type":"error","message":"No speech
// detected"} then {"type":"end"} after a stretch of silence, and the helper process exits.
// The overlay used to drop both, leaving the loop "listening" with no helper behind it —
// voice mode was dead until the overlay was closed and reopened.
// ---------------------------------------------------------------------------
function loopHarness(silenceMs = 1200) {
  const log: string[] = [];
  const notified: string[] = [];
  const h = { now: 0, log, notified, finishSpeech: () => {}, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"),
    stop: () => log.push("stop"),
    send: (t) => log.push(`send:${t}`),
    speak: (t) => { log.push(`speak:${t}`); return new Promise<void>((r) => { h.finishSpeech = r; }); },
    cancelSpeech: () => { log.push("cancel"); h.finishSpeech(); },
    now: () => h.now,
    silenceMs,
    notify: (m) => notified.push(m),
  });
  return h;
}
const starts = (log: string[]) => log.filter((x) => x === "start").length;

describe("VoiceLoop helper restart (voice mode bug)", () => {
  it("restarts listening when the helper ends on silence", () => {
    const h = loopHarness();
    h.loop.begin();
    h.now = 9_000;
    h.loop.onSessionEnd();
    h.loop.tick();
    expect(h.loop.state).toBe("listening");
    expect(starts(h.log)).toBe(2);
    expect(h.notified).toEqual([]);
  });

  it("treats 'No speech detected' as a benign end and coalesces the error+end pair into one restart", () => {
    const h = loopHarness();
    h.loop.begin();
    h.now = 9_000;
    h.loop.onSessionEnd("No speech detected");
    h.loop.onSessionEnd();
    h.loop.tick();
    expect(h.loop.state).toBe("listening");
    expect(starts(h.log)).toBe(2);
    expect(h.notified).toEqual([]);
  });

  it("does not restart or corrupt the state while sending or speaking", async () => {
    const h = loopHarness();
    h.loop.begin();
    h.now = 100; h.loop.onPartial("what's on my calendar");
    h.now = 2_000; h.loop.tick();
    h.loop.onFinal("what's on my calendar");
    expect(h.loop.state).toBe("thinking");
    const beforeSending = starts(h.log);
    h.now = 2_010; h.loop.onSessionEnd(); h.loop.tick();
    expect(h.loop.state).toBe("thinking");
    expect(starts(h.log)).toBe(beforeSending);

    h.loop.onBotText("You have two meetings.");
    await Promise.resolve();
    expect(h.loop.state).toBe("speaking");
    const beforeSpeaking = starts(h.log);
    h.now = 2_020; h.loop.onSessionEnd(); h.loop.tick();
    expect(h.loop.state).toBe("speaking");
    expect(starts(h.log)).toBe(beforeSpeaking);
    expect(h.notified).toEqual([]);
    // Once the reply has been spoken the loop must come back with a live helper, not the dead
    // one that exited mid-speech.
    h.finishSpeech();
    await vi.waitFor(() => expect(h.loop.state).toBe("listening"));
    expect(starts(h.log)).toBe(beforeSpeaking + 1);
  });

  it("surfaces a real permission error and stops", () => {
    const h = loopHarness();
    h.loop.begin();
    h.now = 300;
    h.loop.onSessionEnd("not-authorized: speech recognition is off");
    h.loop.tick();
    expect(h.loop.state).toBe("idle");
    expect(h.notified).toEqual([STR5.micDenied]);
    expect(starts(h.log)).toBe(1);
  });

  it("caps consecutive empty restarts instead of spinning, and resets the count after real speech", () => {
    const h = loopHarness();
    h.loop.begin();
    for (let i = 0; i < LIMITS5.voiceRestartCap + 4; i++) {
      h.now += 20;
      h.loop.onSessionEnd("No speech detected");
      h.loop.tick();
    }
    expect(starts(h.log)).toBe(LIMITS5.voiceRestartCap);
    expect(h.loop.state).toBe("idle");
    expect(h.notified).toEqual([STR5.voiceRestartFailed]);

    const g = loopHarness();
    g.loop.begin();
    for (let i = 0; i < LIMITS5.voiceRestartCap - 1; i++) {
      g.now += 20;
      g.loop.onSessionEnd("No speech detected");
      g.loop.tick();
    }
    expect(g.loop.state).toBe("listening");
    g.now += 20;
    g.loop.onPartial("hello there");
    g.now += 20;
    g.loop.onSessionEnd("No speech detected");
    g.loop.tick();
    expect(g.loop.state).toBe("listening");
    expect(g.notified).toEqual([]);
  });

  it("does not count a normal long silent session towards the restart cap", () => {
    const h = loopHarness();
    h.loop.begin();
    for (let i = 0; i < LIMITS5.voiceRestartCap + 4; i++) {
      h.now += LIMITS5.voiceRestartWindowMs * 3;
      h.loop.onSessionEnd("No speech detected");
      h.loop.tick();
    }
    expect(h.loop.state).toBe("listening");
    expect(h.notified).toEqual([]);
  });
});

describe("VoiceOverlay wires the dictation channel to the loop", () => {
  const subs = new Map<string, (p: unknown) => void>();
  const invoked: [string, unknown][] = [];
  beforeEach(() => {
    subs.clear();
    invoked.length = 0;
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async () => ({ ok: true, result: {} })),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: {
        invoke: vi.fn(async (n: string, a: unknown) => { invoked.push([n, a]); return { ok: true, result: {} }; }),
        on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
      },
    };
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice: null, speechRate: 1, spokenLanguage: null } } } as never });
    useVoice.getState().open("a");
  });
  afterEach(() => { useVoice.getState().close(); cleanup(); });

  it("restarts the helper when it exits on silence and surfaces a real error", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    act(() => { subs.get("dictation")!({ type: "error", message: "No speech detected" }); subs.get("dictation")!({ type: "end" }); });
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => subs.get("dictation")!({ type: "error", message: "not-authorized" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STR5.micDenied));
  });

  it("a denied microphone shows its message and a button to the Microphone privacy pane (bug 99)", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    act(() => subs.get("dictation")!({ type: "error", message: "permission:microphone:denied" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STR5.micAccessDenied));
    fireEvent.click(screen.getByRole("button", { name: STR5.openPrivacySettings }));
    expect(invoked).toContainEqual(["openPrivacySettings", { pane: "microphone" }]);
  });

  it("a non-permission error shows no settings button", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    act(() => subs.get("dictation")!({ type: "error", message: "Recognition failed" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Recognition failed"));
    expect(screen.queryByRole("button", { name: STR5.openPrivacySettings })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `sending` used to be a dead end: the loop left it only on a `send-message`
// transcript entry of type "text". A rejected send, or a Bot reply that isn't
// text (a card, a widget, an attachment), left the loop in "sending" forever —
// no helper, no timeout, microphone dead, voice mode silently over.
// ---------------------------------------------------------------------------
function sendHarness(send: (text: string, durationMs: number) => unknown) {
  const log: string[] = [];
  const notified: string[] = [];
  const h = { now: 0, log, notified, finishSpeech: () => {}, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"),
    stop: () => log.push("stop"),
    send: (t, d) => { log.push(`send:${t}`); return send(t, d); },
    speak: (t) => { log.push(`speak:${t}`); return new Promise<void>((r) => { h.finishSpeech = r; }); },
    cancelSpeech: () => { log.push("cancel"); h.finishSpeech(); },
    now: () => h.now,
    silenceMs: 1200,
    notify: (m) => notified.push(m),
  });
  return h;
}
/** Speak one utterance and let the silence timer finalize it, leaving the loop in "sending". */
function utterance(h: ReturnType<typeof sendHarness>, text: string): void {
  h.loop.begin();
  h.now = 100; h.loop.onPartial(text);
  h.now = 2_000; h.loop.tick();
  h.loop.onFinal(text);
}

describe("VoiceLoop bounded sending (voice mode dead end)", () => {
  it("bounds the wait for a reply with a deliberate, generous timeout", () => {
    expect(typeof LIMITS5.voiceSendTimeoutMs).toBe("number");
    // Long enough that an ordinary Bot turn (including short tool use) is never cut short,
    // short enough that the microphone is not dead for minutes.
    expect(LIMITS5.voiceSendTimeoutMs).toBeGreaterThanOrEqual(20_000);
    expect(LIMITS5.voiceSendTimeoutMs).toBeLessThanOrEqual(90_000);
  });

  it("recovers and tells the user when the send itself rejects", async () => {
    const h = sendHarness(() => Promise.reject(new Error("gateway down")));
    utterance(h, "what's on my calendar");
    expect(h.loop.state).toBe("thinking");
    const startsBefore = starts(h.log);
    await vi.waitFor(() => expect(h.loop.state).toBe("listening"));
    expect(starts(h.log)).toBe(startsBefore + 1); // the helper is listening again
    expect(h.notified).toEqual([STR5.voiceSendFailed]);
  });

  it("recovers after the timeout when the reply never comes back as text", () => {
    const h = sendHarness(() => {});
    utterance(h, "show me the weather");
    const startsBefore = starts(h.log);

    // A legitimately slow Bot must NOT be cut short.
    h.now = 2_000 + 30_000; h.loop.tick();
    expect(h.loop.state).toBe("thinking");
    expect(starts(h.log)).toBe(startsBefore);
    expect(h.notified).toEqual([]);

    // But the wait is bounded: past the timeout the microphone comes back.
    h.now = 2_000 + 50_000; h.loop.tick();
    expect(h.loop.state).toBe("listening");
    expect(starts(h.log)).toBe(startsBefore + 1);
    expect(h.notified).toEqual([STR5.voiceNoSpokenReply]);
  });

  it("speaks a slow reply that arrives before the timeout, without restarting anything", async () => {
    const h = sendHarness(() => {});
    utterance(h, "summarize my inbox");
    const startsBefore = starts(h.log);
    h.now = 2_000 + 30_000; h.loop.tick();
    expect(h.loop.state).toBe("thinking");
    h.loop.onBotText("You have **three** unread threads.");
    await vi.waitFor(() => expect(h.loop.state).toBe("speaking"));
    expect(h.log).toContain("speak:You have three unread threads.");
    expect(h.notified).toEqual([]);
    expect(starts(h.log)).toBe(startsBefore + 1); // the barge-in helper drain() starts, nothing else
  });

  it("still speaks a reply that arrives after the loop has already recovered", async () => {
    const h = sendHarness(() => {});
    utterance(h, "anything else");
    h.now = 2_000 + 50_000; h.loop.tick();
    expect(h.loop.state).toBe("listening");
    h.loop.onBotText("Nothing else.");
    await vi.waitFor(() => expect(h.loop.state).toBe("speaking"));
    expect(h.log).toContain("speak:Nothing else."); // plainText() drops the trailing full stop
  });

  it("does not time out a send the loop has already left", async () => {
    const h = sendHarness(() => {});
    utterance(h, "hello");
    h.loop.onBotText("Hi.");
    await vi.waitFor(() => expect(h.loop.state).toBe("speaking"));
    h.now = 2_000 + 50_000; h.loop.tick();
    // The send timeout never fires once speech began. (The line itself, never reported as ended, is
    // let go by the voice-stall line deadline, so the call is back to listening, not "thinking".)
    expect(h.loop.state).not.toBe("thinking");
    expect(h.notified).toEqual([]);
  });
});

describe("VoiceOverlay survives a failed send", () => {
  const subs = new Map<string, (p: unknown) => void>();
  const invoked: [string, unknown][] = [];
  beforeEach(() => {
    subs.clear();
    invoked.length = 0;
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (cmd: string) => (cmd === "sendPrompt" ? { ok: false, error: { code: "GATEWAY_DOWN", message: "no route" } } : { ok: true, result: {} })),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: {
        invoke: vi.fn(async (n: string, a: unknown) => { invoked.push([n, a]); return { ok: true, result: {} }; }),
        on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
      },
    };
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice: null, speechRate: 1, spokenLanguage: null } } } as never });
    useVoice.getState().open("a");
  });
  afterEach(() => { useVoice.getState().close(); cleanup(); });

  it("tells the user and starts listening again when sendPrompt rejects", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    act(() => subs.get("dictation")!({ type: "final", text: "what's on my calendar" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STR5.voiceSendFailed));
    expect(screen.getByRole("alert").className).toContain("voice-fault");
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(2));
    // ... and the fault line gets out of the way once the user speaks again.
    act(() => subs.get("dictation")!({ type: "partial", text: "try again" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
