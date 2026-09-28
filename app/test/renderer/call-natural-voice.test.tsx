// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { VOICE_PAUSE_MS } from "../../src/renderer/voice/sentences";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

// Bug 107: in a call, Kokoro is the default engine when Ready — each Bot has its own natural voice,
// every line is cleaned up for speech and ends with a small pause, and a line Kokoro couldn't say
// (spoken by Apple instead) shows a small note.

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const NATURAL = [{ id: "af_heart", name: "Heart", accent: "American" }, { id: "bm_george", name: "George", accent: "British" }, { id: "af_bella", name: "Bella", accent: "American" }];
const bot = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {}, ...over });

beforeEach(() => {
  subs.clear(); invoked.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t1u" } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        const r: Record<string, unknown> = { "dictation.speak": { spoken: true }, "audio.voices.list": { voices: [], chosen: null }, "kokoro.status": { state: "ready", voices: NATURAL } };
        return { ok: true, result: r[n] ?? {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);

describe("a call with natural voices (bug 107)", () => {
  it("speaks each line cleaned up, in the Bot's Kokoro voice, with the sentence pause", async () => {
    useUi.setState({ ...initialState(), bots: { a: bot("a", "Planner") } } as never);
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "kokoro.status")).toBe(true));
    await act(async () => {}); // the status reply lands
    fire({ type: "final", text: "when" });
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t2a", createdAt: 3, message: { type: "text", content: "At 3:30pm 🎉 — see https://example.com/x." } }] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]).toMatchObject({ text: "At 3 30 PM — see a link.", pauseMs: VOICE_PAUSE_MS.period });
    expect(NATURAL.map((v) => `kokoro:${v.id}`)).toContain(spoken()[0]!.voice);
  });

  it("group: each Bot gets a different natural voice; a fallback shows a note", async () => {
    useUi.setState({ ...initialState(), bots: { g: bot("g", "Team", { group: { memberIds: ["n", "l"] } }), n: bot("n", "Nova"), l: bot("l", "Ledger") } } as never);
    useVoice.getState().open("g");
    render(<VoiceOverlay botId="g" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "kokoro.status")).toBe(true));
    await act(async () => {}); // the status reply lands
    fire({ type: "final", text: "hi all" });
    act(() => useUi.setState({ transcripts: { g: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "n" }, message: { type: "text", content: "Hi from Nova." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "l" }, message: { type: "text", content: "Hi from Ledger." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    fire({ type: "speak-end", id: spoken()[0]!.id, interrupted: false });
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[0]!.voice).toMatch(/^kokoro:/);
    expect(spoken()[1]!.voice).toMatch(/^kokoro:/);
    expect(spoken()[0]!.voice).not.toBe(spoken()[1]!.voice);
    fire({ type: "tts-fallback", message: "The natural voice stopped (exit 1)." });
    expect(screen.getByRole("status").textContent).toBe(STR5.naturalVoiceFellBack);
  });
});
