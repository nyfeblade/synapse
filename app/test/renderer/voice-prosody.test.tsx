// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { pauseMsFor, SentenceChunker, VOICE_PAUSE_MS } from "../../src/renderer/voice/sentences";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

/**
 * Prosody on a call ("it feels worse now"): the words reach the voice with their own punctuation, the
 * pause after a line is the mark it ends on, a question is always its own chunk, and a long answer is
 * handed over a few sentences at a time instead of as one wall of audio (voice.log, call 6a3ca1b6).
 */

describe("the pause table", () => {
  it("is the punctuation the line ends on, not one flat number", () => {
    expect(pauseMsFor("Hold on,")).toBe(VOICE_PAUSE_MS.comma);
    expect(pauseMsFor("Two things;")).toBe(VOICE_PAUSE_MS.comma);
    expect(pauseMsFor("Here it is —")).toBe(VOICE_PAUSE_MS.comma);
    expect(pauseMsFor("The build passed.")).toBe(VOICE_PAUSE_MS.period);
    expect(pauseMsFor("Shall I send it?")).toBe(VOICE_PAUSE_MS.question);
    expect(pauseMsFor("Done!")).toBe(VOICE_PAUSE_MS.exclaim);
    expect(pauseMsFor("That's the lot.\n")).toBe(VOICE_PAUSE_MS.paragraph);
    expect([VOICE_PAUSE_MS.comma, VOICE_PAUSE_MS.period, VOICE_PAUSE_MS.question, VOICE_PAUSE_MS.paragraph]).toEqual([90, 220, 220, 380]); // bug 224: a "?" is paced like a "."
  });

  it("a closing quote doesn't hide the mark, and every pause is an integer the helper accepts", () => {
    expect(pauseMsFor('He said "yes."')).toBe(VOICE_PAUSE_MS.period);
    expect(pauseMsFor('And then "what now?"')).toBe(VOICE_PAUSE_MS.question);
    for (const ms of Object.values(VOICE_PAUSE_MS)) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(1_000);
    }
  });
});

describe("chunks the voice can shape", () => {
  it("never hands over a chunk that ends bare", () => {
    const c = new SentenceChunker();
    for (const line of [...c.push("Three things\n- one\n- two\n"), ...c.finish("Three things\n- one\n- two\nthat is all")]) {
      expect(line.trim()).toMatch(/[.,!?;:–—]$/);
    }
  });

  it("a question is its own chunk, and keeps its question mark", () => {
    const c = new SentenceChunker({ firstClause: true });
    const out = c.finish("I checked the calendar. Do you want me to move the afternoon one? I can do that.");
    expect(out).toEqual(["I checked the calendar.", "Do you want me to move the afternoon one?", "I can do that."]);
    expect(out.filter((l) => l.includes("?"))).toEqual(["Do you want me to move the afternoon one?"]);
  });

  it("'?' and '!' are never stripped, whether the reply streams or arrives whole", () => {
    const c = new SentenceChunker();
    expect(c.push("Ready? ")).toEqual(["Ready?"]);
    expect(c.push("Ready? Off we go! ")).toEqual(["Off we go!"]);
    expect(new SentenceChunker().finish("Well? Go!")).toEqual(["Well?", "Go!"]);
  });

  it("chunking is sentence-level: a short opening sentence is never cut, and a question never is", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.push("Sure, I can text Sam for you, just give me")).toEqual([]);
    expect(c.push("Sure, I can text Sam for you, just give me a second. And")).toEqual(["Sure, I can text Sam for you, just give me a second."]);
    const q = new SentenceChunker({ firstClause: true });
    expect(q.push("Do you want me to move the afternoon one, the one with the lawyers, or leave it where it is and ")).toEqual([]);
  });

  it("only a sentence that has proved long is cut, at its own comma, and the rest of it goes as one chunk", () => {
    const c = new SentenceChunker({ firstClause: true });
    const long = "I don't have tomorrow's schedule back yet, so I can't confirm which one that is — give me a sec and I'll have the full rundown for you.";
    const out = c.push(`${long.slice(0, 120)}`);
    expect(out).toEqual(["I don't have tomorrow's schedule back yet, so I can't confirm which one that is —"]);
    expect(c.finish(long)).toEqual(["give me a sec and I'll have the full rundown for you."]);
  });
});

// ---- the loop: what actually reaches the speak call ----

function harness(extra: { naturalFlow?: (botId: string) => boolean } = {}) {
  const spoke: { text: string; pauseMs?: number; pauseMsFlow?: number }[] = [];
  const pending: (() => void)[] = [];
  const h = { now: 0, spoke, pending, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => {}, stop: () => {}, send: () => {},
    speak: (text, o) => { spoke.push({ text, pauseMs: o?.pauseMs, pauseMsFlow: o?.pauseMsFlow }); return new Promise<void>((r) => pending.push(r)); },
    cancelSpeech: () => {}, now: () => h.now, silenceMs: 700, helperEndpoints: true, ...extra,
  });
  return h;
}
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe("what the speak call is given", () => {
  it("a question reaches speech with its '?' and the question pause; a statement with its full stop", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("is the build green");
    h.loop.onBotText("The build is green. Shall I deploy it?", "b", "e1");
    await settle();
    expect(h.spoke).toEqual([
      { text: "The build is green.", pauseMs: VOICE_PAUSE_MS.period },
      { text: "Shall I deploy it?", pauseMs: VOICE_PAUSE_MS.question },
    ]);
  });

  it("a paragraph break is a real gap", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("status");
    h.loop.onBotText("That's the deploy done.\n\nSeparately, the invoice went out.", "b", "e1");
    await settle();
    expect(h.spoke[0]).toEqual({ text: "That's the deploy done.", pauseMs: VOICE_PAUSE_MS.paragraph });
  });

  /**
   * Bug 166: a Bot whose voice renders its own phrasing gets the reply in bigger pieces, and every
   * line carries BOTH pauses — the speech side is the only place that knows whether this line really
   * went to that voice or to the Kokoro one the reply opens in while the big model is cold.
   */
  it("a Bot that phrases for itself gets grouped lines and both pauses", async () => {
    const h = harness({ naturalFlow: () => true });
    h.loop.begin();
    h.loop.onFinal("what happened");
    h.loop.onBotText("Right. Revenue was up nine percent. Churn came down. I can write it up tonight.", "b", "e1");
    await settle();
    // The opening line still goes alone, so first audio is exactly as early as it always was…
    expect(h.spoke[0]!.text).toBe("Right.");
    // …and the rest goes as one render, so the model's own line carries across the sentence ends.
    expect(h.spoke[1]!.text).toBe("Revenue was up nine percent. Churn came down. I can write it up tonight.");
    // The Kokoro beat is still there for the opener, which is the voice the reply opens in…
    expect(h.spoke[0]!.pauseMs).toBe(VOICE_PAUSE_MS.period);
    // …and the near-zero one rides along for whichever lines Qwen actually takes.
    expect(h.spoke.map((s) => s.pauseMsFlow)).toEqual([0, 0]);
  });

  it("a Bot with an ordinary voice is untouched: a sentence a line, and one pause", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what happened");
    h.loop.onBotText("Right. Revenue was up nine percent. Churn came down.", "b", "e1");
    await settle();
    expect(h.spoke.map((s) => s.text)).toEqual(["Right.", "Revenue was up nine percent.", "Churn came down."]);
    expect(h.spoke.every((s) => s.pauseMsFlow === undefined)).toBe(true);
  });
});

// ---- 6a3ca1b6: nine sentences (sp-11..sp-19) queued in the same millisecond ----

const NINE = Array.from({ length: 9 }, (_, i) => `Sentence number ${i + 1} of the result.`).join(" ");

describe("a long result is paced, not poured", () => {
  it("a nine-sentence result is not nine speak calls at once", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what did you find");
    h.loop.onBotText(NINE, "b", "e1");
    await settle();
    expect(h.spoke).toHaveLength(3); // was 9, all in the same millisecond
    // Each batch is handed over as the one before it plays out, so the audio never runs dry…
    for (let i = 0; i < 9 && h.pending.length; i++) { h.pending.shift()!(); await settle(); }
    expect(h.spoke).toHaveLength(9);
    expect(h.spoke.map((s) => s.text)).toEqual(NINE.split(/(?<=\.)\s+/));
  });

  it("…and a barge-in in the middle of one still stops everything that was coming", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what did you find");
    h.loop.onBotText(NINE, "b", "e1");
    await settle();
    expect(h.spoke).toHaveLength(3);
    h.loop.onSpeechStart(); // the user talks over sentence 2 of 9
    await settle();
    expect(h.loop.state).toBe("listening");
    for (const p of h.pending.splice(0)) p();
    await settle();
    expect(h.spoke).toHaveLength(3); // the other six were never handed to the helper
  });
});

// ---- end to end: the overlay's native speak call ----

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];

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
        const r: Record<string, unknown> = { "dictation.speak": { spoken: true }, "audio.voices.list": { voices: [], chosen: null }, "kokoro.status": { state: "idle", voices: [] } };
        return { ok: true, result: r[n] ?? {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);

describe("end to end, through the overlay", () => {
  it("the '?' survives all the way to dictation.speak, with the question pause", async () => {
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} } } } as never);
    useVoice.getState().open("a");
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    act(() => subs.get("dictation")!({ sessionId: sid(), type: "final", text: "when" }));
    act(() => useUi.setState({ transcripts: { a: [{ kind: "send-message", id: "t2a", createdAt: 3, message: { type: "text", content: "It's at 4. Does that still work for you?" } }] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[0]).toMatchObject({ text: "It's at 4.", pauseMs: VOICE_PAUSE_MS.period });
    expect(spoken()[1]).toMatchObject({ text: "Does that still work for you?", pauseMs: VOICE_PAUSE_MS.question });
  });
});

// ---- what sentence-level chunking costs (the reason clause starts are all but off) ----

/**
 * Replays the twelve replies of the one approved real-model run (fixtures/voice-fast-path-replies.json) word
 * by word, the way the model streams them, and measures how much LATER the first speakable chunk appears
 * when the opening clause is not cut. Output rate is the only free variable, so it is reported over the
 * plausible range; the decision (no clause start for an ordinary reply) rests on the p50.
 */
// The app project's cwd is app/ under vitest and the repo root under a plain node run.
const REPLIES_FILE = existsSync("test/fixtures/voice-fast-path-replies.json") ? "test/fixtures/voice-fast-path-replies.json" : "app/test/fixtures/voice-fast-path-replies.json";
const REPLIES: string[] = (JSON.parse(readFileSync(REPLIES_FILE, "utf8")) as { replies: string[] }).replies;

/** Chars of a reply that must have streamed in before the chunker hands over its first line. */
function firstLineAt(text: string, firstClause: boolean): number {
  const words = text.split(/(\s+)/);
  let acc = "";
  for (const w of words) {
    acc += w;
    if (new SentenceChunker({ firstClause }).push(acc).length) return acc.length;
  }
  return text.length;
}
const CHARS_PER_TOKEN = 4;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;

describe("the cost of waiting for the whole sentence (measured on the real run)", () => {
  it("is under 300 ms for the median reply, so ordinary replies are never cut at a clause", () => {
    const deltas = REPLIES.map((t) => firstLineAt(t, false) - firstLineAt(t, true));
    expect(deltas.every((d) => d >= 0)).toBe(true);
    const ms = (chars: number, rate: number) => (chars / CHARS_PER_TOKEN / rate) * 1_000;
    // 50 output tokens a second is the middle of the plausible range for this model.
    expect(Math.round(pct(deltas.map((d) => ms(d, 50)), 0.5))).toBeLessThan(300);
    // Nine of the twelve replies are not cut at all now: their first sentence ends before word 19.
    expect(deltas.filter((d) => d === 0)).toHaveLength(9);
  });
});
