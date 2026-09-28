import { describe, expect, it } from "vitest";
import {
  CLIP_BAR, CLIP_MAX_S, CLIP_MIN_S, CLIP_SAMPLE_RATE, CLONE_RIGHTS_NOTE, CLONE_SCRIPTS,
  DEFAULT_CLONE_SCRIPT, checkClip, checkTranscript, clipPasses, clipWords, measureClip,
} from "../src";

/** A synthetic take: a voiced tone at `level` over a noise floor, `seconds` long. */
function take(o: {
  seconds?: number; level?: number; noise?: number; dc?: number;
  clip?: boolean; gapMs?: number; gapAtMs?: number;
} = {}): Float32Array {
  const sr = CLIP_SAMPLE_RATE;
  const secs = o.seconds ?? 8;
  const level = o.level ?? 0.5;
  const noise = o.noise ?? 0.0005;
  const n = Math.round(secs * sr);
  const x = new Float32Array(n);
  // deterministic pseudo-noise so the test never flakes
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const gapFrom = Math.round(((o.gapAtMs ?? 2000) / 1000) * sr);
  const gapTo = gapFrom + Math.round(((o.gapMs ?? 0) / 1000) * sr);
  // Real speech leaves short gaps between phrases, and those gaps are where the
  // noise floor shows — without them there is nothing for measureClip to measure.
  const phrase = Math.round(1.5 * sr);
  const pause = Math.round(0.3 * sr);
  for (let i = 0; i < n; i++) {
    const silent = (i >= gapFrom && i < gapTo) || i % phrase >= phrase - pause;
    // a 120 Hz buzz with a little wobble stands in for speech
    const v = silent ? 0 : level * Math.sin((2 * Math.PI * 120 * i) / sr) * (0.7 + 0.3 * Math.sin((2 * Math.PI * 3 * i) / sr));
    let s = v + noise * rnd() + (o.dc ?? 0);
    if (o.clip) s = Math.max(-1, Math.min(1, s * 3));
    x[i] = s;
  }
  return x;
}

const byId = (cs: ReturnType<typeof checkClip>, id: string) => cs.find((c) => c.id === id)!;

describe("reference clip measurement", () => {
  it("reports duration, peak and a noise floor below the speech", () => {
    const m = measureClip(take({ seconds: 8, level: 0.5 }));
    expect(m.seconds).toBeCloseTo(8, 1);
    expect(m.peak).toBeGreaterThan(0.4);
    expect(m.peak).toBeLessThan(1);
    expect(m.noiseRms).toBeLessThan(m.rms);
    expect(m.snrDb).toBeGreaterThan(CLIP_BAR.snrDbMin);
    expect(Math.abs(m.dcOffset)).toBeLessThan(CLIP_BAR.dcMax);
  });

  it("finds a pause inside the clip but not the silence at its edges", () => {
    const m = measureClip(take({ seconds: 8, gapMs: 1200, gapAtMs: 3000 }));
    expect(m.longestGapMs).toBeGreaterThan(1000);
    // Half a second of silence at each end is not an interior gap: what is left is
    // only the take's own 300 ms phrase pauses.
    const quietEdges = take({ seconds: 8 });
    quietEdges.fill(0, 0, CLIP_SAMPLE_RATE / 2);
    quietEdges.fill(0, quietEdges.length - CLIP_SAMPLE_RATE / 2);
    expect(measureClip(quietEdges).longestGapMs).toBeLessThan(400);
  });

  it("counts clipped samples when the take is too hot", () => {
    expect(measureClip(take({ clip: true })).clippedSamples).toBeGreaterThan(0);
  });
});

describe("the quality bar", () => {
  it("passes a clean 8 s take", () => {
    const checks = checkClip(measureClip(take({ seconds: 8, level: 0.5 })));
    expect(clipPasses(checks)).toBe(true);
    expect(checks.every((c) => c.detail === undefined)).toBe(true);
  });

  it("rejects a take that is too short or too long, and says so", () => {
    const short = byId(checkClip(measureClip(take({ seconds: CLIP_MIN_S - 1 }))), "length");
    expect(short.pass).toBe(false);
    expect(short.detail).toMatch(/too short/);
    const long = byId(checkClip(measureClip(take({ seconds: CLIP_MAX_S + 1 }))), "length");
    expect(long.pass).toBe(false);
    expect(long.detail).toMatch(/too long/);
  });

  it("rejects clipping, a quiet take, a noisy room, a DC offset and a long pause", () => {
    expect(byId(checkClip(measureClip(take({ clip: true }))), "clipping").pass).toBe(false);
    expect(byId(checkClip(measureClip(take({ level: 0.02 }))), "level").pass).toBe(false);
    expect(byId(checkClip(measureClip(take({ level: 0.5, noise: 0.25 }))), "noise").pass).toBe(false);
    expect(byId(checkClip(measureClip(take({ dc: 0.05 }))), "dc").pass).toBe(false);
    expect(byId(checkClip(measureClip(take({ gapMs: 1500, gapAtMs: 3000 }))), "gaps").pass).toBe(false);
  });

  it("every failure carries a plain message the recorder can show", () => {
    for (const c of checkClip(measureClip(take({ seconds: 2, clip: true, noise: 0.3 })))) {
      if (!c.pass) {
        expect(c.detail).toBeTruthy();
        expect(c.detail!.length).toBeGreaterThan(10);
        expect(c.label.length).toBeLessThan(24);
      }
    }
  });
});

describe("the transcript check", () => {
  it("passes when the take matches the script, ignoring case and punctuation", () => {
    const r = checkTranscript(DEFAULT_CLONE_SCRIPT.text, "honestly is it going to rain later today or should i grab a quick coffee and take a walk outside");
    expect(r.pass).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it("names the words that differ so the user can see the mismatch", () => {
    const r = checkTranscript("the weather today is crisp and clear", "the weather is crisp and bright");
    expect(r.pass).toBe(false);
    expect(r.missing).toContain("today");
    expect(r.missing).toContain("clear");
    expect(r.extra).toContain("bright");
    expect(r.detail).toMatch(/differs/);
  });

  it("treats curly and straight apostrophes the same", () => {
    expect(clipWords("don’t")).toEqual(clipWords("don't"));
  });
});

describe("the recording scripts", () => {
  it("offers four, with the question one preselected", () => {
    expect(CLONE_SCRIPTS).toHaveLength(4);
    expect(DEFAULT_CLONE_SCRIPT).toBe(CLONE_SCRIPTS[0]);
    expect(DEFAULT_CLONE_SCRIPT.id).toBe("asks");
  });

  it("the default asks a question, so the clone hears a rising inflection", () => {
    expect(DEFAULT_CLONE_SCRIPT.text).toMatch(/\?$/);
  });

  it("each script is long enough to run 7-10 s and has natural punctuation", () => {
    for (const s of CLONE_SCRIPTS) {
      const words = clipWords(s.text).length;
      expect(words).toBeGreaterThanOrEqual(16);
      expect(words).toBeLessThanOrEqual(30);
      expect(s.text).toMatch(/[.,!?]/);
      expect(s.tone.length).toBeGreaterThan(4);
    }
  });

  it("script ids are unique, so a retake can offer a different line", () => {
    expect(new Set(CLONE_SCRIPTS.map((s) => s.id)).size).toBe(CLONE_SCRIPTS.length);
  });

  it("says whose voice may be recorded", () => {
    expect(CLONE_RIGHTS_NOTE).toMatch(/your own voice/i);
    expect(CLONE_RIGHTS_NOTE).toMatch(/permission/i);
  });
});
