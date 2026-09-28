#!/usr/bin/env node
/**
 * LOOK's bench for bug 166 — "why does it pause or break in between sentences" on the Qwen3 voice
 * (dev only).
 *
 * It renders a real five-sentence reply through the app's OWN chain — the real sidecar
 * (native/qwen/qwen_server.py, the user's Python and model), then main/native/tts-dsp.ts's silence
 * gate and question ramp, then the helper's own scheduling (the chunks butt together in the
 * player's FIFO, with `pauseMs` of silence appended after each line) — and MEASURES the joins
 * instead of judging them by ear.
 *
 *   node app/look/qwen-flow.mjs [--voice vivian] [--out DIR] [--model-dir DIR] [--python P]
 *
 * Writes <out>/<variant>.wav (24 kHz, what the helper is handed and plays) and report.json.
 *
 * Per variant (before = sentence chunks + the Kokoro pause table; after = grouped chunks + the
 * Qwen table and tail) it reports, per BOUNDARY:
 *   gapMs        the silence a listener actually hears across the join: the trailing silence left
 *                on chunk N, plus the pause the helper appends, plus the leading silence on N+1.
 *   stepDb       the level of the 200 ms of speech either side of the join. A boundary that steps
 *                is heard as a new take starting, not as the same person carrying on.
 *   f0Step       the pitch centre either side, in semitones.
 *   centroidHz   the spectral centroid either side: "brighter" in a number.
 * and per CHUNK: lead/tail silence, the worst gap INSIDE it (which is the model's own
 * sentence-final pause — the thing every boundary is being matched to), and the onset level, so a
 * fade that eats a word's first phoneme shows up.
 *
 * Dev only: app/scripts/package.mjs ships an ALLOWLIST, so nothing under look/ reaches the build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const dsp = await import(path.join(APP, "src/main/native/tts-dsp.ts"));
const sen = await import(path.join(APP, "src/renderer/voice/sentences.ts"));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HOME = os.homedir();
const SR = 24_000;
const VOICE = arg("voice", "vivian");
const PY = arg("python", path.join(HOME, "Library/Application Support/Synapse/qwen/.venv/bin/python"));
const OUT = path.resolve(arg("out", path.join(APP, "..", "test-reports", "qwen-flow")));
function findModel() {
  const given = arg("model-dir", "");
  if (given) return given;
  for (const repo of ["models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", "models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice"]) {
    const snaps = path.join(HOME, ".cache/huggingface/hub", repo, "snapshots");
    if (!fs.existsSync(snaps)) continue;
    for (const d of fs.readdirSync(snaps)) {
      const dir = path.join(snaps, d);
      if (fs.existsSync(path.join(dir, "model.safetensors"))) return dir;
    }
  }
  throw new Error("no Qwen3 model found");
}
const MODEL = findModel();

// ---- the reply: five sentences, the shapes a real answer has ----
const REPLY = "I pulled the numbers for last quarter, and they look better than we expected. "
  + "Revenue was up nine percent, and churn finally came down for the first time since March. "
  + "The renewals team thinks the pricing change did most of it. "
  + "Do you want me to put the whole thing in a note for Thursday? "
  + "I can have it ready tonight.";

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
  constructor(o = {}) {
    const script = o.script ?? path.join(APP, "native/qwen/qwen_server.py");
    this.c = spawn("/usr/bin/arch", ["-arm64", o.python ?? PY, "-s", "-E", script, "--model-dir", o.model ?? MODEL, "--voice", o.voice ?? VOICE], { stdio: ["pipe", "pipe", "pipe"] });
    this.c.on("exit", (code) => { this.dead = `the sidecar exited (${code})`; this.onDead?.(); });
    this.jobs = new Map();
    let rest = Buffer.alloc(0);
    this.c.stdout.on("data", (d) => {
      rest = readFrames(Buffer.concat([rest, d]), (h, pcm) => {
        if (h.type === "warm") this.onWarm?.();
        const j = h.id ? this.jobs.get(h.id) : null;
        if (!j) return;
        if (h.type === "audio" && pcm.length) j.audio(pcm, h.seq ?? 0);
        if (h.type === "done") { this.jobs.delete(h.id); j.done(h); }
        if (h.type === "error") { this.jobs.delete(h.id); j.error(new Error(h.message ?? "failed")); }
      });
    });
    this.c.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  }
  /** Resolves true when it is warm, false when it died or took longer than `ms` (never hangs the bench). */
  warm(ms = 180_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      const ok = (v) => { clearTimeout(t); resolve(v); };
      this.onWarm = () => ok(true);
      this.onDead = () => ok(false);
      this.c.stdin.write(`${JSON.stringify({ op: "warm" })}\n`);
    });
  }
  synth(id, text, o = {}) {
    return new Promise((resolve, reject) => {
      const frames = [];
      const t0 = Date.now();
      let firstMs = 0;
      this.jobs.set(id, {
        audio: (pcm) => { if (!firstMs) firstMs = Date.now() - t0; frames.push(pcm); },
        done: (info) => resolve({ frames, info, firstMs }),
        error: reject,
      });
      this.c.stdin.write(`${JSON.stringify({ op: "synth", id, text, voice: VOICE, speed: 1, quality: "live", targetRms: 0.064, ...o })}\n`);
    });
  }
  /** The Kokoro sidecar's synth takes no quality or level — those are Qwen's own two fields. */
  synthPlain(id, text, voice) {
    return new Promise((resolve, reject) => {
      const frames = [];
      const t0 = Date.now();
      let firstMs = 0;
      this.jobs.set(id, {
        audio: (pcm) => { if (!firstMs) firstMs = Date.now() - t0; frames.push(pcm); },
        done: (info) => resolve({ frames, info, firstMs }),
        error: reject,
      });
      this.c.stdin.write(`${JSON.stringify({ op: "synth", id, text, voice, speed: 1 })}\n`);
    });
  }
  stop() { try { this.c.stdin.end(); } catch { /* gone */ } }
}

// ---- the app's chain, and then the helper's player ----
function throughChain(text, frames, prosody) {
  const got = [];
  const sink = { audio: (pcm) => got.push(Buffer.from(pcm)), done: () => {}, error: (m) => { throw new Error(m); } };
  const h = dsp.withProsody(text, sink, prosody);
  for (const f of frames) h.audio(f, 0);
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  const all = Buffer.concat(got);
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return new Float32Array(a.buffer, 0, a.length >>> 2);
}
const floats = (frames) => {
  const all = Buffer.concat(frames);
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return new Float32Array(a.buffer, 0, a.length >>> 2);
};

// ---- measurement ----
const GATE = 0.003; // the gate the silence filter itself uses, so "silence" means the same thing
const HOP = SR / 100; // 10 ms
function blocks(x) {
  const n = Math.floor(x.length / HOP);
  const r = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = 0; i < HOP; i++) { const v = x[f * HOP + i]; s += v * v; }
    r[f] = Math.sqrt(s / HOP);
  }
  return r;
}
function silences(x) {
  const r = blocks(x);
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return { leadMs: (x.length / SR) * 1000, tailMs: 0, innerMs: 0, innerAt: 0, speech: false };
  let inner = 0;
  let innerAt = 0;
  let run = 0;
  for (let f = first; f <= last; f++) {
    if (r[f] < GATE) { run++; if (run > inner) { inner = run; innerAt = f - run + 1; } } else run = 0;
  }
  return { leadMs: first * 10, tailMs: (r.length - 1 - last) * 10 + ((x.length - r.length * HOP) / SR) * 1000, innerMs: inner * 10, innerAt: innerAt * 10, speech: true };
}
/** Every silence INSIDE the line that is at least `minMs` long: the model's own sentence pauses. */
function innerGaps(x, minMs = 60) {
  const r = blocks(x);
  const out = [];
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return out;
  let run = 0;
  for (let f = first; f <= last; f++) {
    if (r[f] < GATE) run++;
    else { if (run * 10 >= minMs) out.push(run * 10); run = 0; }
  }
  return out;
}
const db = (v) => 20 * Math.log10(v + 1e-10);
/** The sidecar's own level measure: RMS over the audible samples (qwen_server.voiced_rms). */
function voicedRms(x, floor = 0.01) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > floor) { s += x[i] * x[i]; n++; }
  return n < 32 ? 0 : Math.sqrt(s / n);
}
/** The silences inside `x` at least `minMs` long, with where each one starts and ends (samples). */
function gapSpans(x, minMs) {
  const r = blocks(x);
  const out = [];
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return out;
  let run = 0;
  for (let f = first; f <= last; f++) {
    if (r[f] < GATE) run++;
    else { if (run * 10 >= minMs) out.push({ ms: run * 10, from: (f - run) * HOP, to: f * HOP }); run = 0; }
  }
  return out;
}
/** RMS of `ms` of SPEECH at one end of the line (skipping the silence at that end). */
function edgeRms(x, ms, from) {
  const r = blocks(x);
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return 0;
  const n = Math.round(ms / 10);
  let s = 0;
  let c = 0;
  const lo = from === "head" ? first : Math.max(first, last - n + 1);
  const hi = from === "head" ? Math.min(last, first + n - 1) : last;
  for (let f = lo; f <= hi; f++) { s += r[f] * r[f]; c++; }
  return c ? Math.sqrt(s / c) : 0;
}
/** Median F0 (Hz) over the voiced frames of `ms` at one end, by autocorrelation. */
function edgeF0(x, ms, from) {
  const r = blocks(x);
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return 0;
  const n = Math.round(ms / 10);
  const lo = from === "head" ? first : Math.max(first, last - n + 1);
  const hi = from === "head" ? Math.min(last, first + n - 1) : last;
  const W = Math.round(SR * 0.04);
  const minLag = Math.round(SR / 400);
  const maxLag = Math.round(SR / 70);
  const hz = [];
  for (let f = lo; f <= hi; f++) {
    const a = f * HOP;
    if (a + W + maxLag >= x.length) break;
    let e0 = 0;
    for (let i = 0; i < W; i++) e0 += x[a + i] * x[a + i];
    if (Math.sqrt(e0 / W) < GATE * 4) continue;
    let bestLag = 0;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      let e1 = 0;
      for (let i = 0; i < W; i++) { s += x[a + i] * x[a + i + lag]; e1 += x[a + i + lag] * x[a + i + lag]; }
      const sc = s / Math.sqrt(e0 * e1 + 1e-12);
      if (sc > best) { best = sc; bestLag = lag; }
    }
    if (best > 0.5 && bestLag) hz.push(SR / bestLag);
  }
  if (!hz.length) return 0;
  hz.sort((a, b) => a - b);
  return hz[hz.length >> 1];
}
/** Spectral centroid (Hz) over `ms` of speech at one end — "brightness", as a number. */
function edgeCentroid(x, ms, from) {
  const r = blocks(x);
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  if (first < 0) return 0;
  const n = Math.round(ms / 10);
  const lo = (from === "head" ? first : Math.max(first, last - n + 1)) * HOP;
  const hi = Math.min(x.length, ((from === "head" ? Math.min(last, first + n - 1) : last) + 1) * HOP);
  // A cheap DFT over 32 bands is plenty for a centroid.
  const N = 512;
  let num = 0;
  let den = 0;
  for (let a = lo; a + N <= hi; a += N) {
    for (let k = 1; k < N / 2; k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
        const t = (2 * Math.PI * k * i) / N;
        re += x[a + i] * w * Math.cos(t);
        im -= x[a + i] * w * Math.sin(t);
      }
      const m = Math.sqrt(re * re + im * im);
      num += m * ((k * SR) / N);
      den += m;
    }
  }
  return den > 0 ? num / den : 0;
}

function wav(file, x) {
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b);
}

/** The helper's player: the chunks butt together in the FIFO, with pauseMs of silence after each. */
function playOut(pieces) {
  const parts = [];
  for (const p of pieces) {
    parts.push(p.pcm);
    if (p.pauseMs > 0) parts.push(new Float32Array(Math.round((SR * p.pauseMs) / 1000)));
  }
  const n = parts.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  const marks = [];
  for (const p of pieces) {
    marks.push({ start: at, end: at + p.pcm.length });
    at += p.pcm.length + (p.pauseMs > 0 ? Math.round((SR * p.pauseMs) / 1000) : 0);
  }
  at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { out, marks };
}

const r1 = (v) => Math.round(v * 10) / 10;

async function variant(side, name, chunks, pauseOf, prosody) {
  const pieces = [];
  for (const [i, text] of chunks.entries()) {
    const { frames, info, firstMs } = await side.synth(`${name}-${i}`, text);
    const raw = floats(frames);
    const pcm = throughChain(text, frames, prosody);
    pieces.push({ text, pcm, raw, info, firstMs, pauseMs: pauseOf(text) });
  }
  const { out, marks } = playOut(pieces);
  wav(path.join(OUT, `${name}.wav`), out);
  const chunkRows = pieces.map((p, i) => {
    const s = silences(p.pcm);
    const rawS = silences(p.raw);
    return {
      i, text: p.text.slice(0, 44), chars: p.text.length, ms: r1((p.pcm.length / SR) * 1000), firstAudioMs: p.firstMs,
      pauseMs: p.pauseMs,
      leadMs: r1(s.leadMs), tailMs: r1(s.tailMs),
      rawLeadMs: r1(rawS.leadMs), rawTailMs: r1(rawS.tailMs),
      innerGapsMs: innerGaps(p.pcm).map(r1),
      onsetDb: r1(db(edgeRms(p.pcm, 30, "head"))), rawOnsetDb: r1(db(edgeRms(p.raw, 30, "head"))),
      levelDb: r1(db(edgeRms(p.pcm, 100000, "head"))),
      voicedRms: Math.round(voicedRms(p.pcm) * 10000) / 10000,
    };
  });
  const joins = [];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i];
    const b = pieces[i + 1];
    const sa = silences(a.pcm);
    const sb = silences(b.pcm);
    joins.push({
      at: `${i}|${i + 1}`,
      gapMs: r1(sa.tailMs + a.pauseMs + sb.leadMs),
      tailMs: r1(sa.tailMs), pauseMs: a.pauseMs, leadMs: r1(sb.leadMs),
      stepDb: r1(db(edgeRms(b.pcm, 200, "head")) - db(edgeRms(a.pcm, 200, "tail"))),
      f0Before: r1(edgeF0(a.pcm, 300, "tail")), f0After: r1(edgeF0(b.pcm, 300, "head")),
      centroidBefore: Math.round(edgeCentroid(a.pcm, 200, "tail")), centroidAfter: Math.round(edgeCentroid(b.pcm, 200, "head")),
    });
    const f0a = joins.at(-1).f0Before;
    const f0b = joins.at(-1).f0After;
    joins.at(-1).f0StepSt = f0a > 0 && f0b > 0 ? r1(12 * Math.log2(f0b / f0a)) : null;
  }
  const modelOwn = pieces.flatMap((p) => innerGaps(p.pcm));
  return {
    name, chunks: chunkRows, joins,
    wav: path.join(OUT, `${name}.wav`),
    totalMs: r1((out.length / SR) * 1000),
    firstAudioMs: pieces[0].firstMs,
    modelOwnSentenceGapsMs: modelOwn.map(r1),
    marks,
  };
}

// ---- run ----
const side = new Sidecar();
await side.warm();
const report = { voice: VOICE, model: MODEL, reply: REPLY, variants: [] };

// Reference: the whole reply as ONE render, which is what the model's own flow sounds like.
{
  const { frames, firstMs } = await side.synth("ref", REPLY);
  const raw = floats(frames);
  wav(path.join(OUT, "reference-one-render.wav"), raw);
  // The model's OWN sentence boundaries, inside one render: the bar every join is measured against.
  const own = gapSpans(raw, 380).map((g) => {
    const before = raw.subarray(0, g.from);
    const after = raw.subarray(g.to);
    const f0a = edgeF0(before, 300, "tail");
    const f0b = edgeF0(after, 300, "head");
    return {
      gapMs: g.ms,
      stepDb: r1(db(edgeRms(after, 200, "head")) - db(edgeRms(before, 200, "tail"))),
      f0StepSt: f0a > 0 && f0b > 0 ? r1(12 * Math.log2(f0b / f0a)) : null,
      centroidStep: Math.round(edgeCentroid(after, 200, "head") - edgeCentroid(before, 200, "tail")),
    };
  });
  report.reference = {
    wav: path.join(OUT, "reference-one-render.wav"),
    firstAudioMs: firstMs, ms: r1((raw.length / SR) * 1000),
    leadMs: r1(silences(raw).leadMs), tailMs: r1(silences(raw).tailMs),
    voicedRms: r1(voicedRms(raw) * 1000) / 1000,
    ownSentenceGapsMs: innerGaps(raw).map(r1),
    ownBoundaries: own,
  };
  console.log(`model's own boundaries (one render): ${own.map((b) => `${b.gapMs} ms / ${b.stepDb} dB / ${b.f0StepSt} st`).join("  |  ")}`);
}

const SENTENCES = new sen.SentenceChunker().finish(REPLY);
report.sentenceSplit = SENTENCES;

// BEFORE: a chunk per sentence, the Kokoro pause table, today's prosody.
report.variants.push(await variant(side, "before-sentences", SENTENCES, (t) => sen.pauseMsFor(t), dsp.PROSODY_DEFAULT));

// AFTER: whatever the new chunker and the Qwen table say (both are read from the app's own code,
// so this bench scores exactly what ships).
const grouped = sen.QWEN_CHUNK ? new sen.SentenceChunker({ group: sen.QWEN_CHUNK }).finish(REPLY) : SENTENCES;
report.groupedSplit = grouped;
const qwenPause = sen.QWEN_PAUSE_MS ? (t) => sen.pauseMsFor(t, sen.QWEN_PAUSE_MS) : (t) => sen.pauseMsFor(t);
const qwenProsody = dsp.PROSODY_QWEN ?? dsp.PROSODY_DEFAULT;
report.variants.push(await variant(side, "after-grouped", grouped, qwenPause, qwenProsody));

// THE HYBRID SEAM: the reply opens in the Bot's Kokoro voice while Qwen loads, and the rest streams
// from Qwen. That one switch is the loudest join in the reply if anything about it is wrong.
const KOKORO_DIR = (() => {
  for (const repo of ["models--mlx-community--Kokoro-82M-4bit", "models--prince-canuma--Kokoro-82M"]) {
    const snaps = path.join(HOME, ".cache/huggingface/hub", repo, "snapshots");
    if (!fs.existsSync(snaps)) continue;
    for (const d of fs.readdirSync(snaps)) if (fs.existsSync(path.join(snaps, d, "config.json"))) return path.join(snaps, d);
  }
  return null;
})();
// The Kokoro sidecar needs its own Python (kokoro + misaki); the Qwen env has neither.
const KOKORO_PY = arg("kokoro-python", path.resolve(HERE, "../../.build-cache/stage/kokoro/python/bin/python3.12"));
if (KOKORO_DIR && fs.existsSync(KOKORO_PY)) {
  const KV = "af_heart";
  const KOKORO_RMS = 0.0545; // KOKORO_LEVELS[af_heart] — what the app hands Qwen for this Bot
  const k = new Sidecar({ script: path.join(APP, "native/kokoro/kokoro_server.py"), model: KOKORO_DIR, voice: KV, python: KOKORO_PY });
  if (!(await k.warm())) { k.stop(); throw new Error(`the Kokoro sidecar never warmed (${k.dead ?? "timed out"})`); }
  const opener = sen.speechText(report.groupedSplit[0]);
  const kf = await k.synthPlain("hy-0", opener, KV);
  k.stop();
  const kPcm = throughChain(opener, kf.frames, dsp.PROSODY_DEFAULT);
  const rest = [];
  for (const [i, text] of report.groupedSplit.slice(1).entries()) {
    const { frames, firstMs } = await side.synth(`hy-${i + 1}`, text, { targetRms: KOKORO_RMS });
    rest.push({ text, pcm: throughChain(text, frames, qwenProsody), firstMs, pauseMs: qwenPause(text) });
  }
  const pieces = [{ text: opener, pcm: kPcm, firstMs: kf.firstMs, pauseMs: sen.pauseMsFor(report.groupedSplit[0]) }, ...rest];
  const { out } = playOut(pieces);
  wav(path.join(OUT, "after-hybrid.wav"), out);
  const sa = silences(kPcm);
  const sb = silences(rest[0].pcm);
  const f0a = edgeF0(kPcm, 300, "tail");
  const f0b = edgeF0(rest[0].pcm, 300, "head");
  report.hybridSeam = {
    wav: path.join(OUT, "after-hybrid.wav"),
    kokoroVoice: KV, openerFirstAudioMs: kf.firstMs, qwenFirstAudioMs: rest[0].firstMs,
    sampleRate: SR, // both sidecars emit at the player's own rate; nothing resamples at the seam
    gapMs: r1(sa.tailMs + pieces[0].pauseMs + sb.leadMs), pauseMs: pieces[0].pauseMs,
    kokoroVoicedRms: Math.round(voicedRms(kPcm) * 10000) / 10000,
    qwenVoicedRms: Math.round(voicedRms(rest[0].pcm) * 10000) / 10000,
    levelStepDb: r1(db(voicedRms(rest[0].pcm)) - db(voicedRms(kPcm))),
    edgeStepDb: r1(db(edgeRms(rest[0].pcm, 200, "head")) - db(edgeRms(kPcm, 200, "tail"))),
    f0StepSt: f0a > 0 && f0b > 0 ? r1(12 * Math.log2(f0b / f0a)) : null,
  };
  console.log(`\nhybrid seam (Kokoro ${KV} → Qwen ${VOICE}): gap ${report.hybridSeam.gapMs} ms, level step ${report.hybridSeam.levelStepDb} dB (${report.hybridSeam.kokoroVoicedRms} → ${report.hybridSeam.qwenVoicedRms}), edge step ${report.hybridSeam.edgeStepDb} dB, f0 ${report.hybridSeam.f0StepSt} st, both at ${SR} Hz`);
} else {
  console.log("\nno Kokoro model or Python found: the hybrid seam was not measured");
}

side.stop();
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const v of report.variants) {
  console.log(`\n== ${v.name}  ${v.chunks.length} chunks, ${v.totalMs} ms, first audio ${v.firstAudioMs} ms`);
  for (const c of v.chunks) console.log(`  [${c.i}] ${c.ms} ms lead ${c.leadMs} tail ${c.tailMs} (raw ${c.rawLeadMs}/${c.rawTailMs}) pause ${c.pauseMs} inner ${JSON.stringify(c.innerGapsMs)} onset ${c.onsetDb} dB`);
  for (const j of v.joins) console.log(`  join ${j.at}: gap ${j.gapMs} ms (tail ${j.tailMs} + pause ${j.pauseMs} + lead ${j.leadMs})  step ${j.stepDb} dB  f0 ${j.f0Before}->${j.f0After} Hz (${j.f0StepSt} st)  centroid ${j.centroidBefore}->${j.centroidAfter} Hz`);
}
console.log(`\nmodel's own sentence gaps, one render: ${JSON.stringify(report.reference.ownSentenceGapsMs)} ms; lead ${report.reference.leadMs} tail ${report.reference.tailMs}`);
console.log(`report: ${path.join(OUT, "report.json")}`);
