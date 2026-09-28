import { describe, expect, it } from "vitest";
import {
  PROSODY_DEFAULT, PROSODY_QWEN, TTS_CLEAN, rampQuestionTail, silenceGate, voicedEnd, withProsody,
  type KokoroHandlers, type Prosody,
} from "../../src/main/native/tts-dsp";
import { QWEN_PAUSE_MS, pauseMsFor } from "../../src/renderer/voice/sentences";

/**
 * Bug 161: "the Kokoro voice is glitching a little", right after bug 156's prosody shipped. Measured
 * through the real sidecar (app/look/tts-glitch.mjs, nine curated voices x seven lines): the ramp read
 * between samples with a straight line, which left images only 8.6 dB below a 9 kHz tone — a buzz on
 * the tail of every question — and the trim cut the line wherever a 10 ms block happened to end, so
 * each spoken chunk met the helper's pause silence mid-waveform.
 *
 * These tests hold the PCM to TTS_CLEAN: no step the surrounding audio doesn't already make, nothing
 * clipped, the length untouched, a real rise at the end of a question, and edges that sit on zero.
 */
const SR = 24_000;

/** A voice, near enough: a glottal pulse train at `hz` through two formants, which is what `voicedEnd`
 * and an autocorrelation pitch track are looking for — unlike a sine, it has harmonics to alias. */
function voiced(hz: number, ms: number, o: { amp?: number; leadMs?: number; tailMs?: number } = {}): Float32Array {
  const amp = o.amp ?? 0.6;
  const lead = Math.round((SR * (o.leadMs ?? 300)) / 1000);
  const body = Math.round((SR * ms) / 1000);
  const tail = Math.round((SR * (o.tailMs ?? 600)) / 1000);
  const x = new Float32Array(lead + body + tail);
  const period = SR / hz;
  // No real voice is a metronome: 1% jitter in the period and 1% shimmer in the strength, from a
  // fixed LCG so the test is deterministic. A perfectly periodic pulse train is the pathological
  // case for any resampler and is not what Kokoro produces.
  let seed = 0x2f6e2b1;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const starts: number[] = [];
  const gains: number[] = [];
  for (let at = 0; at < body; ) {
    starts.push(Math.round(at));
    gains.push(1 + 0.02 * rnd());
    at += period * (1 + 0.02 * rnd());
  }
  // Two damped resonators struck once per glottal period: F1 700 Hz, F2 1800 Hz.
  for (const [f, g, decay] of [[700, 1, 0.006], [1800, 0.5, 0.004]] as const) {
    for (let p = 0; p < starts.length; p++) {
      const start = starts[p]!;
      for (let i = 0; i < Math.round(decay * SR * 4) && start + i < body; i++) {
        x[lead + start + i]! += amp * g * gains[p]! * Math.exp(-i / (decay * SR)) * Math.sin((2 * Math.PI * f * i) / SR);
      }
    }
  }
  // …and a little breath through the voiced part, as every voice has.
  for (let i = 0; i < body; i++) x[lead + i]! += amp * 0.01 * rnd();
  // A word has an envelope: it does not appear at full amplitude in one sample and it does not stop
  // dead. 15 ms in, 25 ms out — without this the test would be measuring an impulse, not a join.
  const onset = Math.round(SR * 0.015);
  const offset = Math.round(SR * 0.025);
  for (let i = 0; i < body; i++) {
    const w = Math.min(i < onset ? 0.5 - 0.5 * Math.cos((Math.PI * i) / onset) : 1, body - i < offset ? 0.5 - 0.5 * Math.cos((Math.PI * (body - i)) / offset) : 1);
    x[lead + i]! *= w;
  }
  // A glottal pulse is not an impulse: a real voice has almost nothing left above 8 kHz. Two one-pole
  // passes at 6 kHz, so the test measures the DSP rather than the ultrasonics of a toy generator.
  const a2 = Math.exp((-2 * Math.PI * 6000) / SR);
  for (let pass = 0; pass < 2; pass++) {
    let z = 0;
    for (let i = 0; i < x.length; i++) { z = x[i]! * (1 - a2) + z * a2; x[i] = z; }
  }
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  for (let i = 0; i < x.length; i++) x[i]! *= (amp / peak);
  // Kokoro's padding is near-silence, not digital zero.
  for (let i = 0; i < x.length; i++) if (i < lead || i >= lead + body) x[i]! += 2e-4 * Math.sin(i * 0.3);
  return x;
}

const maxStep = (x: Float32Array, from = 1, to = x.length): number => {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
};
/** The worst step on the line measured against the typical step of the 10 ms around it: a click. */
function worstClick(x: Float32Array): number {
  const W = 240;
  const d = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i]! - x[i - 1]!);
  let worst = 0;
  for (let i = W; i < x.length - W; i++) {
    if (d[i]! < 0.02) continue;
    const win = Array.from(d.subarray(i - W, i + W)).sort((a, b) => a - b);
    worst = Math.max(worst, d[i]! / Math.max(win[W] ?? 1e-4, 1e-4));
  }
  return worst;
}
const rms = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  for (let i = lo; i < hi; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, hi - lo));
};

/** Autocorrelation pitch over [a, b), with the octave guard a pitched-up tail needs. */
function f0(x: Float32Array, a: number, b: number): number {
  const lo = Math.max(2, Math.round(SR / 400));
  const hi = Math.round(SR / 60);
  const w = new Float64Array(Math.min(b, x.length) - Math.max(0, a));
  if (w.length < hi + 2) return 0;
  let mean = 0;
  for (let i = 0; i < w.length; i++) mean += x[a + i]!;
  mean /= w.length;
  for (let i = 0; i < w.length; i++) w[i] = (x[a + i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (w.length - 1)));
  let e0 = 0;
  for (let i = 0; i < w.length; i++) e0 += w[i]! * w[i]!;
  if (e0 <= 0) return 0;
  const r = new Float64Array(hi + 1);
  let best = 0;
  let bestLag = 0;
  for (let lag = lo; lag <= hi && lag < w.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < w.length; i++) s += w[i]! * w[i + lag]!;
    r[lag] = s / e0;
    if (r[lag]! > best) { best = r[lag]!; bestLag = lag; }
  }
  if (!bestLag) return 0;
  for (const div of [2, 3]) {
    const half = Math.round(bestLag / div);
    if (half < lo) continue;
    let peak = 0;
    let at = 0;
    for (let lag = Math.max(lo, half - 3); lag <= Math.min(hi, half + 3); lag++) if (r[lag]! > peak) { peak = r[lag]!; at = lag; }
    if (at && peak > best * 0.85) { best = peak; bestLag = at; }
  }
  return SR / bestLag;
}
const semis = (a: number, b: number): number => 12 * Math.log2(a / b);

/** THD+N of a steady tone taken through the ramp, in the plateau: the interpolator with nothing to hide behind. */
function toneThdDb(hz: number): number {
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  const y = rampQuestionTail(x, { semitones: PROSODY_DEFAULT.semitones, rampMs: PROSODY_DEFAULT.rampMs });
  const n = 1024;
  const a = y.length - Math.round(SR * 0.012) - n; // inside the plateau, clear of the closing fade
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = y[a + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * c - im[i + k + len / 2]! * s;
        const vi = re[i + k + len / 2]! * s + im[i + k + len / 2]! * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  let peak = 1;
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { p[k] = re[k]! * re[k]! + im[k]! * im[k]!; if (k > 1 && p[k]! > p[peak]!) peak = k; }
  let sig = 0;
  let junk = 0;
  for (let k = 2; k < n / 2; k++) (Math.abs(k - peak) <= 4 ? (sig += p[k]!) : (junk += p[k]!));
  return 10 * Math.log10(junk / Math.max(sig, 1e-30));
}

const f32 = (x: Float32Array): Buffer => {
  const b = Buffer.allocUnsafeSlow(x.length * 4);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i]!, i * 4);
  return b;
};
/** Run PCM through the chain the way dictation.ts does, in `frameMs` frames, and collect the result. */
function chain(text: string, x: Float32Array, frameMs = 500, p: Prosody = PROSODY_DEFAULT): { out: Float32Array; frames: number } {
  const got: Buffer[] = [];
  const sink: KokoroHandlers = { audio: (pcm) => { got.push(Buffer.from(pcm)); }, done: () => {}, error: (m) => { throw new Error(m); } };
  const h = withProsody(text, sink, p);
  const step = Math.round((SR * frameMs) / 1000);
  for (let i = 0; i < x.length; i += step) h.audio(f32(x.subarray(i, Math.min(x.length, i + step))), 0);
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  const all = Buffer.concat(got);
  const out = new Float32Array(all.length >>> 2);
  for (let i = 0; i < out.length; i++) out[i] = all.readFloatLE(i * 4);
  return { out, frames: got.length };
}

/** The lines the bench renders through the real sidecar, as close as a unit test gets to them. */
const LINES: [string, Float32Array][] = [
  ["a short question", voiced(180, 900)],
  ["a long question", voiced(120, 2400)],
  ["a low voice", voiced(85, 1500)],
  ["a high voice", voiced(240, 1200)],
];
/** How many samples of each line are speech rather than Kokoro's padding. */
const LINES_BODY = new Map<string, number>([
  ["a short question", Math.round(SR * 0.9)], ["a long question", Math.round(SR * 2.4)],
  ["a low voice", Math.round(SR * 1.5)], ["a high voice", Math.round(SR * 1.2)],
]);

describe("the question ramp adds no artefact (bug 161)", () => {
  it("reads between samples band-limited, not on a straight line", () => {
    // The shipped ramp measured -38.9 / -26.7 / -14.9 / -8.6 dB here. That last one is the buzz.
    for (const hz of [2000, 4000, 7000, 9000]) {
      const thd = toneThdDb(hz);
      expect(thd, `${hz} Hz THD+N ${thd.toFixed(1)} dB`).toBeLessThan(TTS_CLEAN.thdDb);
    }
  });

  it("makes no step, and no click, that the line does not already make", () => {
    for (const [name, x] of LINES) {
      const y = rampQuestionTail(x, { semitones: PROSODY_DEFAULT.semitones, rampMs: PROSODY_DEFAULT.rampMs });
      const end = voicedEnd(x);
      const win = Math.round((SR * PROSODY_DEFAULT.rampMs) / 1000);
      // Both sides floored at -40 dBFS: a window that dies away to near-silence otherwise reports a
      // big ratio for two steps nobody could hear.
      const FLOOR = 0.01;
      const after = maxStep(y, end - win - 240, end + 240);
      const ratio = after < FLOOR ? 1 : after / Math.max(maxStep(x, end - win - 240, end + 240), FLOOR);
      expect(ratio, `${name}: step ratio ${ratio.toFixed(3)}`).toBeLessThan(TTS_CLEAN.stepRatio);
      const a = worstClick(y);
      const b = worstClick(x);
      const click = a > 0 && b > 0 ? a / b : 1;
      expect(click, `${name}: click ratio ${click.toFixed(3)}`).toBeLessThan(TTS_CLEAN.clickRatio);
    }
  });

  it("never clips, even on a line that already peaks near full scale", () => {
    for (const amp of [0.9, 0.98]) {
      const y = rampQuestionTail(voiced(150, 1500, { amp }), { semitones: 4, rampMs: 350 });
      let clipped = 0;
      for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) >= 1) clipped++;
      expect(clipped, `peak ${amp}`).toBe(0);
    }
  });

  it("keeps the line exactly as long, at the same rate", () => {
    for (const [name, x] of LINES) {
      const y = rampQuestionTail(x, { semitones: 4, rampMs: 350 });
      expect(y.length, name).toBe(x.length);
    }
    // And through the whole chain, the trim only ever removes the padding it is there to remove.
    const x = voiced(150, 1500, { leadMs: 300, tailMs: 600 });
    const { out } = chain("Shall I?", x);
    const spoken = Math.round(SR * 1.5);
    expect(out.length).toBeGreaterThan(spoken * 0.97);
    expect(out.length).toBeLessThan(spoken + Math.round(SR * 0.05));
  });

  it("really does lift the end of a question", () => {
    for (const [name, x] of LINES) {
      const end = voicedEnd(x);
      const y = rampQuestionTail(x, { semitones: PROSODY_DEFAULT.semitones, rampMs: PROSODY_DEFAULT.rampMs });
      const a = end - Math.round(SR * 0.15);
      const lift = semis(f0(y, a, end), f0(x, a, end));
      expect(lift, `${name}: ${lift.toFixed(2)} st`).toBeGreaterThan(TTS_CLEAN.liftSt);
      // …and it is a lift, not a transposition: the start of the line is untouched, byte for byte.
      for (let i = 0; i < end - Math.round(SR * PROSODY_DEFAULT.rampMs / 1000) - 1; i++) expect(y[i]).toBe(x[i]);
    }
  });
});

describe("the trim leaves a chunk the helper can butt against a pause (bug 161)", () => {
  it("opens and closes on zero, so the join into the pause silence cannot step", () => {
    for (const [name, x] of LINES) {
      for (const text of ["I did.", "Shall I?"]) {
        const { out } = chain(text, x);
        expect(Math.abs(out[0]!), `${name} ${text} first`).toBeLessThanOrEqual(TTS_CLEAN.edgeSample);
        expect(Math.abs(out[out.length - 1]!), `${name} ${text} last`).toBeLessThanOrEqual(TTS_CLEAN.edgeSample);
      }
    }
  });

  it("a whole reply, spoken chunk by chunk with the pause table between, steps nowhere", () => {
    // What a call actually plays: trimmed chunks with the helper's own silence in between. The pause
    // comes from the renderer's punctuation table (VOICE_PAUSE_MS: 90 after a comma, 220 a full stop,
    // 260 a question), and the helper writes it as digital zero — so every one of these joins is a
    // spoken chunk butted straight against silence, six times in a three-sentence reply.
    const parts: Float32Array[] = [];
    const joins: number[] = [];
    let at = 0;
    for (const [text, x, pauseMs] of [["I pulled the numbers.", voiced(150, 1200), 220], ["Revenue was up, and churn came down.", voiced(140, 1800), 90], ["Shall I send it?", voiced(160, 1000), 260]] as const) {
      const spoken = chain(text, x).out;
      const pause = new Float32Array(Math.round((SR * pauseMs) / 1000));
      joins.push(at, at + spoken.length);
      parts.push(spoken, pause);
      at += spoken.length + pause.length;
    }
    const reply = new Float32Array(at);
    let k = 0;
    for (const p of parts) { reply.set(p, k); k += p.length; }
    // Inside 2 ms of every join there is nothing an ear could catch: before the fix the trim left the
    // line wherever a 10 ms block happened to end, which on the real voices was a step of up to 0.007
    // straight into the pause — a tick once a sentence.
    for (const j of joins) {
      const step = maxStep(reply, j - 48, j + 48);
      expect(step, `join at ${(j / SR * 1000).toFixed(0)} ms: step ${step.toExponential(2)}`).toBeLessThan(0.01);
    }
    expect(maxStep(reply)).toBeLessThanOrEqual(Math.max(...parts.map((p) => maxStep(p))) + 1e-6);
  });

  it("does not eat a word's first or last phoneme", () => {
    // Everything the trim removes is padding, so essentially all of the line's ENERGY has to survive
    // it — a trim that clipped a phoneme, or an edge fade long enough to swallow one, would show here
    // as missing energy. (On the real voices the bench measures the same thing directly: the first
    // 30 ms of speech keeps 0.97x of its untrimmed RMS and the last 30 ms 0.98x.)
    for (const [name, x] of LINES) {
      const { out } = chain("I did.", x);
      const energy = (y: Float32Array): number => { let s = 0; for (let i = 0; i < y.length; i++) s += y[i]! * y[i]!; return s; };
      const kept = energy(out) / energy(x);
      expect(kept, `${name}: keeps ${kept.toFixed(3)} of the line's energy`).toBeGreaterThan(0.98);
      // And the speech itself is still all there: only padding came off.
      const body = LINES_BODY.get(name)!;
      expect(out.length, `${name}: ${out.length} samples for ${body} of speech`).toBeGreaterThan(body * 0.97);
    }
  });

  it("a mid-sentence chunk join is inaudible: the framing cannot change a sample", () => {
    // The sidecar's frames are half a second; a line that arrives in 70 ms pieces, or in one lump,
    // must reach the helper as the very same audio.
    for (const [name, x] of LINES) {
      const one = chain("Shall I?", x, 5_000).out;
      for (const frameMs of [70, 137, 500]) {
        const many = chain("Shall I?", x, frameMs).out;
        expect(many.length, `${name} @${frameMs} ms`).toBe(one.length);
        let worst = 0;
        for (let i = 0; i < one.length; i++) worst = Math.max(worst, Math.abs(one[i]! - many[i]!));
        expect(worst, `${name} @${frameMs} ms: ${worst}`).toBeLessThan(1e-7);
      }
    }
  });

  it("caps a mid-line gap without cutting the waveform", () => {
    const x = new Float32Array(SR * 3);
    const a = voiced(150, 600, { leadMs: 0, tailMs: 0 });
    const b = voiced(150, 600, { leadMs: 0, tailMs: 0 });
    x.set(a, Math.round(SR * 0.3));
    x.set(b, Math.round(SR * 2.1)); // a 1.2 s hole in the middle, well past maxGapMs
    const got: Buffer[] = [];
    const h = silenceGate({ audio: (p) => { got.push(Buffer.from(p)); }, done: () => {}, error: () => {} }, { maxGapMs: 350 });
    for (let i = 0; i < x.length; i += 12_000) h.audio(f32(x.subarray(i, i + 12_000)), 0);
    h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
    const all = Buffer.concat(got);
    const out = new Float32Array(all.length >>> 2);
    for (let i = 0; i < out.length; i++) out[i] = all.readFloatLE(i * 4);
    // Both words survive, the hole is capped, and nothing steps harder than the speech itself does.
    expect(out.length).toBeGreaterThan(Math.round(SR * 1.2));
    expect(out.length).toBeLessThan(Math.round(SR * 1.6));
    expect(maxStep(out)).toBeLessThanOrEqual(maxStep(x) * TTS_CLEAN.stepRatio);
  });
});

/**
 * Bug 166: "why does it pause or break in between sentences kinda", on the Qwen3 voice.
 *
 * Measured through the real sidecar (app/look/qwen-flow.mjs): rendering the whole reply in ONE piece,
 * Qwen leaves 430-680 ms between its own sentences, and its level and pitch move 2.6-16 dB and up to
 * 8.9 st across them. Our chunked playback left 238 ms — but 220 of that was digital zero, because
 * the trim cut the chunk 8 ms after its last loud sample and threw the model's own 450-560 ms of
 * fall and breath away. The gap was never the problem; the hard cut into dead air was.
 *
 * So these hold the PCM to: the model's own tail survives, the silence heard across a join stays
 * inside the model's own range, no word loses its onset, and the edges still sit on zero.
 */
const SILENCE = 0.003; // the gate the filter itself uses, so "silence" means one thing here
/** ms of silence at the start / end of `x`, and the longest run inside it. */
function quiet(x: Float32Array): { leadMs: number; tailMs: number; innerMs: number } {
  const hop = SR / 100;
  const n = Math.floor(x.length / hop);
  const loud: boolean[] = [];
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) { const v = x[f * hop + i]!; s += v * v; }
    loud.push(Math.sqrt(s / hop) >= SILENCE);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return { leadMs: (x.length / SR) * 1000, tailMs: 0, innerMs: 0 };
  let inner = 0;
  let run = 0;
  for (let f = first; f <= last; f++) { if (!loud[f]) { run++; inner = Math.max(inner, run); } else run = 0; }
  return { leadMs: first * 10, tailMs: (n - 1 - last) * 10, innerMs: inner * 10 };
}
/** RMS of the first `ms` of SPEECH (past whatever silence the line opens with). */
function onsetRms(x: Float32Array, ms = 30): number {
  const hop = SR / 100;
  let at = 0;
  for (let f = 0; f * hop + hop <= x.length; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) { const v = x[f * hop + i]!; s += v * v; }
    if (Math.sqrt(s / hop) >= SILENCE) { at = f * hop; break; }
  }
  const n = Math.round((SR * ms) / 1000);
  let s = 0;
  for (let i = at; i < Math.min(x.length, at + n); i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / n);
}

describe("a Qwen3 reply flows across its chunk joins (bug 166)", () => {
  it("keeps the model's own trailing fall instead of cutting at the last loud sample", () => {
    const x = voiced(150, 1200, { leadMs: 400, tailMs: 500 });
    const kokoro = quiet(chain("I pulled the numbers.", x).out);
    const qwen = quiet(chain("I pulled the numbers.", x, 500, PROSODY_QWEN).out);
    // Kokoro's chunk ends on its last loud sample: the beat after it is the renderer's to place.
    expect(kokoro.tailMs).toBeLessThanOrEqual(20);
    // Qwen's keeps its own, capped at PROSODY_QWEN.tailMs and never invented out of nothing.
    expect(qwen.tailMs).toBeGreaterThanOrEqual(PROSODY_QWEN.tailMs - 40);
    expect(qwen.tailMs).toBeLessThanOrEqual(PROSODY_QWEN.tailMs + 20);
    // …and a chunk with less tail than the cap keeps what it has, no more.
    const short = quiet(chain("Done.", voiced(150, 600, { leadMs: 300, tailMs: 80 }), 500, PROSODY_QWEN).out);
    expect(short.tailMs).toBeLessThanOrEqual(90);
  });

  it("the silence heard across every join is the model's own, and none of it is ours", () => {
    // A five-sentence reply as a call plays it: trimmed chunks butted together in the helper's FIFO,
    // with the pause table's silence written between them.
    const lines: [string, Float32Array][] = [
      ["I pulled the numbers for last quarter.", voiced(150, 1600, { leadMs: 500, tailMs: 560 })],
      ["Revenue was up nine percent.", voiced(145, 1400, { leadMs: 360, tailMs: 450 })],
      ["The renewals team thinks the pricing did it.", voiced(155, 1500, { leadMs: 430, tailMs: 260 })],
      ["Shall I put it in a note?", voiced(160, 1200, { leadMs: 430, tailMs: 470 })],
      ["I can have it ready tonight.", voiced(150, 900, { leadMs: 430, tailMs: 480 })],
    ];
    const play = (p: Prosody, table?: typeof QWEN_PAUSE_MS) => {
      const parts: Float32Array[] = [];
      let injected = 0;
      for (const [text, x] of lines) {
        const spoken = chain(text, x, 500, p).out;
        const pauseMs = pauseMsFor(text, table);
        injected += pauseMs;
        parts.push(spoken, new Float32Array(Math.round((SR * pauseMs) / 1000)));
      }
      const n = parts.reduce((a, b) => a + b.length, 0);
      const out = new Float32Array(n);
      let k = 0;
      for (const q of parts) { out.set(q, k); k += q.length; }
      return { out, injected };
    };
    const before = play(PROSODY_DEFAULT);
    const after = play(PROSODY_QWEN, QWEN_PAUSE_MS);
    // Before: a fifth of a second of pure digital zero after every full stop, on top of a hard cut
    // (220 ms five times over — bug 224 paces the question like a full stop — 1.1 s of dead air in one reply).
    expect(before.injected).toBe(1_100);
    // After: the helper is asked for nothing at all — the model already left the beat itself.
    expect(after.injected).toBe(0);
    // The gap a listener hears is barely changed, so the reply is no slower than it was…
    const a = quiet(before.out).innerMs;
    const b = quiet(after.out).innerMs;
    expect(b).toBeGreaterThan(120);
    expect(b).toBeLessThanOrEqual(a + 60);
    // …and it stays well inside what the model itself leaves between sentences (430-680 ms measured).
    expect(b).toBeLessThanOrEqual(680);
  });

  it("no chunk loses its onset, and both edges still sit on zero", () => {
    for (const [name, x] of LINES) {
      const out = chain("Revenue was up.", x, 500, PROSODY_QWEN).out;
      // The word's first 100 ms keeps its level: the opening fade runs out inside the model's own
      // padding, so the phoneme is never the thing being faded up. (100 ms, not 30: the kept run-in
      // moves where "speech" starts by a block, and a 30 ms window would be measuring that offset
      // rather than the fade.)
      expect(onsetRms(out, 100) / onsetRms(x, 100), `${name} onset`).toBeGreaterThan(0.95);
      expect(Math.abs(out[0]!), `${name} first`).toBeLessThanOrEqual(TTS_CLEAN.edgeSample);
      expect(Math.abs(out[out.length - 1]!), `${name} last`).toBeLessThanOrEqual(TTS_CLEAN.edgeSample);
    }
  });

  it("never ramps a Qwen question: the model already ends one above the statement", () => {
    const x = voiced(150, 1400);
    const asked = chain("Shall I send it?", x, 500, PROSODY_QWEN).out;
    const told = chain("I sent it.", x, 500, PROSODY_QWEN).out;
    expect(asked.length).toBe(told.length);
    for (let i = 0; i < asked.length; i += 97) expect(asked[i]).toBe(told[i]);
    // …and bug 224: with Kokoro's prosody too the question is no longer ramped (the user's decision).
    const k = chain("Shall I send it?", x).out;
    const s = chain("I sent it.", x).out;
    expect([...k].some((v, i) => v !== s[i])).toBe(false);
  });
});

/**
 * Bug 180: "the voice chops at the end of each sentence before it starts a new sentence" (Kokoro).
 *
 * Measured through the real sidecar and the helper's own converter (app/look/sentence-tail.mjs): a
 * Kokoro sentence takes 25-60 ms after its last loud sample to fall 55 dB — the end of the word
 * dying away. The gate called anything under 0.003 RMS silence, which on a Kokoro line is only 30-37
 * dB below its peak, so it cut every sentence 0-10 ms after the last loud sample, still in the
 * middle of that fall, and closed it with a 5 ms fade: the word stopped instead of ending.
 *
 * The synthetic line here is a tone that ends the way a word does: it holds, then decays by 8.7 dB
 * every time constant into a near-silent pad. Every level is against the line's own loudest 10 ms.
 */
function endingWord(o: { holdMs?: number; tauMs?: number; padMs?: number; amp?: number } = {}): Float32Array {
  const lead = Math.round(SR * 0.3);
  const hold = Math.round((SR * (o.holdMs ?? 600)) / 1000);
  const tau = (SR * (o.tauMs ?? 15)) / 1000;
  const decay = Math.round(tau * 12); // ~104 dB of fall: all the way into the pad
  const pad = Math.round((SR * (o.padMs ?? 500)) / 1000);
  const x = new Float32Array(lead + hold + decay + pad);
  const amp = o.amp ?? 0.3;
  for (let i = 0; i < hold + decay; i++) {
    const env = (i < 360 ? 0.5 - 0.5 * Math.cos((Math.PI * i) / 360) : 1) * (i < hold ? 1 : Math.exp(-(i - hold) / tau));
    x[lead + i] = amp * env * Math.sin((2 * Math.PI * 200 * i) / SR);
  }
  // Kokoro's pad is near-silence, not digital zero.
  for (let i = 0; i < x.length; i++) x[i]! += 2e-5 * Math.sin(i * 0.3);
  return x;
}
/** The end of the last 10 ms block within 30 dB of the peak block: "the last loud sample". */
function lastLoud(x: Float32Array): { at: number; peak: number } {
  const hop = SR / 100;
  let peak = 0;
  const r: number[] = [];
  for (let f = 0; (f + 1) * hop <= x.length; f++) { r.push(rms(x, f * hop, (f + 1) * hop)); peak = Math.max(peak, r[f]!); }
  let last = r.length - 1;
  while (last > 0 && r[last]! < peak * 10 ** (-30 / 20)) last--;
  return { at: (last + 1) * hop, peak };
}
const dbOf = (v: number, ref: number): number => 20 * Math.log10(Math.max(v, 1e-12) / ref);
/** The last 10 ms a chunk plays before its 5 ms closing fade, in dB under the line's peak. */
const endDb = (out: Float32Array, peak: number): number => dbOf(rms(out, out.length - Math.round(SR * 0.015), out.length - Math.round(SR * 0.005)), peak);

describe("a Kokoro sentence ends the way the model ended it (bug 180)", () => {
  it("keeps the word's own decay past the last loud sample, down to -50 dB, then fades", () => {
    for (const tauMs of [10, 15, 22]) {
      const x = endingWord({ tauMs });
      const { out } = chain("I pulled the numbers.", x);
      const L = lastLoud(out);
      const keptMs = ((out.length - L.at) / SR) * 1000;
      // The fall from -30 to -50 dB takes 20/8.7 time constants; all of it has to survive.
      const needMs = (20 / (20 * Math.log10(Math.E))) * tauMs;
      expect(keptMs, `tau ${tauMs} ms: kept ${keptMs.toFixed(1)} ms after the last loud sample, the fall needs ${needMs.toFixed(1)}`).toBeGreaterThanOrEqual(needMs);
      // Where the chunk stops, the word has died away: the last 10 ms before the closing fade sit
      // at least 45 dB under the line's peak (a chop leaves them at -20 to -30).
      const e = endDb(out, L.peak);
      expect(e, `tau ${tauMs} ms: the chunk ends ${e.toFixed(1)} dB under its peak`).toBeLessThanOrEqual(-45);
      // …and it still closes on zero, with a short fade, not on the whole of Kokoro's pad.
      expect(Math.abs(out[out.length - 1]!)).toBeLessThanOrEqual(TTS_CLEAN.edgeSample);
      expect(keptMs, `tau ${tauMs} ms: ${keptMs.toFixed(1)} ms of tail is the decay, not the pad`).toBeLessThanOrEqual(160);
    }
  });

  it("a question keeps its decay too, and Qwen keeps exactly the tail bug 166 gave it", () => {
    const asked = chain("Shall I send it?", endingWord({ holdMs: 900 })).out;
    expect(endDb(asked, lastLoud(asked).peak)).toBeLessThanOrEqual(-45);
    const qwen = quiet(chain("I pulled the numbers.", endingWord(), 500, PROSODY_QWEN).out);
    expect(qwen.tailMs).toBeGreaterThanOrEqual(PROSODY_QWEN.tailMs - 40);
    expect(qwen.tailMs).toBeLessThanOrEqual(PROSODY_QWEN.tailMs + 20);
  });
});
