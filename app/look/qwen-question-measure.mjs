#!/usr/bin/env node
/**
 * LOOK's measure for bug 190 — "Qwen3 voice still glitches at a question" (dev only).
 *
 * Reads what qwen-question-probe.py recorded (the model's own output AND the sidecar's, chunk by
 * chunk, from the same render), runs the sidecar's chunks through the app's chain exactly as
 * dictation.ts (live) and voice-cache.ts (cached, quality "full") compose it, and measures the LAST
 * 500 ms of speech of every line against the model's own audio of the same render:
 *
 *   gainDb        the sidecar's level against the model's, per 10 ms: its span across the last
 *                 500 ms, and the biggest 10 ms-to-10 ms step (a gain that moves there is a swell
 *                 or a dip the model never made)
 *   railDb        how far the soft-knee rail (tanh) pulled a chunk under its own gain
 *   f0JumpSt      the biggest 10 ms pitch jump of the final audio, and of the model's own
 *   click         the worst sample step against the median step around it, final vs model
 *   keptMs/cutDb  how much of the model's own tail survives, and how loud the model still is where
 *                 the chain cuts (a truncation shows as a cut well above the noise floor)
 *   silenceMs     silence the chain inserted that the model did not have (the pause after the line)
 *
 *   node app/look/qwen-question-measure.mjs --in DIR [--tag before|after] [--dsp path/to/tts-dsp.ts]
 *
 * Writes <in>/<tag>-<quality>-<voice>-<n>.wav (24 kHz: what the helper is handed) and <in>/report.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const IN = path.resolve(arg("in", path.join(APP, "..", "test-reports", "qwen-question", "before")));
const TAG = arg("tag", path.basename(IN));
const dsp = await import(path.resolve(arg("dsp", path.join(APP, "src/main/native/tts-dsp.ts"))));
const sen = await import(path.join(APP, "src/renderer/voice/sentences.ts"));
const SR = 24_000;
const { voices, lines } = JSON.parse(fs.readFileSync(path.join(IN, "lines.json"), "utf8"));
// What the app composes, per path. dictation.ts: qwenProsody(prosody()); voice-cache.ts: the same.
const P = dsp.qwenProsody(dsp.PROSODY_DEFAULT);

function load(name, kind) {
  const all = fs.readFileSync(path.join(IN, "raw", `${name}.${kind}.f32`));
  const sizes = JSON.parse(fs.readFileSync(path.join(IN, "raw", `${name}.${kind}.json`), "utf8"));
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return { x: new Float32Array(a.buffer, 0, a.length >>> 2), sizes };
}
function chain(text, x, sizes) {
  const got = [];
  const h = dsp.withProsody(text, { audio: (b) => got.push(Buffer.from(b)), done: () => {}, error: (m) => { throw new Error(m); } }, P);
  // The sidecar sends each chunk in frames of at most 0.5 s (Server.synth).
  let o = 0;
  for (const n of sizes) {
    for (let i = 0; i < n; i += SR / 2) {
      const m = Math.min(SR / 2, n - i);
      const b = Buffer.allocUnsafeSlow(m * 4);
      for (let k = 0; k < m; k++) b.writeFloatLE(x[o + i + k], k * 4);
      h.audio(b, 0);
    }
    o += n;
  }
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  const all = Buffer.concat(got);
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return new Float32Array(a.buffer, 0, a.length >>> 2);
}
const db = (v) => 20 * Math.log10(Math.abs(v) + 1e-10);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
function rmsAt(x, a, n) { let s = 0; for (let i = Math.max(0, a); i < a + n && i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / n); }
function lastLoud(x) {
  const hop = 240;
  let peak = 0;
  for (let a = 0; a + hop <= x.length; a += hop) peak = Math.max(peak, rmsAt(x, a, hop));
  let a = Math.floor(x.length / hop) * hop - hop;
  while (a > 0 && rmsAt(x, a, hop) < peak * 10 ** (-40 / 20)) a -= hop;
  return { at: a + hop, peak };
}
function f0At(x, a) {
  const W = 960, lo = Math.round(SR / 400), hi = Math.round(SR / 70);
  if (a < 0 || a + W + hi >= x.length) return 0;
  let e0 = 0;
  for (let i = 0; i < W; i++) e0 += x[a + i] * x[a + i];
  if (Math.sqrt(e0 / W) < 0.01) return 0;
  let best = 0, lag = 0;
  for (let L = lo; L <= hi; L++) {
    let s = 0, e1 = 0;
    for (let i = 0; i < W; i++) { s += x[a + i] * x[a + i + L]; e1 += x[a + i + L] * x[a + i + L]; }
    const c = s / Math.sqrt(e0 * e1 + 1e-12);
    if (c > best) { best = c; lag = L; }
  }
  return best > 0.6 ? SR / lag : 0;
}
function maxJumpSt(x, from, to) {
  let m = 0, prev = 0;
  for (let a = from; a < to; a += 240) {
    const f = f0At(x, a - 480);
    if (f > 0 && prev > 0) m = Math.max(m, Math.abs(12 * Math.log2(f / prev)));
    prev = f;
  }
  return m;
}
function worstClick(x, from, to) {
  const W = 240;
  let worst = 0, at = -1;
  for (let i = Math.max(W + 1, from); i < Math.min(x.length - W, to); i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d < 0.01) continue;
    const win = [];
    for (let k = i - W; k < i + W; k++) win.push(Math.abs(x[k] - x[k - 1]));
    win.sort((a, b) => a - b);
    const r = d / Math.max(win[W], 1e-4);
    if (r > worst) { worst = r; at = i; }
  }
  return { worst, at };
}
/** Where sample `probe` of `y` sits in `x`, as an offset (exact match, searched from the end). */
function offsetOf(x, y, probe) {
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
  fs.writeFileSync(file, b);
}

function measure(text, model, side, sizes, out) {
  const L = lastLoud(model);
  const win = Math.round(SR * 0.5);
  const from = Math.max(0, L.at - win);
  // The sidecar's gain against the model's, 10 ms at a time, over the last 500 ms of speech.
  const g = [];
  for (let a = from; a + 240 <= L.at; a += 240) {
    const m = rmsAt(model, a, 240);
    if (m < L.peak * 0.03) { g.push(null); continue; }
    g.push(db(rmsAt(side, a, 240)) - db(m));
  }
  const gv = g.filter((v) => v !== null);
  let gainStep = 0;
  for (let i = 1; i < g.length; i++) if (g[i] !== null && g[i - 1] !== null) gainStep = Math.max(gainStep, Math.abs(g[i] - g[i - 1]));
  // The rail: per chunk, the most the sidecar pulled a sample under the chunk's own median gain.
  let rail = 0, o = 0;
  for (const n of sizes) {
    const r = [];
    for (let i = o; i < o + n; i++) if (Math.abs(model[i]) > 0.02) r.push(side[i] / model[i]);
    if (r.length > 10) {
      const s = [...r].sort((a, b) => a - b);
      rail = Math.max(rail, db(s[s.length >> 1]) - db(s[0]));
    }
    o += n;
  }
  // The chain's output against the sidecar's: where the chain's last sample falls in the model.
  const lo = lastLoud(out);
  const off = offsetOf(side, out, Math.max(0, lo.at - Math.round(SR * 0.3)));
  const cut = off >= 0 ? off + out.length : -1;
  const ck = worstClick(out, lo.at - win, out.length);
  const mk = worstClick(model, from, model.length);
  return {
    text,
    gainSpanDb: r2(gv.length ? Math.max(...gv) - Math.min(...gv) : 0),
    gainStepDb: r2(gainStep),
    railDb: r2(rail),
    f0JumpSt: r2(maxJumpSt(out, lo.at - win, lo.at)), modelF0JumpSt: r2(maxJumpSt(model, from, L.at)),
    click: r2(ck.worst), modelClick: r2(mk.worst),
    clickMsFromEnd: ck.at >= 0 ? r1(((out.length - ck.at) / SR) * 1000) : null,
    keptMs: r1(((out.length - lo.at) / SR) * 1000),
    modelTailMs: r1(((model.length - L.at) / SR) * 1000),
    cutDb: cut >= 0 ? r1(db(rmsAt(model, cut - 120, 240)) - db(L.peak)) : null,
    lastSample: r2(out[out.length - 1] ?? 0),
    silenceMs: sen.pauseMsFor(text, sen.QWEN_PAUSE_MS),
  };
}

const rows = [];
for (const voice of voices) {
  for (const [n, text] of lines.entries()) {
    for (const quality of ["live", "full"]) {
      const name = `${quality}-${voice}-${n}`;
      const model = load(name, "model");
      const side = load(name, "sidecar");
      const out = chain(text, side.x, side.sizes);
      wav(path.join(IN, `${TAG}-${name}.wav`), out);
      const m = measure(text, model.x, side.x, side.sizes, out);
      rows.push({ quality, voice, n, ...m });
      console.log(`${quality.padEnd(4)} ${voice.padEnd(6)} #${n} gain span ${m.gainSpanDb} step ${m.gainStepDb} rail ${m.railDb} dB | f0 jump ${m.f0JumpSt} (model ${m.modelF0JumpSt}) | click ${m.click} (model ${m.modelClick}) | kept ${m.keptMs}/${m.modelTailMs} ms cut ${m.cutDb} dB | pause ${m.silenceMs}  "${text.slice(-30)}"`);
    }
  }
}
fs.writeFileSync(path.join(IN, "report.json"), `${JSON.stringify({ tag: TAG, prosody: P, rows }, null, 2)}\n`);
