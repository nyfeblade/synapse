import { beforeAll, describe, expect, it } from "vitest";
import { VoiceLoop } from "../../../app/src/renderer/voice/voice-loop";
import fixture from "./fixtures/voice-budget.json";
import likely58 from "./fixtures/voice-budget-likely-5.8.json";
import { joins, pct, runCall, stageSummary, summary } from "./voice-budget-harness";

// The voice latency budget (speed plan §4; test-reports/voice-smooth). A whole 1:1 fast-path call on a fake clock,
// through the real VoiceLoop, SentenceChunker and host VoiceFronts, with the user's own measured turn taking,
// time to first text and speech timings (voice-budget-harness.ts). Deterministic: no model, no network, no audio.
//
// BASELINE (before voice-smooth, 108 turns): answer audio p50 2,516 / p90 4,510 ms after the end of speech;
// any audio p50 2,481 / p90 2,846; a filler on 20% of turns; the Bot audible over the user 3 times; 1.78 voice
// runs a turn. The user's real calls: answer p50 2,548 / p90 4,591, any p50 2,471 / p90 3,544, fillers 25%.
// The pins below only ever tighten.
//
// call-behaviour (plan items 3 + 10, bugs 242/243): on the 18 recorded cut-ins (the user paused, the helper closed the
// turn, the user went on) the harness used to count the Bot's reply to the FRAGMENT — often spoken over the user's
// continuation — as "the answer" and as "first audio". It now writes a fragment's reply in capitals and measures the
// answer to the whole thought. Re-measured the same way, the code before this branch gives answer p50 2,477 / p90
// 4,337 and any-audio p50 1,831 (turns without a cut-in: 1,831 / 2,725; answers 2,528 / 4,234; cut-ins' answer p50
// 2,386, worst 15,551). This branch: 2,477 / 4,563 (p90: the cut-in answers that used to take 10-15 s now land at
// ~5 s, around the 90th percentile); no-cut-in turns unchanged (answers 2,528 / 4,234, any audio 1,831 / 2,696);
// cut-ins p50 2,341, worst 5,271. The whole-call any-audio p50 (1,863) is higher only because the fragment's reply is
// no longer spoken over the user on the cut-in turns.

type Result = Awaited<ReturnType<typeof runCall>>;
let call: Result;
beforeAll(async () => { call = await runCall(); }, 120_000);

describe("voice latency budget: the composed call", () => {
  it("answer audio after the end of speech stays inside its pin (target: 1,200 ms p50 with the sound)", () => {
    const s = summary(call);
    console.log(JSON.stringify(s));
    expect(s.turns).toBe(108);
    expect(s.answerP50!).toBeLessThanOrEqual(2_477); // 2,401 counted a fragment's reply (see the top)
    expect(s.answerP50Whole!).toBeLessThanOrEqual(2_528);
    expect(s.answerP90Whole!).toBeLessThanOrEqual(4_234);
    expect(s.answerP50CutIn!).toBeLessThanOrEqual(2_386);
    expect(s.answerMaxCutIn).toBeLessThanOrEqual(5_300); // was 15,551: the whole thought waited behind a barge-in
  });

  it("the opening line stays as short as it is (p90 81 characters; the plan wants 60 — a chunker change, not made here)", () => {
    const firsts = call.turns.map((t) => call.lines.find((l) => !l.phrase && l.audioStart !== null && l.audioStart - t.speechEnd === t.answerAudio)?.text.length ?? null);
    expect(pct(firsts, 0.9)!).toBeLessThanOrEqual(81);
  });

  it("speed plan #7: a filler never holds back a ready answer (it fades the moment the first answer line is ready)", async () => {
    // The worst case measured on the user's calls: the filler starts at 1,500 ms and the text lands ~100 ms later.
    const r = await runCall({ rounds: 1, acks: false, firstTextMs: () => 1_400 });
    const filled = r.turns.filter((t) => t.phrases.includes("filler") && t.answerAudio !== null);
    expect(filled.length).toBeGreaterThan(10);
    for (const t of filled) {
      const first = r.lines.find((l) => !l.phrase && l.audioStart === t.speechEnd + t.answerAudio!)!;
      const tts = 70 + 5 * first.text.length; // the answer's own render (fixture model)
      expect(t.answerQueuedToAudio! - tts, t.id).toBeLessThanOrEqual(150);
    }
  }, 60_000);

  it("guards: no more talking over the user, no more voice runs a turn, no more fillers", () => {
    const s = summary(call);
    expect(s.overUser).toBe(0); // 3 before plan item 3
    // 1.78 before bug 217; 1.676 before call-behaviour. +2 runs in 108 turns: a continuation's early start (plan item
    // 10) that trailing words cancelled after it had reached the voice (l6-Samantha, twice).
    expect(s.frontRunsPerTurn).toBeLessThanOrEqual(1.695);
    expect(s.fillerRate).toBeLessThanOrEqual(0.21);
  });
});

describe("speed plan #8a: the speculative start is made on the SETTLED text", () => {
  /** A bare loop: what it asks the host to speculate, cancel and send. */
  function bare() {
    const log: string[] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const h = { now: 0, log, loop: null as unknown as VoiceLoop };
    h.loop = new VoiceLoop({
      start: () => {}, stop: () => {}, send: (t, _d, x) => { log.push(`send:${t}${x?.speculated ? " (speculated)" : ""}`); },
      speak: () => Promise.resolve(), cancelSpeech: () => {}, now: () => h.now, silenceMs: 700, helperEndpoints: true,
      speculate: (t) => log.push(`speculate:${t}`), cancelSpeculation: () => log.push("cancel"),
      after: (ms, fn) => { timers.push({ at: h.now + ms, fn }); },
    });
    const advance = (ms: number) => {
      const end = h.now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        h.now = t.at;
        t.fn();
      }
      h.now = end;
    };
    h.loop.begin();
    return { ...h, advance };
  }

  it("Apple's trailing partial 20 ms after the likely end: one speculation on the full words, nothing cancelled, kept", () => {
    const h = bare();
    h.loop.onPartial("what's on my");
    h.loop.onLikelyEnd("what's on my");
    h.advance(20);
    h.loop.onPartial("what's on my calendar");
    h.advance(500);
    h.loop.onFinal("What's on my calendar?");
    expect(h.log).toEqual(["speculate:what's on my calendar", "send:What's on my calendar? (speculated)"]);
  });

  it("new words 300 ms after the start: the stale start is cancelled and the settled words get a second one, which is kept", () => {
    const h = bare();
    h.loop.onLikelyEnd("book a table");
    h.advance(300);
    h.loop.onPartial("book a table for four");
    h.advance(400);
    h.loop.onFinal("Book a table for four.");
    expect(h.log).toEqual(["speculate:book a table", "cancel", "speculate:book a table for four", "send:Book a table for four. (speculated)"]);
  });

  it("at most two starts a turn: a user who keeps talking is not chased", () => {
    const h = bare();
    h.loop.onLikelyEnd("so I was thinking");
    h.advance(300);
    h.loop.onPartial("so I was thinking maybe");
    h.advance(300);
    h.loop.onPartial("so I was thinking maybe we should");
    h.advance(300);
    h.loop.onPartial("so I was thinking maybe we should move it");
    h.advance(300);
    h.loop.onFinal("So I was thinking maybe we should move it.");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toHaveLength(2);
    expect(h.log.at(-1)).toBe("send:So I was thinking maybe we should move it.");
  });

  it("the composed call keeps more speculative starts and cancels fewer", () => {
    const s = summary(call);
    expect(s.kept / s.turns).toBeGreaterThanOrEqual(0.75);
    expect(s.cancels).toBeLessThanOrEqual(57); // was 66; kept 49 -> 85 of 108 (56: one more in a barge over the bug-218 sound; 57: plan item 10, see above)
  });
});

describe("5.8: a fresh start at the real end, after the user went on from a mid-thought likely end", () => {
  function bare() {
    const log: string[] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const h = { now: 0, log, loop: null as unknown as VoiceLoop };
    h.loop = new VoiceLoop({
      start: () => {}, stop: () => {}, send: (t, _d, x) => { log.push(`send:${t}${x?.speculated ? " (speculated)" : ""}`); },
      speak: () => Promise.resolve(), cancelSpeech: () => {}, now: () => h.now, silenceMs: 700, helperEndpoints: true,
      speculate: (t) => log.push(`speculate:${t}`), cancelSpeculation: () => log.push("cancel"),
      after: (ms, fn) => { timers.push({ at: h.now + ms, fn }); },
    });
    const advance = (ms: number) => {
      const end = h.now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        h.now = t.at;
        t.fn();
      }
      h.now = end;
    };
    h.loop.begin();
    return { ...h, advance };
  }

  it("the pause's start is dropped when the user goes on; the helper's likely end at the real end starts again, and the final keeps it", () => {
    const h = bare();
    h.loop.onLikelyEnd("remind me to call the dentist");
    h.advance(1_300); // a mid-thought pause, then the user goes on
    h.loop.onPartial("remind me to call the dentist on Friday");
    h.advance(400);
    h.loop.onPartial("remind me to call the dentist on Friday morning");
    h.advance(300);
    h.loop.onLikelyEnd("remind me to call the dentist on Friday morning");
    h.advance(600);
    h.loop.onFinal("Remind me to call the dentist on Friday morning.");
    expect(h.log).toEqual(["speculate:remind me to call the dentist", "cancel", "speculate:remind me to call the dentist on Friday morning", "send:Remind me to call the dentist on Friday morning. (speculated)"]);
  });

  it("the helper's likely end for words a start already has is no second start", () => {
    const h = bare();
    h.loop.onLikelyEnd("what's on my");
    h.advance(20);
    h.loop.onPartial("what's on my calendar");
    h.advance(300);
    h.loop.onLikelyEnd("what's on my calendar"); // the helper's own, for the settled words
    h.advance(300);
    h.loop.onFinal("What's on my calendar?");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toEqual(["speculate:what's on my calendar"]);
  });

  it("never more than three starts a turn, however often the user pauses", () => {
    const h = bare();
    const words = ["so", "so I was thinking", "so I was thinking maybe", "so I was thinking maybe we could", "so I was thinking maybe we could move it", "so I was thinking maybe we could move it to Friday"];
    for (const w of words.slice(1)) { h.loop.onLikelyEnd(w); h.advance(1_000); h.loop.onPartial(`${w} and`); h.advance(100); }
    h.loop.onFinal("So I was thinking maybe we could move it to Friday.");
    expect(h.log.filter((l) => l.startsWith("speculate:")).length).toBeLessThanOrEqual(3);
  });

  it("the composed call, same recording: the real end's start saves the answer ~250 ms at the median, for ~6% more voice tokens", async () => {
    // The 5.8 helper's likely ends on the turn-taking corpus (real helper, 2026-09-30), against the SAME recording as the
    // old helper would have sent it (the first likely end of each helper utterance only).
    const all = likely58.likely as Record<string, number[]>;
    const firstOnly: Record<string, number[]> = {};
    for (const u of fixture.utterances) {
      const finals = u.events.filter((e) => e.type === "final").map((e) => e.t - u.speechEndMs).sort((a, b) => a - b);
      const seen = new Set<number>();
      firstOnly[u.id] = all[u.id]!.filter((ms) => { const k = finals.findIndex((f) => ms < f); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    const before = await runCall({ likely: firstOnly });
    const after = await runCall({ likely: all });
    const b = summary(before), a = summary(after);
    console.log(JSON.stringify({ before: stageSummary(before), after: stageSummary(after) }));
    // Measured: answer p50 2,594 -> 2,327 (turns without a recorded cut-in), any audio 1,753 -> 1,659.
    expect(a.answerP50Whole!).toBeLessThanOrEqual(b.answerP50Whole! - 200);
    expect(a.anyP50Whole!).toBeLessThanOrEqual(b.anyP50Whole!);
    expect(a.answerP90!).toBeLessThanOrEqual(b.answerP90! + 20);
    // Guards: never over the user, no more fillers, and the cost is bounded (voice runs a turn 1.64 -> 1.74; tokens +6%).
    expect(a.overUser).toBe(0);
    expect(a.fillerRate).toBeLessThanOrEqual(b.fillerRate);
    expect(a.frontRunsPerTurn).toBeLessThanOrEqual(1.75);
    expect(a.tokens).toBeLessThanOrEqual(b.tokens * 1.07);
  }, 240_000);
});

describe("(a) bug 218: a short sound in the Bot's own voice the moment the user stops, only when the answer isn't ready", () => {
  it("first audio of any kind: p50 2,392 -> 1,831 (review 1: a 250 ms beat, and never a sound on two turns running)", () => {
    // With a sound at the final itself on 87% of turns this was 1,196 / 1,831; review 1 traded that for a natural beat
    // and a sound on under half the turns (see test-reports/voice-smooth/review-1.md for the variants measured).
    const s = summary(call);
    expect(s.anyP50Whole!).toBeLessThanOrEqual(1_831); // turns without a cut-in (the whole call: see the top)
    expect(s.anyP90Whole!).toBeLessThanOrEqual(2_725);
    expect(s.anyP90!).toBeLessThanOrEqual(2_800);
    expect(s.ackRate).toBeLessThanOrEqual(0.5);
    // The floor: the sound can't come before the helper's final (end of turn + Apple's final, ~1.0-1.25 s after the
    // voice stops on these recordings).
    const lag = call.turns.filter((x) => !x.cutIn && x.phrases[0] === "ack").map((t) => t.firstAudio! - t.finalAfterSpeechMs);
    expect(pct(lag, 0.5)!).toBeLessThanOrEqual(310); // a ~250 ms beat after the final
    expect(Math.max(...lag)).toBeLessThanOrEqual(310); // a kept start: when the host says its reply has no words yet (<= 300 ms)
  });

  it("no sound when the answer is ready: a kept start whose text is already there plays the answer alone", async () => {
    // The voice writes as fast as it ever does: a kept start has its words before the final on most turns.
    const r = await runCall({ rounds: 1, firstTextMs: () => 400 }); // the fastest the real voice ever wrote (bench min 404 ms)
    const kept = r.turns.filter((t) => t.hostReady && !t.cutIn); // a cut-in turn is two sends
    expect(kept.length).toBeGreaterThanOrEqual(8);
    for (const t of kept) expect(t.phrases, t.id).not.toContain("ack");
  }, 60_000);

  it("varied and short: never the same sound twice running, at least 6 different ones, each under 12 characters", () => {
    const acks = call.lines.filter((l) => l.phrase === "ack").map((l) => l.text);
    expect(acks.length).toBeGreaterThan(20);
    for (let i = 1; i < acks.length; i++) expect(acks[i], `sound ${i}`).not.toBe(acks[i - 1]);
    expect(new Set(acks).size).toBeGreaterThanOrEqual(6);
    for (const a of acks) expect(a.length).toBeLessThan(12);
  });

  it("the sound never holds the answer back (≤ 150 ms beyond the answer's own render)", () => {
    for (const t of call.turns.filter((x) => x.phrases.join() === "ack" && x.answerAudio !== null)) {
      const first = call.lines.find((l) => !l.phrase && l.audioStart === t.speechEnd + t.answerAudio!)!;
      expect(t.answerQueuedToAudio! - (70 + 5 * first.text.length), t.id).toBeLessThanOrEqual(150);
    }
  });

  it("guards: no model tokens, fewer fillers, the ANSWER never over the user more than before; the sound only overlaps a user who went on after a recorded cut-in", () => {
    const s = summary(call);
    expect(s.frontRunsPerTurn).toBeLessThanOrEqual(1.695); // 1.68 -> 1.685: one more cancelled start in 108 turns (a barge over the sound), no model call for the sound itself; 1.694: plan item 10
    // 20% before; the turn after a sound has none, a long wait there gets the filler. 0.176 after plan item 10: a merged
    // cut-in waits for the whole thought's answer (behind the fragment's run), where the fragment's reply used to play.
    expect(s.fillerRate).toBeLessThanOrEqual(0.18);
    expect(s.overUser).toBe(0);
    for (const t of call.turns.filter((x) => x.phraseOverUser > 0)) expect(t.cutIn, t.id).toBe(true);
  });
});

describe("bug 220 (plan item 9, matcher half): Full mode's Whisper final keeps the speculative start", () => {
  it("a Whisper-written final commits as many starts as Apple's own final does", async () => {
    const light = await runCall({ rounds: 1 });
    const full = await runCall({ rounds: 1, finalAs: "whisper" });
    expect(full.kept).toBeGreaterThanOrEqual(light.kept);
    expect(summary(full).answerP50!).toBeLessThanOrEqual(summary(light).answerP50! + 20);
  }, 120_000);
});

describe("inventory #6: holes between sentences (guard; the cause is Kokoro rendering a line whole, not the loop)", () => {
  it("the composed call has no join with more than 150 ms of silence beyond its pause", () => {
    expect(joins(call.lines).joinGapsOver150).toBe(0);
  });
});

describe("review 1: variants the harness can model", () => {
  it("a Bluetooth route (+200 ms between the player and the ear) shifts every figure by about that, nothing more", async () => {
    const s = summary(await runCall({ outputLatencyMs: 200 }));
    expect(s.answerP50Whole!).toBeLessThanOrEqual(2_528 + 200);
    expect(s.anyP50Whole!).toBeLessThanOrEqual(1_831 + 200);
  }, 120_000);

  it("no sound rendered yet in the Bot's voice: no sound at all (the call is exactly as before bug 218)", async () => {
    const s = summary(await runCall({ ackRendered: () => false }));
    expect(s.ackRate).toBe(0);
    expect(s.anyP50!).toBeLessThanOrEqual(2_481);
  }, 120_000);
});
