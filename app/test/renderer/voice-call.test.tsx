// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

/**
 * Bug 101: voice mode is "like a call" — continuous listening, the helper decides end of turn,
 * the reply is spoken by the helper (through the echo-cancelled audio path), barge-in cuts the
 * Bot off, and mute / end call are real controls.
 */
function harness(o: { helperEndpoints?: boolean } = {}) {
  const log: string[] = [];
  const h = { now: 0, log, finishSpeech: () => {}, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t) => { log.push(`send:${t}`); },
    speak: (t) => { log.push(`speak:${t}`); return new Promise<void>((r) => { h.finishSpeech = r; }); },
    cancelSpeech: () => { log.push("cancel"); h.finishSpeech(); },
    mute: (m) => log.push(m ? "mute" : "unmute"),
    now: () => h.now, silenceMs: 1200, helperEndpoints: o.helperEndpoints,
  });
  return h;
}

describe("VoiceLoop as a call (bug 101)", () => {
  it("with helper end-of-turn, a pause never stops the helper; the helper's final is the turn", () => {
    const h = harness({ helperEndpoints: true });
    h.loop.begin();
    h.now = 100; h.loop.onPartial("what's on my");
    h.now = 5_000; h.loop.tick();
    expect(h.log).toEqual(["start"]);
    h.loop.onFinal("what's on my calendar");
    expect(h.log).toEqual(["start", "send:what's on my calendar"]);
    expect(h.loop.state).toBe("thinking");
  });

  it("the helper stays up through the reply: no respawn to speak, and listening resumes on the same helper", async () => {
    const h = harness({ helperEndpoints: true });
    h.loop.begin();
    h.loop.onFinal("hello");
    h.loop.onBotText("Hi there.");
    await Promise.resolve();
    expect(h.loop.state).toBe("speaking");
    expect(h.log.filter((l) => l === "start")).toHaveLength(1);
    h.finishSpeech();
    await vi.waitFor(() => expect(h.loop.state).toBe("listening"));
    expect(h.log.filter((l) => l === "start")).toHaveLength(1);
  });

  it("speech-start while the Bot speaks is a barge-in: speech is cancelled and the loop listens", async () => {
    const h = harness({ helperEndpoints: true });
    h.loop.begin();
    h.loop.onFinal("tell me a story");
    h.loop.onBotText("Once upon a time. There was a fox.");
    await Promise.resolve();
    h.loop.onSpeechStart();
    expect(h.log).toContain("cancel");
    expect(h.loop.state).toBe("listening");
  });

  it("a barge-in reported by the helper does the same", async () => {
    const h = harness({ helperEndpoints: true });
    h.loop.begin();
    h.loop.onFinal("tell me a story");
    h.loop.onBotText("Once upon a time.");
    await Promise.resolve();
    h.loop.onBargeIn();
    expect(h.loop.state).toBe("listening");
  });

  it("mute is a real control on the helper, and is undone on unmute", () => {
    const h = harness({ helperEndpoints: true });
    h.loop.begin();
    h.loop.setMuted(true);
    expect(h.loop.muted).toBe(true);
    h.loop.setMuted(false);
    expect(h.log).toEqual(["start", "mute", "unmute"]);
  });
});

describe("VoiceOverlay call UI (bug 101)", () => {
  const subs = new Map<string, (p: unknown) => void>();
  const invoked: [string, Record<string, unknown>][] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const webSpeak = vi.fn();
  beforeEach(() => {
    subs.clear(); invoked.length = 0; calls.length = 0; webSpeak.mockClear();
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: webSpeak, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
    (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (cmd: string, a: Record<string, unknown>) => { calls.push([cmd, a]); return { ok: true, result: { entryId: "t1u" } }; }),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: {
        invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: n === "dictation.speak" ? { spoken: true } : {} }; }),
        on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
      },
    };
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice: "Ava", speechRate: 1.25, spokenLanguage: "en-US" } } } as never });
    useVoice.getState().open("a");
  });
  afterEach(() => { useVoice.getState().close(); cleanup(); });
  const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: (invoked.find(([n]) => n === "dictation.start")![1]).sessionId, ...e }));
  const state = () => screen.getByTestId("voice-state").textContent;

  it("opens a call-mode helper and walks listening → thinking → speaking → listening, speaking through the helper", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    expect(invoked.find(([n]) => n === "dictation.start")![1]).toMatchObject({ mode: "call", locale: "en-US" });
    expect(state()).toBe(STR5.listening);
    fire({ type: "speech-start" });
    fire({ type: "partial", text: "what's on my" });
    expect(screen.getByTestId("voice-heard").textContent).toBe("what's on my");
    fire({ type: "final", text: "what's on my calendar" });
    await vi.waitFor(() => expect(state()).toBe(STR5.voiceThinking));
    expect(calls.find(([c]) => c === "sendPrompt")![1]).toMatchObject({ id: "a", text: "what's on my calendar", voice: { call: true } });
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t1a", createdAt: 2, message: { type: "text", content: "You have **two** meetings." } }] } } as never));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.speak")).toBe(true));
    const speak = invoked.find(([n]) => n === "dictation.speak")![1];
    expect(speak).toMatchObject({ text: "You have two meetings.", voice: "Ava", rate: 1.25, lang: "en-US" });
    await vi.waitFor(() => expect(state()).toBe(STR5.speaking));
    expect(webSpeak).not.toHaveBeenCalled();
    fire({ type: "speak-end", id: speak.id, interrupted: false });
    await vi.waitFor(() => expect(state()).toBe(STR5.listening));
    expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1); // the same helper, still listening
  });

  it("mute and end call are real buttons", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    const mute = screen.getByRole("button", { name: STR5.voiceMute });
    fireEvent.click(mute);
    await vi.waitFor(() => expect(invoked.at(-1)).toEqual(["dictation.mute", expect.objectContaining({ muted: true })]));
    expect(screen.getByRole("button", { name: STR5.voiceUnmute }).getAttribute("aria-pressed")).toBe("true");
    expect(state()).toBe(STR5.voiceMuted);
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBeNull();
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.stop")).toBe(true));
  });

  it("a microphone that sends no audio ends the call with its reason (no silent stop)", async () => {
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    fire({ type: "error", code: "no-audio", message: "The microphone isn't sending any sound (config-change, restarted 4 times)." });
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("microphone isn't sending any sound"));
  });

  it("falls back to the system voice in the page when the helper can't speak", async () => {
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: n === "dictation.speak" ? { spoken: false } : {} }; });
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    fire({ type: "final", text: "hi" });
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t1a", createdAt: 2, message: { type: "text", content: "Hello." } }] } } as never));
    await vi.waitFor(() => expect(webSpeak).toHaveBeenCalled());
  });
});
