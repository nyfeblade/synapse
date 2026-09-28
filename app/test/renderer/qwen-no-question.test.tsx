// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { PLAIN_PAUSE_MS, QWEN_PAUSE_MS, VOICE_PAUSE_MS, pauseMsFor } from "../../src/renderer/voice/sentences";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";

/**
 * Bug 190: a Bot whose voice is Qwen3 gets no question handling anywhere. On the renderer's side
 * that is the pause: a "?" is paced exactly like a "." — on its Qwen lines (QWEN_PAUSE_MS) and on
 * the lines its Kokoro stand-in says for it (PLAIN_PAUSE_MS) — and every line it speaks tells the
 * speech side whose Bot it is (`qwenBot`), so the stand-in drops the bug-151 ramp too.
 */

describe("the pause after a Qwen Bot's question (bug 190)", () => {
  it("'?' is paced exactly like '.', on Qwen and on its Kokoro stand-in; a paragraph break is still one", () => {
    for (const t of [QWEN_PAUSE_MS, PLAIN_PAUSE_MS]) {
      expect(pauseMsFor("Shall I deploy it?", t)).toBe(pauseMsFor("Shall I deploy it.", t));
      expect(pauseMsFor("Shall I deploy it?\n", t)).toBe(t.paragraph);
    }
    expect(PLAIN_PAUSE_MS).toEqual({ ...VOICE_PAUSE_MS, question: VOICE_PAUSE_MS.period });
    // A Kokoro Bot's question keeps its own beat.
    expect(pauseMsFor("Shall I deploy it?")).toBe(VOICE_PAUSE_MS.question);
  });

  it("the loop gives a Qwen Bot's '?' line the '.' pause, and leaves any other Bot's alone", async () => {
    const run = async (qwenBot: boolean) => {
      const spoke: { text: string; pauseMs?: number; pauseMsFlow?: number }[] = [];
      const loop = new VoiceLoop({
        start: () => {}, stop: () => {}, send: () => {},
        speak: (text, o) => { spoke.push({ text, pauseMs: o?.pauseMs, pauseMsFlow: o?.pauseMsFlow }); return new Promise<void>(() => {}); },
        cancelSpeech: () => {}, now: () => 0, silenceMs: 700, helperEndpoints: true,
        naturalFlow: () => qwenBot, qwenBot: () => qwenBot,
      });
      loop.begin();
      loop.onFinal("is the build green");
      loop.onBotText("The build is green. Shall I deploy it?", "b", "e1");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      return spoke;
    };
    const q = await run(true);
    expect(q.map((s) => s.pauseMs)).toEqual([VOICE_PAUSE_MS.period, VOICE_PAUSE_MS.period]);
    expect(q.map((s) => s.pauseMsFlow)).toEqual([QWEN_PAUSE_MS.period, QWEN_PAUSE_MS.period]);
    const k = await run(false);
    expect(k.map((s) => s.pauseMs)).toEqual([VOICE_PAUSE_MS.period, VOICE_PAUSE_MS.question]);
  });
});

// ---- the overlay: what dictation.speak is actually sent ----

const NATURAL = [{ id: "af_heart", name: "Heart", accent: "American" }, { id: "bm_george", name: "George", accent: "British" }];
const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
function installBridge(mode: "light" | "full") {
  subs.clear(); invoked.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t1u", agent: {} } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        const r: Record<string, unknown> = {
          "dictation.speak": { spoken: true }, "audio.voices.list": { voices: [], chosen: null }, "kokoro.status": { state: "ready", voices: NATURAL },
          "qwen.status": { state: "ready", voices: [] }, "voiceMode.get": { mode, memoryMb: 0, machineDefault: mode },
        };
        return { ok: true, result: r[n] ?? {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
}
const bot = (id: string, name: string, voice: string) =>
  ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice, speechRate: 1, spokenLanguage: null } });

describe("a Qwen Bot's call tells the speech side whose Bot it is (bug 190)", () => {
  afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });
  const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
  const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
  const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);

  async function callAndSay(voice: string, mode: "light" | "full") {
    installBridge(mode);
    useUi.setState({ ...initialState(), bots: { a: bot("a", "Planner", voice) } } as never);
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    await act(async () => {});
    fire({ type: "final", text: "is it green" });
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t2a", createdAt: 3, message: { type: "text", content: "Shall I deploy it?" } }] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    return spoken()[0]!;
  }

  it("dropped to Light mode, its Kokoro stand-in line says so, with the '.' pause", async () => {
    const a = await callAndSay("qwen3:vivian", "light");
    expect(String(a.voice)).toMatch(/^kokoro:/);
    expect(a).toMatchObject({ qwenBot: true, pauseMs: VOICE_PAUSE_MS.period });
    // …and no greeting or stock line is pre-rendered in the stand-in voice (it would be ramped).
    expect(invoked.filter(([n]) => n === "voice.phrases.prepare")).toHaveLength(0);
  });

  it("on Qwen itself too", async () => {
    const a = await callAndSay("qwen3:vivian", "full");
    expect(a).toMatchObject({ voice: "qwen3:vivian", qwenBot: true, pauseMs: VOICE_PAUSE_MS.period, pauseMsQwen: QWEN_PAUSE_MS.period });
  });

  it("bug 222: every Qwen line names the Bot's Kokoro voice (its level, and its stand-in if Qwen isn't ready), not only lines spoken before the voices loaded", async () => {
    const a = await callAndSay("qwen3:vivian", "full");
    expect(a.fallbackVoice).toBe("kokoro:af_heart");
  });

  it("bug 221: on Qwen, its call lines (stock lines, end-of-turn sounds) are pre-rendered in its Qwen voice, held to its Kokoro voice's level", async () => {
    await callAndSay("qwen3:vivian", "full");
    const items = invoked.filter(([n]) => n === "voice.phrases.prepare").flatMap(([, x]) => x.items as { voice: string; text: string; fallback?: string }[]);
    const q = items.filter((i) => i.voice === "qwen3:vivian");
    expect(q.map((i) => i.text)).toEqual(expect.arrayContaining(["Mm-hm.", "Okay.", "Hmm."]));
    expect(q.every((i) => i.fallback === "kokoro:af_heart")).toBe(true); // the Kokoro voice it would be given
    expect(items.filter((i) => i.voice !== "qwen3:vivian")).toEqual([]); // never its stand-in's (bug 190)
    // …and the "is it rendered" question asks for the same take.
    const has = invoked.filter(([n]) => n === "voice.phrases.has").flatMap(([, x]) => x.items as { voice: string; fallback?: string }[]);
    expect(has.length).toBeGreaterThan(0);
    expect(has.every((i) => i.voice === "qwen3:vivian" && i.fallback === "kokoro:af_heart")).toBe(true);
  });

  it("a Kokoro Bot is untouched", async () => {
    const a = await callAndSay("kokoro:bm_george", "full");
    expect(a.qwenBot).toBeUndefined();
    expect(a.pauseMs).toBe(VOICE_PAUSE_MS.question);
  });
});
