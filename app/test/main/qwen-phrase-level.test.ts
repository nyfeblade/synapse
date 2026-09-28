import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KOKORO_LEVELS, KOKORO_LEVEL_DEFAULT } from "../../src/main/native/qwen";
import { PhraseCache, PhrasePrerender, phraseCached } from "../../src/main/native/voice-cache";

// Bug 221 (voice-smooth plan item 17): a Qwen Bot's call lines — greetings, fillers, the end-of-turn sounds — were
// never pre-rendered (the call only asked for Kokoro voices: 0 of 1,296 pre-render jobs were Qwen), and when one
// was, it was held to the DEFAULT level (0.064) while every live line of that Bot is held to its own Kokoro voice's
// level (0.049-0.087): up to ±2.6 dB between a filler and the reply. Now they render at the Bot's level, the cache
// is keyed by it, and a pre-render never runs beside a call that has just started.

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-lvl-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const pcm = (n: number) => Buffer.from(new Float32Array(n).fill(0.25).buffer);

type Handlers = { audio(p: Buffer, i: number): void; done(m: unknown): void; error(m: string): void };
function engines() {
  const jobs: { id: string; text: string; targetRms?: number; quality?: string; h: Handlers }[] = [];
  const cancelled: string[] = [];
  const qwen = {
    isReady: () => true, isWarm: () => true, busy: () => false,
    synthQwen: (j: { id: string; text: string; targetRms?: number; quality?: string }, h: Handlers) => { jobs.push({ ...j, h }); },
    cancel: (id?: string) => { if (id) cancelled.push(id); },
  };
  const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: vi.fn(), cancel: (id?: string) => { if (id) cancelled.push(id); } };
  return { jobs, cancelled, qwen, tts };
}

describe("bug 221: a Qwen Bot's call lines, pre-rendered at its own level", () => {
  it("renders in its Qwen voice held to its Kokoro voice's level, and keys the cache by that level", () => {
    const cache = new PhraseCache({ dir: tmp() });
    const e = engines();
    const pre = new PhrasePrerender({ cache, tts: e.tts as never, qwen: e.qwen as never, log: () => {} });
    pre.prepare([{ voice: "qwen3:vivian", speed: 1, text: "Mm-hm.", fallback: "kokoro:am_puck" }]);
    pre.pump();
    expect(e.jobs[0]).toMatchObject({ text: "Mm-hm.", targetRms: KOKORO_LEVELS.am_puck, quality: "full" });
    e.jobs[0]!.h.audio(pcm(2400), 0);
    e.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(cache.has("vivian", 1, "Mm-hm.", KOKORO_LEVELS.am_puck)).toBe(true);
    expect(cache.has("vivian", 1, "Mm-hm.", KOKORO_LEVEL_DEFAULT)).toBe(false); // another level is another take
    expect(phraseCached(cache, { voice: "qwen3:vivian", speed: 1, text: "Mm-hm.", fallback: "kokoro:am_puck" })).toBe(true);
    expect(phraseCached(cache, { voice: "qwen3:vivian", speed: 1, text: "Mm-hm.", fallback: "kokoro:am_michael" })).toBe(false);
  });

  it("a take at the Bot's level already there is not rendered again; a Kokoro line's key is unchanged", () => {
    const cache = new PhraseCache({ dir: tmp() });
    cache.put("vivian", 1, "Okay.", pcm(10), KOKORO_LEVELS.am_puck);
    cache.put("am_puck", 1, "Okay.", pcm(10));
    const e = engines();
    const pre = new PhrasePrerender({ cache, tts: e.tts as never, qwen: e.qwen as never, log: () => {} });
    pre.prepare([{ voice: "qwen3:vivian", speed: 1, text: "Okay.", fallback: "kokoro:am_puck" }, { voice: "kokoro:am_puck", speed: 1, text: "Okay." }]);
    pre.pump();
    expect(e.jobs).toHaveLength(0);
    expect(e.tts.synth).not.toHaveBeenCalled();
  });

  it("a call taking the microphone stops the render in flight (no GPU burst beside the greeting); it resumes after", () => {
    const cache = new PhraseCache({ dir: tmp() });
    const e = engines();
    let live = false;
    const pre = new PhrasePrerender({ cache, tts: e.tts as never, qwen: e.qwen as never, log: () => {}, live: () => live });
    pre.prepare([{ voice: "qwen3:vivian", speed: 1, text: "Hmm.", fallback: "kokoro:af_heart" }]);
    pre.pump();
    expect(e.jobs).toHaveLength(1);
    live = true;
    pre.halt();
    expect(e.cancelled).toEqual([e.jobs[0]!.id]);
    // The halted job's late audio is ignored, and nothing is cached from it.
    e.jobs[0]!.h.audio(pcm(100), 0);
    e.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(cache.has("vivian", 1, "Hmm.", KOKORO_LEVELS.af_heart)).toBe(false);
    pre.pump();
    expect(e.jobs).toHaveLength(1); // not while the call is live
    live = false;
    pre.pump();
    expect(e.jobs).toHaveLength(2);
    expect(e.jobs[1]).toMatchObject({ text: "Hmm.", targetRms: KOKORO_LEVELS.af_heart });
  });
});
