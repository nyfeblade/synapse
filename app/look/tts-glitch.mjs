#!/usr/bin/env node
/**
 * LOOK's bench for bug 161 — "the Kokoro voice is glitching a little" (dev only).
 *
 * Renders real reply text through the app's OWN chain — the real sidecar
 * (native/kokoro/kokoro_server.py, the user's Python and model), then main/native/tts-dsp.ts's
 * silence gate and question ramp, then a 2x upsample standing in for the helper's 24 -> 48 kHz
 * converter — and MEASURES what comes out instead of judging it by ear.
 *
 *   node app/look/tts-glitch.mjs [--voices af_heart,bm_george] [--out DIR] [--model-dir DIR]
 *
 * Writes <out>/<case>-<voice>-<variant>.wav (24 kHz, what we hand the helper) and -48k.wav (what
 * the player renders), plus report.json with every number below.
 *
 * It starts with a TONE PROBE: a steady tone taken through the ramp on its own, THD+N measured in the
 * plateau. That is the interpolator with no speech to hide behind, and it is where bug 156's straight-
 * line read showed up — everything else here is a ratio, and ratios lie when both sides are tiny.
 *
 * Then, per line and per variant (raw / trim / trim+ramp):
 *   maxStep / stepRatio    the biggest jump between consecutive samples, against the raw line's own.
 *   winStepRatio           the same inside the ramp window only, against the SAME window with the ramp
 *                          off. Floored at -40 dBFS: a window that dies away to 0.001 RMS otherwise
 *                          reports 4.5x for two steps nobody could hear.
 *   clickRatio             the worst step measured against the median step of the 10 ms around it —
 *                          a click is a step that does not belong, not merely a big one — ramp vs not.
 *   clipped / dc / ms      samples at or past full scale, mean value, and the length.
 *   firstSample/lastSample where the chunk meets the helper's pause silence. Anything but ~0 ticks.
 *   tailHz / liftSt        autocorrelation pitch (octave-guarded) over the last 250 ms of voiced
 *                          speech, ramp against no-ramp: the lift the ramp is there for.
 *   headRms / tailRms      the first and last 30 ms of speech, so a trim that eats a phoneme shows up.
 *   aliasDb                >9.5 kHz energy against the raw line's. NOT an artefact measure — the ramp
 *                          moves the whole spectrum up 26%, so this rising is the point; it is here to
 *                          show the shift happened. The tone probe is the artefact measure.
 *
 * Dev only: app/scripts/package.mjs ships an ALLOWLIST (dist, node_modules, package.json), so
 * nothing under look/ can reach the packaged build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const SR = 24_000;
const dspArg = process.argv.indexOf("--dsp");
const dsp = await import(dspArg > 0 ? path.resolve(process.argv[dspArg + 1]) : path.join(APP, "src/main/native/tts-dsp.ts"));
// --compare <module>: score a second DSP on the very SAME synthesized audio. Kokoro is not
// bit-deterministic between runs, so a before/after taken from two separate runs compares two
// different renderings; this compares two code paths over one.
const cmpArg = process.argv.indexOf("--compare");
const cmp = cmpArg > 0 ? await import(path.resolve(process.argv[cmpArg + 1])) : null;

// ---- the lines: what a reply actually looks like ----
const CASES = [
  ["multi", "I pulled the numbers for last quarter. Revenue was up nine percent, and churn finally came down. I think we should ship it."],
  ["question", "So, do you want me to send it over to the team this afternoon?"],
  ["commas", "First we check the logs, then the metrics, then, if it still looks wrong, we roll it back."],
  ["shortq", "Want me to try again?"],
  ["longq", "That one took a while to work out, and I am still not certain about the second half, so should I keep going?"],
  ["stmt", "You want me to send it."],
  ["stmtq", "You want me to send it?"],
];

// ---- args ----
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HOME = os.homedir();
// The runtime the app bundles (portable install): node app/scripts/kokoro-runtime.mjs stage .build-cache/stage
const MODEL = arg("model-dir", path.resolve(HERE, "../../.build-cache/stage/kokoro/model"));
const PY = arg("python", path.resolve(HERE, "../../.build-cache/stage/kokoro/python/bin/python3.12"));
const OUT = path.resolve(arg("out", path.join(APP, "..", "test-reports", "tts-glitch")));
const VOICES = arg("voices", "af_heart,bm_george").split(",").map((v) => v.trim()).filter(Boolean);

// ---- the sidecar, spoken to exactly as KokoroSidecar does ----
function readFrames(buf, onFrame) {
  let b = buf;
  for (;;) {
    if (b.length < 4) return b;
    const n = b.readUInt32BE(0);
    if (b.length < 4 + n) return b;
    const hl = b.readUInt16BE(4);
    const header = JSON.parse(b.subarray(6, 6 + hl).toString("utf8"));
    const pcm = Buffer.alloc(n - 2 - hl);
    b.copy(pcm, 0, 6 + hl, 4 + n);
    onFrame(header, pcm);
    b = b.subarray(4 + n);
  }
}

class Sidecar {
  constructor() {
    const script = path.join(APP, "native/kokoro/kokoro_server.py");
    this.c = spawn("/usr/bin/arch", ["-arm64", PY, "-s", "-E", script, "--model-dir", MODEL], { stdio: ["pipe", "pipe", "pipe"] });
    this.jobs = new Map();
    let rest = Buffer.alloc(0);
    this.c.stdout.on("data", (d) => {
      rest = readFrames(Buffer.concat([rest, d]), (h, pcm) => {
        if (h.type === "warm") this.onWarm?.();
        const j = h.id ? this.jobs.get(h.id) : null;
        if (!j) return;
        if (h.type === "audio" && pcm.length) j.audio(pcm, h.seq ?? 0);
        if (h.type === "done") { this.jobs.delete(h.id); j.done(h); }
        if (h.type === "error") { this.jobs.delete(h.id); j.error(h.message ?? "failed"); }
      });
    });
    this.c.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  }
  warm() { return new Promise((r) => { this.onWarm = r; this.c.stdin.write(`${JSON.stringify({ op: "warm" })}\n`); }); }
  /** Every frame the sidecar produced for this line, untouched (the "raw" of every comparison). */
  synth(id, text, voice, speed = 1) {
    return new Promise((resolve, reject) => {
      const frames = [];
      this.jobs.set(id, { audio: (pcm) => frames.push(pcm), done: (info) => resolve({ frames, info }), error: reject });
      this.c.stdin.write(`${JSON.stringify({ op: "synth", id, text, voice, speed })}\n`);
    });
  }
  stop() { try { this.c.stdin.end(); } catch { /* gone */ } }
}

// ---- replaying frames through the app's chain ----
/** Feed `frames` through withProsody exactly as dictation.ts does, and collect what the helper gets. */
function throughChain(text, frames, prosody, mod = dsp) {
  const got = [];
  const seams = [];
  const sink = {
    audio: (pcm) => { seams.push(got.reduce((a, b) => a + b.length, 0) / 4); got.push(Buffer.from(pcm)); },
    done: () => {},
    error: (m) => { throw new Error(m); },
  };
  const h = mod.withProsody(text, sink, prosody);
  for (const f of frames) h.audio(f, 0);
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  const all = Buffer.concat(got);
  const aligned = Buffer.allocUnsafeSlow(all.length);
  all.copy(aligned);
  return { x: new Float32Array(aligned.buffer, 0, aligned.length >>> 2), seams: seams.filter((s) => s > 0) };
}

// ---- the helper's 24 -> 48 kHz leg, kept stateful across chunks like AVAudioConverter ----
const TAPS = 32; // half-length of the windowed-sinc kernel, per phase
function kernel() {
  const k = [];
  for (let phase = 0; phase < 2; phase++) {
    const h = new Float64Array(2 * TAPS);
    let sum = 0;
    for (let i = 0; i < 2 * TAPS; i++) {
      const t = i - TAPS + 1 - phase / 2;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (2 * TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (2 * TAPS - 1));
      h[i] = s * w;
      sum += h[i];
    }
    for (let i = 0; i < h.length; i++) h[i] /= sum;
    k.push(h);
  }
  return k;
}
const K = kernel();
/** 2x upsample with the filter's history carried across calls — what a stateful converter does. */
function upsample2x(chunks) {
  const hist = new Float32Array(2 * TAPS);
  const out = [];
  const push = (x) => {
    for (let n = 0; n < x.length; n++) {
      hist.copyWithin(0, 1);
      hist[hist.length - 1] = x[n];
      for (let phase = 0; phase < 2; phase++) {
        let acc = 0;
        for (let i = 0; i < hist.length; i++) acc += hist[i] * K[phase][hist.length - 1 - i];
        out.push(acc * 2);
      }
    }
  };
  for (const c of chunks) push(c);
  push(new Float32Array(TAPS)); // flush the delay line
  return Float32Array.from(out);
}

// ---- measurement ----
const maxStep = (x, from = 1, to = x.length) => {
  let m = 0;
  let at = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > m) { m = d; at = i; }
  }
  return { step: m, at };
};
/**
 * A click is not a big step — speech is full of big steps at a plosive — it is a step that does not
 * belong where it sits. Score = the step over the median step of the 10 ms either side of it; the
 * worst score on the line, and where.
 */
function worstClick(x, from = 0, to = x.length, floor = 0.02) {
  const W = 240;
  const d = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  let score = 0;
  let at = 0;
  const win = new Float64Array(2 * W);
  for (let i = Math.max(W, from); i < Math.min(x.length - W, to); i++) {
    if (d[i] < floor) continue;
    win.set(d.subarray(i - W, i + W));
    const med = win.slice().sort()[W] || 1e-4;
    const s = d[i] / Math.max(med, 1e-4);
    if (s > score) { score = s; at = i; }
  }
  return { score, at, step: d[at] ?? 0 };
}
const rms = (x, a, b) => {
  let s = 0;
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, hi - lo));
};
const clips = (x) => { let n = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 1) n++; return n; };
const dc = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / Math.max(1, x.length); };

/** Energy above `hz` against total, via a plain Goertzel-free FFT on a Hann window. */
function hfRatio(x, from, to, hz = 9500) {
  const n = 1 << Math.floor(Math.log2(Math.min(to, x.length) - Math.max(0, from)));
  if (n < 256) return 0;
  const a = Math.max(0, from);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  let hi = 0;
  let all = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    all += p;
    if ((k * SR) / n >= hz) hi += p;
  }
  return all > 0 ? hi / all : 0;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** Autocorrelation F0 over one window, 70-400 Hz; 0 when the window has no pitch in it. */
function f0(x, from, to) {
  const lo = Math.max(2, Math.round(SR / 400));
  const hi = Math.round(SR / 70);
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  if (b - a < hi + 2) return 0;
  const w = new Float64Array(b - a);
  let mean = 0;
  for (let i = 0; i < w.length; i++) mean += x[a + i];
  mean /= w.length;
  for (let i = 0; i < w.length; i++) w[i] = (x[a + i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (w.length - 1)));
  let e0 = 0;
  for (let i = 0; i < w.length; i++) e0 += w[i] * w[i];
  if (e0 <= 0) return 0;
  const r = new Float64Array(hi + 1);
  let best = 0;
  let bestLag = 0;
  for (let lag = lo; lag <= hi && lag < w.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < w.length; i++) s += w[i] * w[i + lag];
    r[lag] = s / e0;
    if (r[lag] > best) { best = r[lag]; bestLag = lag; }
  }
  if (!bestLag || best <= 0.3) return 0;
  // Octave guard: autocorrelation is just as happy at twice the period, and a tail that has been
  // pitched UP is exactly where it flips. If a peak near half the winning lag is nearly as strong,
  // that is the real period. Without this the lift reads as a 12 st fall on a handful of lines.
  for (const div of [2, 3]) {
    const half = Math.round(bestLag / div);
    if (half < lo) continue;
    let peak = 0;
    let at = 0;
    for (let lag = Math.max(lo, half - 3); lag <= Math.min(hi, half + 3); lag++) if (r[lag] > peak) { peak = r[lag]; at = lag; }
    if (at && peak > best * 0.85) { best = peak; bestLag = at; }
  }
  return SR / bestLag;
}
/**
 * The pitch of the last `ms` of voiced speech, median of 40 ms windows. `end` is pinned by the caller
 * to the UN-ramped line's voiced end: the ramp changes the tail's zero-crossing rate, so letting each
 * variant find its own would compare two different stretches of audio.
 */
function tailF0(x, end, ms = 250) {
  const frame = Math.round(SR * 0.04);
  const frames = [];
  for (let a = end - Math.round((SR * ms) / 1000); a + frame <= end; a += frame >> 1) frames.push({ a, r: rms(x, a, a + frame) });
  // Only frames with real energy: the last 250 ms of "…try again?" trails off breathy, and an
  // autocorrelation on that reads anything at all (80 Hz one frame, 240 the next).
  const loud = Math.max(...frames.map((f) => f.r), 0) * 0.5;
  const vals = frames.filter((f) => f.r >= loud).map((f) => f0(x, f.a, f.a + frame)).filter((v) => v > 0);
  if (!vals.length) return 0;
  vals.sort((p, q) => p - q);
  return vals[vals.length >> 1];
}

function wav(file, x, rate) {
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}

/**
 * The interpolator on its own, with no speech to hide behind: a steady tone through the ramp, then
 * THD+N over the plateau (the last 100 ms of the window, where the rate is flat at k). Everything
 * that is not the shifted tone — the images a cheap interpolator leaves and anything that folded back
 * past Nyquist — is the artefact, in dB below the tone. The ear starts to hear a resampler buzz on a
 * voice around -30 dB.
 */
function toneThdDb(hz, prosody) {
  const secs = 2;
  const x = new Float32Array(SR * secs);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  const y = dsp.rampQuestionTail(x, { semitones: prosody.semitones, rampMs: prosody.rampMs });
  // Strictly inside the plateau (the rate is flat past 70% of the window) and clear of the out-fade,
  // where the window hands back to the unshifted original and the two tones legitimately co-exist.
  const n = 1024;
  const a = y.length - Math.round(SR * 0.012) - n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = y[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  let peak = 1;
  for (let k = 2; k < n / 2; k++) if (p[k] > p[peak]) peak = k;
  let sig = 0;
  let junk = 0;
  // +/-4 bins: the shifted tone almost never lands on a bin, and a Hann window spreads it that far.
  for (let k = 2; k < n / 2; k++) (Math.abs(k - peak) <= 4 ? (sig += p[k]) : (junk += p[k]));
  return { thdDb: +(10 * Math.log10(junk / Math.max(sig, 1e-30))).toFixed(1), shiftedHz: +((peak * SR) / n).toFixed(0), wantHz: +(hz * 2 ** (prosody.semitones / 12)).toFixed(0) };
}

// ---- run ----
// The legacy module (bug 156, for the A/B) predates TTS_CLEAN, so it is held to the same bar from here.
const TTS_CLEAN = dsp.TTS_CLEAN ?? { stepRatio: 1.3, clickRatio: 1.4, thdDb: -30, edgeSample: 1e-3, liftSt: 1.5, holeDb: -6 };
const RAMP_ON = { ...dsp.PROSODY_DEFAULT, questionRamp: true, semitones: dsp.PROSODY_DEFAULT.semitones || 4, rampMs: dsp.PROSODY_DEFAULT.rampMs || 350 };
const RAMP_OFF = { ...RAMP_ON, questionRamp: false };
fs.mkdirSync(OUT, { recursive: true });
const tones = [2000, 4000, 7000, 9000].map((hz) => ({ hz, ...toneThdDb(hz, RAMP_ON) }));
console.log("tone probe (the ramp's interpolator alone):");
for (const t of tones) console.log(`  ${t.hz} Hz -> ${t.shiftedHz} Hz (want ${t.wantHz})   THD+N ${t.thdDb} dB`);
console.log("");
const sc = new Sidecar();
await sc.warm();
const report = [];
for (const voice of VOICES) {
  for (const [name, text] of CASES) {
    const { frames } = await sc.synth(`${name}-${voice}`, text, voice, 1);
    const rawBuf = Buffer.concat(frames);
    const rawAligned = Buffer.allocUnsafeSlow(rawBuf.length);
    rawBuf.copy(rawAligned);
    const raw = new Float32Array(rawAligned.buffer, 0, rawAligned.length >>> 2);
    const base = maxStep(raw).step;
    const rawEnd = dsp.voicedEnd(raw);
    const variants = { raw: { x: raw, seams: [] }, trim: throughChain(text, frames, RAMP_OFF), ramp: throughChain(text, frames, RAMP_ON) };
    if (cmp) { variants.wasTrim = throughChain(text, frames, RAMP_OFF, cmp); variants.wasRamp = throughChain(text, frames, RAMP_ON, cmp); }
    // The ramp is measured against the SAME line with the ramp off — the only thing that differs.
    const noRamp = variants.trim.x;
    // Every ramp measurement is taken over the same samples of the same line with the ramp off.
    const pinnedEnd = dsp.voicedEnd(noRamp);
    const partner = { ramp: variants.trim.x, wasRamp: variants.wasTrim?.x };
    for (const [variant, { x, seams }] of Object.entries(variants)) {
      const stem = `${name}-${voice}-${variant}`;
      wav(path.join(OUT, `${stem}.wav`), x, SR);
      const up = upsample2x([x]);
      wav(path.join(OUT, `${stem}-48k.wav`), up, 48_000);
      const isRamp = variant === "ramp" || variant === "wasRamp";
      const off = partner[variant] ?? noRamp;
      const end = variant === "raw" ? rawEnd : variant.startsWith("was") ? cmp.voicedEnd(variants.wasTrim.x) : pinnedEnd;
      const win = Math.round((SR * RAMP_ON.rampMs) / 1000);
      const ms = maxStep(x);
      const seamSteps = seams.map((s) => ({ atMs: +((s / SR) * 1000).toFixed(1), step: +maxStep(x, s - 48, s + 48).step.toFixed(4) }));
      // The ramp's own two joins, wherever the window landed.
      const ends = isRamp ? [end - win, end] : [];
      const rampSeams = ends.map((s) => ({ atMs: +((s / SR) * 1000).toFixed(1), step: +maxStep(x, s - 48, s + 48).step.toFixed(4) }));
      // Only the ramp window changed, so that window is where a ramp artefact has to show: its worst
      // step and its worst click against the very same samples with the ramp off.
      const sameLen = x.length === off.length;
      // Both sides of every ratio are floored at -40 dBFS. Without it a window that ends on a dying
      // breath (af_bella\'s "…afternoon?" fades to 0.001 RMS) reports 4.5x for 0.0005 against 0.0025
      // — two steps nobody could hear, one of which happens to be five times the other.
      const FLOOR = 0.01;
      // A step under -40 dBFS is not a click, whatever it is a multiple of.
      const ratio = (a, b) => (a < FLOOR ? 1 : a / Math.max(b, FLOOR));
      const winStep = isRamp && sameLen ? ratio(maxStep(x, end - win - 240, end + 240).step, maxStep(off, end - win - 240, end + 240).step) : 1;
      // Scoped to the ramp window: the ramp cannot touch anything else, and the worst click of a whole
      // line is one sample somewhere in a plosive — comparing THAT between two runs is jitter, not
      // measurement.
      const click = worstClick(x, end - win - 240, end + 240);
      const clickOff = isRamp && sameLen ? worstClick(off, end - win - 240, end + 240) : click;
      // The defect a step metric cannot see: a HOLE. The ramp sources its tail from earlier in the
      // line, and if it reaches back across a pause it grafts that pause into the middle of the last
      // word. Worst 10 ms RMS of the ramped window against the same 10 ms with the ramp off, in dB,
      // ignoring windows that were near-silence to begin with.
      // Measured as the quietest 10 ms of the window against that window\'s OWN median level, less the
      // same figure with the ramp off: how much deeper a hole the ramp dug than the line already had.
      // Comparing sample-for-sample against the un-ramped line instead would just report the time
      // warp, which is the whole point of the ramp.
      const holeOf = (y) => {
        const t = [];
        for (let a = end - win; a + 240 <= end; a += 120) t.push(rms(y, a, a + 240));
        if (t.length < 4) return 0;
        const med = [...t].sort((p, q) => p - q)[t.length >> 1];
        return med < 1e-4 ? 0 : 20 * Math.log10(Math.max(Math.min(...t), 1e-9) / med);
      };
      const dip = isRamp && sameLen ? holeOf(x) - holeOf(off) : 0;
      report.push({
        case: name, voice, variant,
        samples: x.length, ms: +((x.length / SR) * 1000).toFixed(1),
        maxStep: +ms.step.toFixed(4), maxStepAtMs: +((ms.at / SR) * 1000).toFixed(1),
        stepRatio: +(ms.step / Math.max(1e-9, base)).toFixed(3),
        winStepRatio: +winStep.toFixed(3),
        holeDb: +dip.toFixed(1),
        click: +click.score.toFixed(1), clickAtMs: +((click.at / SR) * 1000).toFixed(1),
        clickRatio: +(click.score > 0 && clickOff.score > 0 ? click.score / clickOff.score : 1).toFixed(3),
        firstSample: +x[0].toFixed(4), lastSample: +x[x.length - 1].toFixed(4),
        clipped: clips(x), dc: +dc(x).toExponential(2),
        hfRatio: +hfRatio(x, end - win, end).toFixed(4),
        hfRawRatio: +hfRatio(raw, rawEnd - win, rawEnd).toFixed(4),
        tailHz: +tailF0(x, end).toFixed(1),
        headRms: +rms(x, 0, Math.round(SR * 0.03)).toFixed(4),
        tailRms: +rms(x, end - Math.round(SR * 0.03), end).toFixed(4),
        seams: seamSteps, rampSeams,
      });
    }
  }
}
sc.stop();
// The lift the ramp buys, per line.
for (const r of report.filter((r) => r.variant === "ramp" || r.variant === "wasRamp")) {
  const off = report.find((o) => o.case === r.case && o.voice === r.voice && o.variant === (r.variant === "ramp" ? "trim" : "wasTrim"));
  r.liftSt = off?.tailHz > 0 && r.tailHz > 0 ? +(12 * Math.log2(r.tailHz / off.tailHz)).toFixed(2) : null;
  r.aliasDb = r.hfRawRatio > 0 ? +(10 * Math.log10(r.hfRatio / r.hfRawRatio)).toFixed(2) : null;
}
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const cols = ["case", "voice", "variant", "ms", "maxStep", "winStepRatio", "clickRatio", "holeDb", "clipped", "lastSample", "tailHz", "liftSt", "aliasDb"];
console.log(cols.join("\t"));
for (const r of report) if (r.variant === "trim" || r.variant === "ramp") console.log(cols.map((c) => r[c] ?? "").join("\t"));
const isQ = (r) => CASES.find(([n]) => n === r.case)[1].trim().endsWith("?");
function summarise(which, label) {
  const ramps = report.filter((r) => r.variant === which && r.liftSt !== null && isQ(r));
  if (!ramps.length) return;
  const lifts = ramps.map((r) => r.liftSt).sort((a, b) => a - b);
  const lifted = lifts.filter((l) => Math.abs(l) > 0.001);
  const edges = report.filter((r) => r.variant === (which === "ramp" ? "trim" : "wasTrim") || r.variant === which);
  console.log(`\n== ${label} ==`);
  console.log(`question lines ${lifts.length}, ramped ${lifted.length}, left flat ${lifts.length - lifted.length}   lift min ${lifted[0]} / median ${lifted[lifted.length >> 1]} / max ${lifted[lifted.length - 1]} st`);
  console.log(`window step ratio: median ${ramps.map((r) => r.winStepRatio).sort((a, b) => a - b)[ramps.length >> 1]}, worst ${Math.max(...ramps.map((r) => r.winStepRatio)).toFixed(2)}, past ${TTS_CLEAN.stepRatio} on ${ramps.filter((r) => r.winStepRatio > TTS_CLEAN.stepRatio).length}`);
  console.log(`click ratio:       median ${ramps.map((r) => r.clickRatio).sort((a, b) => a - b)[ramps.length >> 1]}, worst ${Math.max(...ramps.map((r) => r.clickRatio)).toFixed(2)}, past ${TTS_CLEAN.clickRatio} on ${ramps.filter((r) => r.clickRatio > TTS_CLEAN.clickRatio).length}`);
  console.log(`dropout (holeDb):  median ${ramps.map((r) => r.holeDb).sort((a, b) => a - b)[ramps.length >> 1]}, worst ${Math.min(...ramps.map((r) => r.holeDb)).toFixed(1)} dB, past ${TTS_CLEAN.holeDb} on ${ramps.filter((r) => r.holeDb < TTS_CLEAN.holeDb).length}`);
  console.log(`chunk edge:        worst ${Math.max(...edges.map((r) => Math.abs(r.lastSample))).toFixed(4)}, past ${TTS_CLEAN.edgeSample} on ${edges.filter((r) => Math.abs(r.lastSample) > TTS_CLEAN.edgeSample).length} of ${edges.length}`);
  console.log(`clipped samples:   ${report.reduce((a, r) => a + (r.variant === which ? r.clipped : 0), 0)}`);
}
const ramps = report.filter((r) => r.variant === "ramp" && r.liftSt !== null && isQ(r));
if (cmp) summarise("wasRamp", "SHIPPED (bug 156)");
summarise("ramp", cmp ? "FIXED (bug 161)" : "this build");
// The verdict TTS_CLEAN exists for: may the ramp be on by default?
const med = (k) => ramps.map((r) => r[k]).sort((a, b) => a - b)[ramps.length >> 1];
// Gated on what is reproducible. A single line's worst ratio is not: Kokoro renders the same text
// differently each run, and the outliers that survive appear in the shipped build too, which is what
// makes them Kokoro's own content rather than the ramp's doing. See TTS_CLEAN in tts-dsp.ts.
const fails = [
  ["thdDb", tones.filter((t) => t.thdDb >= TTS_CLEAN.thdDb).map((t) => `${t.hz}Hz=${t.thdDb}`)],
  ["medianStepRatio", med("winStepRatio") > TTS_CLEAN.medianStepRatio ? [`${med("winStepRatio")}`] : []],
  ["medianClickRatio", med("clickRatio") > TTS_CLEAN.medianClickRatio ? [`${med("clickRatio")}`] : []],
  ["holeDb", ramps.filter((r) => r.holeDb < TTS_CLEAN.holeDb).map((r) => `${r.case}/${r.voice}=${r.holeDb}`)],
  ["edgeSample", report.filter((r) => (r.variant === "trim" || r.variant === "ramp") && Math.abs(r.lastSample) > TTS_CLEAN.edgeSample).map((r) => `${r.case}/${r.voice}=${r.lastSample}`)],
  ["clipped", report.filter((r) => r.variant !== "raw" && !r.variant.startsWith("was") && r.clipped > 0).map((r) => `${r.case}/${r.voice}=${r.clipped}`)],
].filter(([, bad]) => bad.length);
console.log(`\nTTS_CLEAN (this build): ${fails.length ? "FAIL" : "PASS"}`);
for (const [name, bad] of fails) console.log(`  ${name}: ${bad.length} line(s) — ${bad.slice(0, 5).join(" ")}`);
const diag = (k, cmp, bound) => ramps.filter((r) => cmp(r[k], bound)).map((r) => `${r.case}/${r.voice}=${r[k]}`);
console.log(`  (diagnostic, not gated) per-line stepRatio past ${TTS_CLEAN.stepRatio}: ${diag("winStepRatio", (a, b) => a > b, TTS_CLEAN.stepRatio).join(" ") || "none"}`);
console.log(`  (diagnostic, not gated) per-line clickRatio past ${TTS_CLEAN.clickRatio}: ${diag("clickRatio", (a, b) => a > b, TTS_CLEAN.clickRatio).join(" ") || "none"}`);
console.log(`WAVs + report.json in ${OUT}`);
