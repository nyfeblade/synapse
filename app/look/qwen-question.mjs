#!/usr/bin/env node
/**
 * LOOK's bench for bug 181 — "when the bot asks me a question in the Qwen voice, it glitches at the
 * end" (dev only).
 *
 * Renders question lines through the real Qwen3 sidecar and then through every chain the app puts a
 * Qwen line through, and MEASURES the last 400 ms of each question against the model's own output of
 * the SAME render (so everything reported is what our chain did, not what the model did):
 *
 *   live    a call line: quality "live" (streamed), dictation.ts's qwenProsody(prosody())
 *   cached  a greeting / filler rendered ahead: quality "full", voice-cache.ts's prosody
 *
 *   node app/look/qwen-question.mjs [--voices vivian,ryan] [--tag before|after] [--reuse] [--dsp M]
 *
 * Per line, in the last 400 ms of speech (ending at the last sample within 30 dB of the peak):
 *   ramped         did the chain lift the pitch there? (median F0, chain vs model, in semitones)
 *   f0JumpSt       the biggest frame-to-frame pitch jump (10 ms frames), chain; and the model's own
 *   gainStepDb     the biggest 10 ms-to-10 ms step in (chain level / model level): what our gain did
 *   clickRatio     the worst sample step against the median step of the 10 ms around it, chain vs model
 *   keptMs/cutDb   the tail after the last loud sample, and where the cut lands (bug 180's measure)
 *   pauseMs        the pause the renderer asks for after it (QWEN_PAUSE_MS), '?' against '.'
 *
 * Writes <out>/<tag>-<path>-<voice>-<n>.wav (24 kHz) and report-<tag>.json.
 * Dev only: app/scripts/package.mjs ships an ALLOWLIST, so nothing under look/ reaches the build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const dspAt = process.argv.indexOf("--dsp");
const dsp = await import(dspAt > 0 ? path.resolve(process.argv[dspAt + 1]) : path.join(APP, "src/main/native/tts-dsp.ts"));
const sen = await import(path.join(APP, "src/renderer/voice/sentences.ts"));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HOME = os.homedir();
const SR = 24_000;
const TAG = arg("tag", "before");
const REUSE = process.argv.includes("--reuse");
const VOICES = arg("voices", "vivian,ryan").split(",");
const OUT = path.resolve(arg("out", path.join(APP, "..", "test-reports", "voice-sentence-tail", "qwen-questions")));
const RAW = path.join(OUT, "raw");
const PY = arg("python", path.join(HOME, "Library/Application Support/Synapse/qwen/.venv/bin/python"));
const MODEL = arg("model-dir", (() => {
  const snaps = path.join(HOME, ".cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots");
  for (const d of fs.readdirSync(snaps)) if (fs.existsSync(path.join(snaps, d, "model.safetensors"))) return path.join(snaps, d);
  throw new Error("no Qwen3 model");
})());

const LINES = [
  "Do you want me to put the whole thing in a note for Thursday?",
  "Should I send it now?",
  "What time works best for you tomorrow?",
  "I pulled the numbers for last quarter. Do you want me to send them over?",
  "Do you want the short version? I can keep it to two lines.",
  "I pulled the numbers for last quarter.", // a statement, for '?' against '.'
];
// The prosody each path applies, exactly as the app composes it.
const LIVE = dsp.qwenProsody(dsp.PROSODY_DEFAULT); // dictation.ts: qwenProsody(prosody())
// voice-cache.ts (it imports Electron, so it can't be loaded here): before bug 181 it handed a Qwen
// line the same prosody as a Kokoro one; now it hands it qwenProsody(). --cached kokoro|qwen.
const CACHED = arg("cached", TAG === "before" ? "kokoro" : "qwen") === "qwen" ? dsp.qwenProsody(dsp.PROSODY_DEFAULT) : dsp.PROSODY_DEFAULT;

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
  constructor(voice) {
    this.c = spawn("/usr/bin/arch", ["-arm64", PY, "-s", "-E", path.join(APP, "native/qwen/qwen_server.py"), "--model-dir", MODEL, "--voice", voice], { stdio: ["pipe", "pipe", "pipe"] });
    this.c.on("exit", (code) => { this.dead = `exit ${code}`; this.onDead?.(); });
    this.jobs = new Map();
    let rest = Buffer.alloc(0);
    this.c.stdout.on("data", (d) => {
      rest = readFrames(Buffer.concat([rest, d]), (h, pcm) => {
        if (h.type === "warm") this.onWarm?.();
        const j = h.id ? this.jobs.get(h.id) : null;
        if (!j) return;
        if (h.type === "audio" && pcm.length) j.frames.push(pcm);
        if (h.type === "done") { this.jobs.delete(h.id); j.resolve(j.frames); }
        if (h.type === "error") { this.jobs.delete(h.id); j.reject(new Error(h.message)); }
      });
    });
    this.c.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  }
  warm() {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 240_000);
      this.onWarm = () => { clearTimeout(t); resolve(true); };
      this.onDead = () => { clearTimeout(t); resolve(false); };
      this.c.stdin.write(`${JSON.stringify({ op: "warm" })}\n`);
    });
  }
  synth(id, text, voice, quality, targetRms) {
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { frames: [], resolve, reject });
      this.c.stdin.write(`${JSON.stringify({ op: "synth", id, text, voice, speed: 1, quality, targetRms })}\n`);
    });
  }
  stop() { try { this.c.stdin.end(); } catch { /* gone */ } }
}
const floats = (bufs) => {
  const all = Buffer.concat(bufs);
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return new Float32Array(a.buffer, 0, a.length >>> 2);
};
function saveRaw(name, frames) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(path.join(RAW, `${name}.f32`), Buffer.concat(frames));
  fs.writeFileSync(path.join(RAW, `${name}.json`), JSON.stringify(frames.map((f) => f.length)));
}
function loadRaw(name) {
  const all = fs.readFileSync(path.join(RAW, `${name}.f32`));
  const sizes = JSON.parse(fs.readFileSync(path.join(RAW, `${name}.json`), "utf8"));
  const out = [];
  let o = 0;
  for (const n of sizes) { out.push(Buffer.from(all.subarray(o, o + n))); o += n; }
  return out;
}
function chain(text, frames, p) {
  const got = [];
  const h = dsp.withProsody(text, { audio: (b) => got.push(Buffer.from(b)), done: () => {}, error: (m) => { throw new Error(m); } }, p);
  for (const f of frames) h.audio(f, 0);
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  return floats(got);
}

// ---- measurement ----
const db = (v) => 20 * Math.log10(v + 1e-10);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
function rmsAt(x, a, n) { let s = 0; for (let i = a; i < a + n && i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / n); }
/** The last sample within 30 dB of the loudest 10 ms, and that peak. */
function lastLoud(x) {
  const hop = 240;
  let peak = 0;
  for (let a = 0; a + hop <= x.length; a += hop) peak = Math.max(peak, rmsAt(x, a, hop));
  let a = Math.floor(x.length / hop) * hop - hop;
  while (a > 0 && rmsAt(x, a, hop) < peak * 10 ** (-30 / 20)) a -= hop;
  return { at: a + hop, peak };
}
/** Autocorrelation F0 over a 40 ms window at `a`, or 0 where it is not voiced. */
function f0At(x, a) {
  const W = 960;
  const lo = Math.round(SR / 400);
  const hi = Math.round(SR / 70);
  if (a < 0 || a + W + hi >= x.length) return 0;
  let e0 = 0;
  for (let i = 0; i < W; i++) e0 += x[a + i] * x[a + i];
  if (Math.sqrt(e0 / W) < 0.01) return 0;
  let best = 0;
  let lag = 0;
  for (let L = lo; L <= hi; L++) {
    let s = 0;
    let e1 = 0;
    for (let i = 0; i < W; i++) { s += x[a + i] * x[a + i + L]; e1 += x[a + i + L] * x[a + i + L]; }
    const c = s / Math.sqrt(e0 * e1 + 1e-12);
    if (c > best) { best = c; lag = L; }
  }
  return best > 0.6 ? SR / lag : 0;
}
function track(x, from, to) {
  const out = [];
  for (let a = from; a < to; a += 240) out.push(f0At(x, a - 480));
  return out;
}
const median = (v) => { const s = v.filter((z) => z > 0).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
function maxJumpSt(t) {
  let m = 0;
  for (let i = 1; i < t.length; i++) if (t[i] > 0 && t[i - 1] > 0) m = Math.max(m, Math.abs(12 * Math.log2(t[i] / t[i - 1])));
  return m;
}
function worstClick(x, from, to) {
  const W = 240;
  let worst = 0;
  for (let i = Math.max(W + 1, from); i < Math.min(x.length - W, to); i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d < 0.01) continue;
    const win = [];
    for (let k = i - W; k < i + W; k++) win.push(Math.abs(x[k] - x[k - 1]));
    win.sort((a, b) => a - b);
    worst = Math.max(worst, d / Math.max(win[W], 1e-4));
  }
  return worst;
}
/**
 * Where sample `probe` of `y` (the chain's output) sits in `x` (the model's), as an offset. The chain
 * only drops or shortens silences and rewrites the ramp window, so an unramped stretch before the
 * end is found in the model's audio by exact match — searched near the END, so a mid-line gap the
 * gate shortened earlier does not throw the alignment off.
 */
function offsetOf(x, y, probe) {
  if (probe < 0 || probe + 8 > y.length) return -1;
  for (let i = x.length - 8; i >= 0; i--) {
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) ok = Math.abs(x[i + k] - y[probe + k]) < 1e-6;
    if (ok) return i - probe;
  }
  return -1;
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

function measure(text, model, out) {
  const L = lastLoud(model);
  const lo = lastLoud(out);
  const win = Math.round(SR * 0.4);
  // Aligned 250 ms ahead of the window, clear of the ramp's read (which reaches ~60 ms before it).
  const off = offsetOf(model, out, lo.at - win - Math.round(SR * 0.25));
  const ta = track(out, lo.at - win, lo.at);
  // The model's pitch over the SAME stretch of the same render (or its own last 400 ms if unaligned).
  const tm = off >= 0 ? track(model, lo.at - win + off, lo.at + off) : track(model, L.at - win, L.at);
  // Gain: our level against the model's, 10 ms at a time, over the same stretch of the same render.
  let gainStep = 0;
  let prev = null;
  if (off >= 0) {
    for (let a = lo.at - win; a + 240 <= lo.at; a += 240) {
      const m = rmsAt(model, a + off, 240);
      const o = rmsAt(out, a, 240);
      if (m < L.peak * 0.03) { prev = null; continue; } // too quiet to say anything about a gain
      const g = db(o) - db(m);
      if (prev !== null) gainStep = Math.max(gainStep, Math.abs(g - prev));
      prev = g;
    }
  }
  const cut = off >= 0 ? off + out.length : -1;
  return {
    text,
    ramped: r2(12 * Math.log2((median(ta) || 1) / (median(tm) || 1))),
    f0JumpSt: r2(maxJumpSt(ta)), modelF0JumpSt: r2(maxJumpSt(tm)),
    gainStepDb: r2(gainStep),
    clickRatio: r2(worstClick(out, lo.at - win, out.length)), modelClickRatio: r2(worstClick(model, L.at - win, model.length)),
    keptMs: r1(((out.length - lo.at) / SR) * 1000),
    cutDb: cut >= 0 ? r1(db(rmsAt(model, Math.max(0, cut - 120), 240)) - db(L.peak)) : null,
    pauseMs: sen.pauseMsFor(text, sen.QWEN_PAUSE_MS),
    kokoroPauseMs: sen.pauseMsFor(text),
  };
}

const report = { tag: TAG, voices: VOICES, paths: { live: LIVE, cached: CACHED }, rows: [] };
for (const voice of VOICES) {
  let side = null;
  if (!REUSE) {
    side = new Sidecar(voice);
    if (!(await side.warm())) throw new Error(`qwen never warmed (${side.dead ?? "timeout"})`);
  }
  for (const [n, text] of LINES.entries()) {
    for (const [pathName, quality, target, p] of [["live", "live", 0.0545, LIVE], ["cached", "full", 0.064, CACHED]]) {
      const name = `${pathName}-${voice}-${n}`;
      if (side) saveRaw(name, await side.synth(name, text, voice, quality, target));
      const frames = loadRaw(name);
      const model = floats(frames);
      const out = chain(text, frames, p);
      wav(path.join(OUT, `${TAG}-${name}.wav`), out);
      if (TAG === "before") wav(path.join(OUT, `model-${name}.wav`), model);
      const m = measure(text, model, out);
      report.rows.push({ path: pathName, voice, n, ...m });
      console.log(`${pathName.padEnd(6)} ${voice.padEnd(6)} #${n} ramp ${m.ramped} st | f0 jump ${m.f0JumpSt} (model ${m.modelF0JumpSt}) | gain step ${m.gainStepDb} dB | click ${m.clickRatio} (model ${m.modelClickRatio}) | kept ${m.keptMs} ms cut ${m.cutDb} dB | pause ${m.pauseMs}  "${text.slice(-34)}"`);
    }
  }
  side?.stop();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `report-${TAG}.json`), `${JSON.stringify(report, null, 2)}\n`);
