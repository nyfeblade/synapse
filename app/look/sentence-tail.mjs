#!/usr/bin/env node
/**
 * LOOK's bench for bug 180 — "the voice chops at the end of each sentence before it starts a new
 * sentence" (dev only).
 *
 * It renders a real multi-sentence reply through the app's OWN chain — the real sidecar (Kokoro or
 * Qwen3, the user's Python and model), main/native/tts-dsp.ts's silence gate / ramp / tail, the
 * renderer's own sentence split and pause table — and then through the helper's OWN player path: a
 * Swift build of Dictation.swift's own `Converter` class (one AVAudioConverter, 24 -> 48 kHz, kept
 * across lines), fed one call per buffer the chain emits, with the pause after each line played the
 * way the helper plays it (--pause direct: 48 kHz zeros onto the player, as shipped before bug 180;
 * converter: through the converter, as now), butted together the way the FIFO plays them. Then
 * it MEASURES every sentence end against a single render of the same text, where the model's own
 * endings are intact.
 *
 *   node app/look/sentence-tail.mjs --engine kokoro|qwen --tag before|after [--reuse] [--voice V]
 *     [--dsp <tts-dsp.ts>] [--swift <Dictation.swift>] [--slice 4096|none] [--pause direct|converter]
 *
 * --reuse scores the chain over the raw renders saved by an earlier run (<out>/<engine>/raw/), so a
 * before/after compares two code paths over ONE synthesis (Kokoro is not bit-deterministic).
 *
 * Per sentence end (all levels against that sentence's own loudest 5 ms):
 *   lastLoud       the end of the last 5 ms block within 30 dB of the peak: "the last loud sample".
 *   modelDecayMs   how long the model's OWN render takes, from there, to fall 55 dB below the peak
 *                  (the raw sidecar chunk, before our chain touches it).
 *   keptMs         how much of that the chain actually hands the helper after lastLoud.
 *   cutDb          the level of the raw audio at the point the chain ends the chunk: where in the
 *                  decay the cut lands. A natural ending is cut in silence (≤ -55); a chop is not.
 *   endDb          the level of the last 10 ms the chain emits before its closing fade.
 * Per join, on the 48 kHz FIFO output:
 *   maxJumpAtJoin  the biggest sample-to-sample step within 2 ms of either edge of the silence
 *                  heard between the sentences (the longest run under -100 dBFS there).
 *   edgeSamples    |x| at the last sample before that silence and the first one after it.
 *   carryMs/Db     audio of sentence N that the converter holds back and plays AFTER the pause.
 *   gapMs          silence (10 ms RMS < 0.003) heard between the two sentences.
 * And first audio: sidecar synth start -> the first buffer the chain hands the helper.
 *
 * Dev only: app/scripts/package.mjs ships an ALLOWLIST, so nothing under look/ reaches the build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
// --dsp <module>: score another tts-dsp (e.g. the shipped one, `git show HEAD:…`) over the same renders.
const dspAt = process.argv.indexOf("--dsp");
const dsp = await import(dspAt > 0 ? path.resolve(process.argv[dspAt + 1]) : path.join(APP, "src/main/native/tts-dsp.ts"));
const sen = await import(path.join(APP, "src/renderer/voice/sentences.ts"));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const HOME = os.homedir();
const SR = 24_000;
const ENGINE = arg("engine", "kokoro");
const TAG = arg("tag", "before");
// How the helper plays the pause after a line: "direct" (48 kHz zeros straight onto the player, as
// shipped before bug 180) or "converter" (the line's own rate, through the converter, as now).
const PAUSE = arg("pause", "converter");
// Which Dictation.swift's Converter to play through, and the slice the Speaker gives it (bug 180).
const SWIFT = path.resolve(arg("swift", path.join(APP, "native/dictation/Dictation.swift")));
const SLICE = arg("slice", "4096") === "none" ? 0 : Number(arg("slice", "4096"));
const REUSE = has("reuse");
const OUT = path.resolve(arg("out", path.join(APP, "..", "test-reports", "voice-sentence-tail")), ENGINE);
const RAW = path.join(OUT, "raw");
const VOICE = arg("voice", ENGINE === "qwen" ? "vivian" : "af_heart");

function snapshot(repos, file) {
  for (const repo of repos) {
    const snaps = path.join(HOME, ".cache/huggingface/hub", repo, "snapshots");
    if (!fs.existsSync(snaps)) continue;
    for (const d of fs.readdirSync(snaps)) if (fs.existsSync(path.join(snaps, d, file))) return path.join(snaps, d);
  }
  return null;
}
const SIDE = ENGINE === "qwen"
  ? {
    script: path.join(APP, "native/qwen/qwen_server.py"),
    python: arg("python", path.join(HOME, "Library/Application Support/Synapse/qwen/.venv/bin/python")),
    model: arg("model-dir", snapshot(["models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"], "model.safetensors")),
    extra: { quality: "live", targetRms: 0.064 },
  }
  : {
    script: path.join(APP, "native/kokoro/kokoro_server.py"),
    // What findKokoro picks (portable install): the runtime and model the app bundles, as
    // `node app/scripts/kokoro-runtime.mjs stage .build-cache/stage` leaves them.
    python: arg("python", path.resolve(APP, "../.build-cache/stage/kokoro/python/bin/python3.12")),
    model: arg("model-dir", path.resolve(APP, "../.build-cache/stage/kokoro/model")),
    extra: {},
  };

// ---- the reply: five sentences, the shapes a real answer has (the same one bug 166 measured) ----
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
  constructor() {
    this.c = spawn("/usr/bin/arch", ["-arm64", SIDE.python, "-s", "-E", SIDE.script, "--model-dir", SIDE.model, "--voice", VOICE], { stdio: ["pipe", "pipe", "pipe"] });
    this.c.on("exit", (code) => { this.dead = `the sidecar exited (${code})`; this.onDead?.(); });
    this.jobs = new Map();
    let rest = Buffer.alloc(0);
    this.c.stdout.on("data", (d) => {
      rest = readFrames(Buffer.concat([rest, d]), (h, pcm) => {
        if (h.type === "warm") this.onWarm?.();
        const j = h.id ? this.jobs.get(h.id) : null;
        if (!j) return;
        if (h.type === "audio" && pcm.length) j.audio(pcm);
        if (h.type === "done") { this.jobs.delete(h.id); j.done(h); }
        if (h.type === "error") { this.jobs.delete(h.id); j.error(new Error(h.message ?? "failed")); }
      });
    });
    this.c.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  }
  warm(ms = 240_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      const ok = (v) => { clearTimeout(t); resolve(v); };
      this.onWarm = () => ok(true);
      this.onDead = () => ok(false);
      this.c.stdin.write(`${JSON.stringify({ op: "warm" })}\n`);
    });
  }
  /** Frames with the wall-clock ms each one arrived after the synth was sent. */
  synth(id, text) {
    return new Promise((resolve, reject) => {
      const frames = [];
      const at = [];
      const t0 = performance.now();
      this.jobs.set(id, {
        audio: (pcm) => { at.push(Math.round(performance.now() - t0)); frames.push(pcm); },
        done: () => resolve({ frames, at }),
        error: reject,
      });
      this.c.stdin.write(`${JSON.stringify({ op: "synth", id, text, voice: VOICE, speed: 1, ...SIDE.extra })}\n`);
    });
  }
  stop() { try { this.c.stdin.end(); } catch { /* gone */ } }
}

// ---- raw renders: saved, so --reuse scores two code paths over the same audio ----
function saveRaw(name, r) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(path.join(RAW, `${name}.f32`), Buffer.concat(r.frames));
  fs.writeFileSync(path.join(RAW, `${name}.json`), JSON.stringify({ sizes: r.frames.map((f) => f.length), at: r.at }));
}
function loadRaw(name) {
  const all = fs.readFileSync(path.join(RAW, `${name}.f32`));
  const meta = JSON.parse(fs.readFileSync(path.join(RAW, `${name}.json`), "utf8"));
  const frames = [];
  let o = 0;
  for (const n of meta.sizes) { frames.push(Buffer.from(all.subarray(o, o + n))); o += n; }
  return { frames, at: meta.at };
}
const floats = (bufs) => {
  const all = Buffer.concat(bufs);
  const a = Buffer.allocUnsafeSlow(all.length);
  all.copy(a);
  return new Float32Array(a.buffer, 0, a.length >>> 2);
};

// ---- the app's chain: frames in as they arrived, buffers out as the helper would get them ----
function throughChain(text, r, prosody) {
  const got = [];
  let firstEmitFrame = -1;
  let frameNo = 0;
  const sink = {
    audio: (pcm) => { if (firstEmitFrame < 0) firstEmitFrame = frameNo; got.push(Buffer.from(pcm)); },
    done: () => {}, error: (m) => { throw new Error(m); },
  };
  const h = dsp.withProsody(text, sink, prosody);
  for (const f of r.frames) { h.audio(f, frameNo); frameNo++; }
  h.done({ synthMs: 0, audioMs: 0, rtf: 0, firstMs: 0 });
  // A line that only emits at "done" (a held question) plays when the last frame has arrived.
  const firstAudioMs = firstEmitFrame >= 0 ? r.at[Math.min(firstEmitFrame, r.at.length - 1)] : r.at.at(-1);
  return { pcm: floats(got), buffers: got, firstAudioMs };
}

// ---- the helper's player, offline: Dictation.swift's Converter + the FIFO ----
const FIFO_SWIFT = `import AVFoundation
__CONVERTER__
func log(_ s: String) {}
let inFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
let conv = Converter(to: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!__SLICE__)
// The converter is warmed once, as a live session's is by the lines before this reply.
do { let w = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: 24000)!; w.frameLength = 24000; for k in 0..<24000 { w.floatChannelData![0][k] = 0 }; _ = conv.convert(w) }
var out = [Float]()
var marks = [String]()
var fedOut = 0 // 48 kHz samples the converter owes for everything fed to it so far
var gotOut = 0 // …and what it has handed back
func push(_ b: AVAudioPCMBuffer) {
  fedOut += Int(b.frameLength) * 2
  if let o = conv.convert(b) { gotOut += Int(o.frameLength); out.append(contentsOf: UnsafeBufferPointer(start: o.floatChannelData![0], count: Int(o.frameLength))) }
}
let args = Array(CommandLine.arguments.dropFirst())
for spec in args.dropFirst() {
  // pcmPath|sizesPath|pauseMs|direct-or-converter — one convert() per buffer the chain handed the helper.
  let p = spec.split(separator: "|").map(String.init)
  let d = try! Data(contentsOf: URL(fileURLWithPath: p[0]))
  let n = d.count / 4
  let x: [Float] = d.withUnsafeBytes { Array($0.bindMemory(to: Float.self).prefix(n)) }
  let sizes = try! String(contentsOfFile: p[1], encoding: .utf8).split(separator: ",").compactMap { Int($0) }
  let startOut = out.count
  var i = 0
  for m in sizes where m > 0 {
    let b = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(m))!
    b.frameLength = AVAudioFrameCount(m)
    for k in 0..<m { b.floatChannelData![0][k] = x[i + k] }
    push(b)
    i += m
  }
  let speechEnd = out.count
  let held = fedOut - gotOut // this line's own end, still inside the converter
  let pauseMs = Double(p[2])!
  if p[3] == "converter" {
    // Bug 180's helper: the pause is made at the line's own rate and goes through the converter.
    let pn = Int((24000 * pauseMs / 1000).rounded())
    if pn > 0 { let z = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(pn))!; z.frameLength = AVAudioFrameCount(pn); for k in 0..<pn { z.floatChannelData![0][k] = 0 }; push(z) }
  } else {
    // The shipped helper: the pause is 48 kHz zeros scheduled straight onto the player.
    out.append(contentsOf: [Float](repeating: 0, count: Int((48000 * pauseMs / 1000).rounded())))
  }
  marks.append("{\\"start\\":\\(startOut),\\"speechEnd\\":\\(speechEnd),\\"pauseEnd\\":\\(out.count),\\"held\\":\\(held),\\"direct\\":\\(p[3] != "converter"),\\"in\\":\\(i)}")
}
try! out.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: URL(fileURLWithPath: args[0]))
print("[" + marks.joined(separator: ",") + "]")
`;
function playOut(pieces) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sentence-tail-"));
  try {
    // The helper's OWN Converter class, lifted out of Dictation.swift (or another copy of it, --swift),
    // so this plays exactly what the helper plays rather than a transcription of it.
    const src = fs.readFileSync(SWIFT, "utf8");
    const from = src.indexOf("final class Converter {");
    const to = src.indexOf("\n}\n", from) + 3;
    if (from < 0 || to < 3) throw new Error(`no Converter class in ${SWIFT}`);
    const sliced = /init\(to: AVAudioFormat, slice:/.test(src.slice(from, to));
    fs.writeFileSync(path.join(tmp, "fifo.swift"), FIFO_SWIFT.replace("__CONVERTER__", src.slice(from, to)).replace("__SLICE__", sliced && SLICE ? `, slice: ${SLICE}` : ""));
    execFileSync("swiftc", ["-O", path.join(tmp, "fifo.swift"), "-o", path.join(tmp, "fifo")], { stdio: "pipe" });
    const specs = pieces.map((p, i) => {
      fs.writeFileSync(path.join(tmp, `${i}.f32`), Buffer.concat(p.buffers));
      fs.writeFileSync(path.join(tmp, `${i}.txt`), p.buffers.map((b) => b.length >>> 2).join(","));
      return `${path.join(tmp, `${i}.f32`)}|${path.join(tmp, `${i}.txt`)}|${p.pauseMs}|${PAUSE}`;
    });
    const marks = JSON.parse(execFileSync(path.join(tmp, "fifo"), [path.join(tmp, "out.f32"), ...specs]).toString());
    const b = fs.readFileSync(path.join(tmp, "out.f32"));
    const a = Buffer.allocUnsafeSlow(b.length);
    b.copy(a);
    return { out: new Float32Array(a.buffer, 0, a.length >>> 2), marks };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- measurement ----
const GATE = 0.003;
const db = (v) => 20 * Math.log10(v + 1e-10);
const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 10) / 10);
function blockRms(x, sr, ms) {
  const hop = Math.round((sr * ms) / 1000);
  const n = Math.floor(x.length / hop);
  const r = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) { const v = x[f * hop + i]; s += v * v; }
    r[f] = Math.sqrt(s / hop);
  }
  return { r, hop };
}
/**
 * One sentence's ending in `x[from, to)`: the end of its last loud block, and how long its own
 * audio then takes to fall 55 dB below its peak. `to` is where the audio we have stops.
 */
function ending(x, from, to, sr = SR) {
  const seg = x.subarray(from, to);
  const { r, hop } = blockRms(seg, sr, 5);
  let peak = 0;
  for (const v of r) peak = Math.max(peak, v);
  if (peak <= 0) return null;
  let last = -1;
  for (let f = r.length - 1; f >= 0; f--) if (r[f] >= peak * 10 ** (-30 / 20)) { last = f; break; }
  const lastLoud = (last + 1) * hop; // samples into seg
  let quiet = -1;
  for (let f = last + 1; f < r.length; f++) if (r[f] < peak * 10 ** (-55 / 20)) { quiet = f; break; }
  return { peak, lastLoud: from + lastLoud, decayMs: quiet >= 0 ? ((quiet * hop - lastLoud) / sr) * 1000 : ((seg.length - lastLoud) / sr) * 1000, decayReached: quiet >= 0 };
}
/** RMS of `x[a, b)` in dB against `peak`. */
function levelDb(x, a, b, peak) {
  let s = 0;
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return hi > lo ? db(Math.sqrt(s / (hi - lo))) - db(peak) : null;
}
/**
 * Where in the raw chunk the chain STOPPED. Everything but the 5 ms fades is the raw samples
 * untouched (the gate only drops or shortens silences), so the unfaded stretch just before the
 * closing fade is found in the raw audio by exact match, searching back from the end.
 */
function cutPoint(raw, pcm) {
  const probe = pcm.length - Math.round(SR * 0.006) - 8;
  if (probe < 1) return -1;
  for (let i = raw.length - 8; i >= 1; i--) {
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) ok = Math.abs(raw[i + k] - pcm[probe + k]) < 1e-7;
    if (ok) return i + (pcm.length - probe);
  }
  return -1;
}
/** Every silence inside the raw single render at least `minMs` long: the model's own sentence gaps. */
function gapSpans(x, minMs) {
  const { r, hop } = blockRms(x, SR, 10);
  const out = [];
  let first = -1;
  let last = -1;
  for (let f = 0; f < r.length; f++) if (r[f] >= GATE) { if (first < 0) first = f; last = f; }
  let run = 0;
  for (let f = first; f <= last; f++) {
    if (r[f] < GATE) run++;
    else { if (run * 10 >= minMs) out.push({ ms: run * 10, from: (f - run) * hop, to: f * hop }); run = 0; }
  }
  return out;
}
function wav(file, x, sr = SR) {
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b);
}

// ---- run ----
const chunks = ENGINE === "qwen" ? new sen.SentenceChunker({ group: sen.QWEN_CHUNK }).finish(REPLY) : new sen.SentenceChunker().finish(REPLY);
const prosody = ENGINE === "qwen" ? dsp.PROSODY_QWEN : dsp.PROSODY_DEFAULT;
const pauseOf = (t) => (ENGINE === "qwen" ? sen.pauseMsFor(t, sen.QWEN_PAUSE_MS) : sen.pauseMsFor(t));

let side = null;
if (!REUSE) {
  side = new Sidecar();
  if (!(await side.warm())) throw new Error(`the ${ENGINE} sidecar never warmed (${side.dead ?? "timed out"})`);
  saveRaw("reference", await side.synth("ref", sen.speechText(REPLY)));
  for (const [i, t] of chunks.entries()) saveRaw(`chunk-${i}`, await side.synth(`c${i}`, sen.speechText(t)));
  side.stop();
}

// The reference: the whole reply in one render — the model's own sentence endings, untouched.
const ref = floats(loadRaw("reference").frames);
wav(path.join(OUT, "reference-one-render.wav"), ref);
const refGaps = gapSpans(ref, 60);
const refEnds = [];
{
  let from = 0;
  for (const g of refGaps) {
    const e = ending(ref, from, g.to);
    if (e) refEnds.push({ atMs: r1((g.from / SR) * 1000), gapMs: g.ms, decayTo55Ms: r1(e.decayMs), silentFromLoudMs: r1(((g.from - e.lastLoud) / SR) * 1000) });
    from = g.to;
  }
}

const pieces = [];
for (const [i, t] of chunks.entries()) {
  const r = loadRaw(`chunk-${i}`);
  const raw = floats(r.frames);
  const c = throughChain(sen.speechText(t), r, prosody);
  pieces.push({ text: t, raw, ...c, pauseMs: pauseOf(t), rawFirstMs: r.at[0] });
}
const endings = pieces.map((p, i) => {
  const e = ending(p.raw, 0, p.raw.length);
  const cutAt = cutPoint(p.raw, p.pcm); // where in the raw chunk the chain stopped
  const kept = cutAt >= 0 ? cutAt - e.lastLoud : null;
  // endDb: the last 10 ms before the chain's 5 ms closing fade, against the raw chunk's peak.
  const endDb = levelDb(p.pcm, p.pcm.length - Math.round(SR * 0.015), p.pcm.length - Math.round(SR * 0.005), e.peak);
  return {
    i, text: p.text.trim().slice(0, 48), pauseMs: p.pauseMs,
    modelDecayMs: r1(e.decayMs), keptMs: kept === null ? null : r1((kept / SR) * 1000),
    cutDb: cutAt >= 0 ? r1(levelDb(p.raw, cutAt - Math.round(SR * 0.005), cutAt + Math.round(SR * 0.005), e.peak)) : null,
    endDb: r1(endDb),
    lastSample: Math.round(Math.abs(p.pcm[p.pcm.length - 1]) * 1e5) / 1e5,
    rawTailMs: r1(((p.raw.length - e.lastLoud) / SR) * 1000),
    firstAudioMs: p.firstAudioMs, sidecarFirstFrameMs: p.rawFirstMs,
  };
});

const { out, marks } = playOut(pieces);
wav(path.join(OUT, `${TAG}-chain-48k.wav`), out, 48_000);
const joins = [];
for (let k = 0; k + 1 < marks.length; k++) {
  const a = marks[k];
  const b = marks[k + 1];
  const w = 96; // 2 ms at 48 kHz
  // Where the SILENCE actually is: the longest run under -100 dBFS between sentence k's last buffer
  // and sentence k+1's first 100 ms. (With the pause through the converter, k's held end plays
  // after speechEnd, so the join into silence is wherever that end finishes.)
  let bestA = a.speechEnd;
  let bestB = a.speechEnd;
  for (let i = Math.max(0, a.speechEnd - w), runA = -1; i < Math.min(out.length, b.start + 4800); i++) {
    if (Math.abs(out[i]) < 1e-5) { if (runA < 0) runA = i; if (i + 1 - runA > bestB - bestA) { bestA = runA; bestB = i + 1; } } else runA = -1;
  }
  let jump = 0;
  for (const edge of [bestA, bestB]) for (let i = Math.max(1, edge - w); i < Math.min(out.length, edge + w); i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
  // The converter's hold-back: audio from sentence k that plays after the pause, at the head of k+1.
  let carryE = 0;
  let carryN = 0;
  for (let i = b.start; i < b.start + 96 && i < out.length; i++) { carryE += out[i] * out[i]; carryN++; }
  // Silence heard across the join: from the last 10 ms block at or over GATE to the next one.
  const { r, hop } = blockRms(out, 48_000, 10);
  let lastA = Math.min(r.length - 1, Math.floor(a.pauseEnd / hop));
  while (lastA > 0 && r[lastA] < GATE) lastA--;
  let firstB = Math.floor(b.start / hop);
  while (firstB < r.length && r[firstB] < GATE) firstB++;
  joins.push({
    at: `${k}|${k + 1}`,
    maxJumpAtJoin: Math.round(jump * 1e5) / 1e5,
    // |x| on either side of the silence: the last sample of sentence k and the first of k+1.
    edgeSamples: [Math.round(Math.abs(out[Math.max(0, bestA - 1)]) * 1e5) / 1e5, Math.round(Math.abs(out[Math.min(out.length - 1, bestB)]) * 1e5) / 1e5],
    carryDb: r1(db(Math.sqrt(carryE / Math.max(1, carryN)))),
    // Sentence k's own end, still inside the converter when its pause is scheduled. Played AFTER the
    // pause when the pause bypasses the converter; in order (at the head of the pause) when it doesn't.
    heldMs: r1((a.held / 48_000) * 1000),
    tailAfterPauseMs: r1((a.direct ? (a.pauseEnd > a.speechEnd ? a.held : 0) : Math.max(0, a.held - (a.pauseEnd - a.speechEnd))) / 48),
    gapMs: (firstB - lastA - 1) * 10,
    pauseMs: pieces[k].pauseMs,
  });
}
// The speech's own sample-to-sample steps, for scale: a join jump well under this is inaudible.
let speechJump = 0;
for (let i = 1; i < out.length; i++) speechJump = Math.max(speechJump, Math.abs(out[i] - out[i - 1]));

const report = {
  engine: ENGINE, voice: VOICE, tag: TAG, pause: PAUSE, swift: SWIFT, slice: SLICE, model: SIDE.model, reused: REUSE, prosody,
  reply: REPLY, chunks,
  reference: { wav: "reference-one-render.wav", sentenceEnds: refEnds },
  endings, joins,
  summary: {
    minKeptMs: r1(Math.min(...endings.map((e) => e.keptMs ?? Infinity))),
    medianKeptMs: r1(endings.map((e) => e.keptMs).sort((x, y) => x - y)[endings.length >> 1]),
    medianModelDecayMs: r1(endings.map((e) => e.modelDecayMs).sort((x, y) => x - y)[endings.length >> 1]),
    worstCutDb: r1(Math.max(...endings.map((e) => e.cutDb ?? -Infinity))),
    worstEndDb: r1(Math.max(...endings.map((e) => e.endDb ?? -Infinity))),
    maxJoinJump: Math.max(...joins.map((j) => j.maxJumpAtJoin)),
    maxHeldMs: Math.max(...joins.map((j) => j.heldMs)),
    maxTailAfterPauseMs: Math.max(...joins.map((j) => j.tailAfterPauseMs)),
    worstCarryDb: r1(Math.max(...joins.map((j) => j.carryDb))),
    speechMaxJump: Math.round(speechJump * 1e5) / 1e5,
    gapsMs: joins.map((j) => j.gapMs),
    referenceGapsMs: refEnds.map((e) => e.gapMs),
    referenceDecayTo55Ms: refEnds.map((e) => e.decayTo55Ms),
    firstAudioMs: endings[0].firstAudioMs,
  },
  wav: `${TAG}-chain-48k.wav`,
};
fs.writeFileSync(path.join(OUT, `report-${TAG}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`== ${ENGINE}/${VOICE} ${TAG}${REUSE ? " (reused renders)" : ""}`);
console.log(`reference sentence ends: ${refEnds.map((e) => `gap ${e.gapMs} ms, decay ${e.decayTo55Ms} ms`).join(" | ")}`);
for (const e of endings) console.log(`  [${e.i}] model decay ${e.modelDecayMs} ms, kept ${e.keptMs} ms, cut at ${e.cutDb} dB, end ${e.endDb} dB, last ${e.lastSample}, first audio ${e.firstAudioMs} ms  "${e.text}"`);
for (const j of joins) console.log(`  join ${j.at}: jump ${j.maxJumpAtJoin} edges ${j.edgeSamples} carry ${j.carryDb} dB held ${j.heldMs} ms (after the pause: ${j.tailAfterPauseMs}) gap ${j.gapMs} ms (pause ${j.pauseMs})`);
console.log(JSON.stringify(report.summary));
