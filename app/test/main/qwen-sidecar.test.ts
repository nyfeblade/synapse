import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KOKORO_LEVELS } from "../../src/main/native/qwen";

/**
 * Bug 164: the sidecar's DSP — the resample to the player's rate, the level match that makes the
 * mid-reply handover inaudible, and the per-line seed that stops a voice drifting between sessions
 * — is Python, so it is tested as Python. These are the parts a wrong answer makes AUDIBLE, and
 * asserting them in TypeScript would only be asserting a second implementation of them.
 *
 * It runs against any Python on this Mac with numpy (the user's Qwen env first, then the ones a dev
 * machine tends to have) and skips when there is none, the same way the native tests skip.
 */
const SCRIPT = path.resolve(__dirname, "../../native/qwen/qwen_server.py");

function pythonWithNumpy(): string | null {
  const tries = [
    path.join(os.homedir(), "Library", "Application Support", "Synapse", "qwen", ".venv", "bin", "python"),
    // Bug 285: a Mac whose app hasn't launched since the rename still has the engine under the old name (only looked for).
    path.join(os.homedir(), "Library", "Application Support", "Bots", "qwen", ".venv", "bin", "python"),
    // The runtime the app bundles (portable install), as `node app/scripts/kokoro-runtime.mjs stage .build-cache/stage` leaves it.
    path.resolve(__dirname, "../../../.build-cache/stage/kokoro/python/bin/python3.12"),
    "python3",
  ];
  for (const py of tries) {
    try {
      // -B everywhere: no bytecode is written into the user's env or the bundled runtime.
      execFileSync(py, ["-B", "-c", "import numpy"], { stdio: "ignore", timeout: 20_000 });
      return py;
    } catch { /* not this one */ }
  }
  return null;
}

const PY = pythonWithNumpy();

/** Run `code` with the sidecar imported as `q` and numpy as `np`; returns its parsed JSON output. */
function run<T>(code: string): T {
  const prelude = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT))})`,
    "import numpy as np",
    "import qwen_server as q",
  ].join("\n");
  const out = execFileSync(PY!, ["-B", "-c", `${prelude}\n${code}`], { encoding: "utf8", timeout: 60_000 });
  return JSON.parse(out.trim().split("\n").at(-1)!) as T;
}

describe.skipIf(PY === null)("the Qwen sidecar's audio handling (bug 164)", () => {
  it("is the file the build actually ships", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it("emits at the rate the helper's player expects, which is Kokoro's", () => {
    // Everything downstream — the frame decoder, the prosody chain, the phrase cache, the Swift
    // player — assumes 24 kHz mono float32. The sidecar must agree with them, not with the model.
    expect(run<number>("print(json.dumps(q.SAMPLE_RATE))")).toBe(24000);
    expect(run<number>("print(json.dumps(q.FRAME_SAMPLES))")).toBe(12000);
  });

  it("leaves audio alone when the model already emits the player's rate", () => {
    // Qwen is 24 kHz on this build, so the resample is normally a no-op and must cost nothing.
    const same = run<boolean>([
      "a = np.sin(np.arange(2400, dtype=np.float32) * 0.05).astype(np.float32)",
      "b = q.resample(a, 24000, 24000, np)",
      "print(json.dumps(bool(b is a)))",
    ].join("\n"));
    expect(same).toBe(true);
  });

  it("converts a different rate to the player's, keeping the duration", () => {
    // A future checkpoint at another rate must play at the right PITCH, not be handed over raw.
    const r = run<{ len: number; ratio: number }>([
      "a = np.sin(2 * np.pi * 220 * np.arange(16000, dtype=np.float64) / 16000).astype(np.float32)",
      "b = q.resample(a, 16000, 24000, np)",
      "print(json.dumps({'len': int(len(b)), 'ratio': float(len(b)) / len(a)}))",
    ].join("\n"));
    expect(r.len).toBe(24000); // one second in, one second out
    expect(r.ratio).toBeCloseTo(1.5, 5);
  });

  it("resamples downwards too, and keeps the waveform rather than the samples", () => {
    const r = run<{ len: number; rms: number }>([
      "a = np.sin(2 * np.pi * 200 * np.arange(48000, dtype=np.float64) / 48000).astype(np.float32)",
      "b = q.resample(a, 48000, 24000, np)",
      "print(json.dumps({'len': int(len(b)), 'rms': float(np.sqrt(np.mean(b.astype(np.float64) ** 2)))}))",
    ].join("\n"));
    expect(r.len).toBe(24000);
    // A sine's RMS is 1/sqrt(2) whatever it is sampled at; a broken resample loses that immediately.
    expect(r.rms).toBeCloseTo(0.7071, 2);
  });

  it("survives an empty or impossible rate instead of throwing mid-call", () => {
    expect(run<number>("print(json.dumps(int(len(q.resample(np.zeros(0, np.float32), 16000, 24000, np)))))")).toBe(0);
    expect(run<number>("print(json.dumps(int(len(q.resample(np.zeros(100, np.float32), 0, 24000, np)))))")).toBe(100);
  });

  it("measures level over the audible part, so trailing silence can't drag it down", () => {
    const r = run<{ voiced: number; naive: number }>([
      "speech = np.full(24000, 0.1, dtype=np.float32)",
      "a = np.concatenate([speech, np.zeros(72000, dtype=np.float32)])",
      "print(json.dumps({'voiced': q.voiced_rms(a, np), 'naive': float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))}))",
    ].join("\n"));
    expect(r.voiced).toBeCloseTo(0.1, 3);
    // The naive figure is halved by the silence; using it would make every line too loud.
    expect(r.naive).toBeLessThan(0.06);
  });

  it("scales a line onto the target level asked for", () => {
    const g = run<number>("print(json.dumps(q.gain_for(0.11, 0.0545)))");
    expect(g).toBeCloseTo(0.0545 / 0.11, 6);
    const applied = run<number>([
      "a = np.full(24000, 0.11, dtype=np.float32)",
      "b = q.apply_gain(a, q.gain_for(q.voiced_rms(a, np), 0.0545), np)",
      "print(json.dumps(q.voiced_rms(b, np)))",
    ].join("\n"));
    expect(applied).toBeCloseTo(0.0545, 3);
  });

  it("holds each of the nine Kokoro levels the app sends, and clamps a wild one", () => {
    // These are the numbers the hybrid hands over; the sidecar must accept them all as-is.
    const targets = Object.values(KOKORO_LEVELS);
    const accepted = run<number[]>([
      `e = q.Engine("/nope", "vivian", q.DEFAULT_TARGET_RMS)`,
      `print(json.dumps([e.target_for(t) for t in ${JSON.stringify(targets)}]))`,
    ].join("\n"));
    expect(accepted).toEqual(targets);
    const fallbacks = run<number[]>([
      `e = q.Engine("/nope", "vivian", q.DEFAULT_TARGET_RMS)`,
      "print(json.dumps([e.target_for(None), e.target_for(0), e.target_for(9.9), e.target_for('loud')]))",
    ].join("\n"));
    expect(fallbacks.every((v) => v === fallbacks[0])).toBe(true);
  });

  it("never lets a gain push the signal past the rail", () => {
    // A quiet measurement on a loud line would otherwise clip flat, which is instantly audible.
    const peak = run<number>([
      "a = (np.sin(np.arange(24000, dtype=np.float64) * 0.1) * 0.8).astype(np.float32)",
      "b = q.apply_gain(a, 2.5, np)",
      "print(json.dumps(float(np.max(np.abs(b)))))",
    ].join("\n"));
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("gives the same line the same seed every time, and different lines different ones", () => {
    // Qwen samples at temperature: without this, a greeting drifts between sessions and the phrase
    // cache would hold one take while a live render produced another.
    const r = run<{ same: boolean; byText: boolean; byVoice: boolean }>([
      "a = q.seed_for('Hello there.', 'vivian')",
      "b = q.seed_for('Hello there.', 'vivian')",
      "c = q.seed_for('Hello there!', 'vivian')",
      "d = q.seed_for('Hello there.', 'ryan')",
      "print(json.dumps({'same': a == b, 'byText': a != c, 'byVoice': a != d}))",
    ].join("\n"));
    expect(r).toEqual({ same: true, byText: true, byVoice: true });
  });

  it("only accepts the nine voices the model has, and needs one", () => {
    // CustomVoice has no default speaker: generate() without a voice fails outright.
    const r = run<{ voices: string[]; good: boolean; bad: boolean; fallback: string }>([
      "print(json.dumps({'voices': list(q.VOICES), 'good': q.valid_voice('uncle_fu'), 'bad': q.valid_voice('../etc'), 'fallback': q.DEFAULT_VOICE}))",
    ].join("\n"));
    expect(r.voices).toHaveLength(9);
    expect(r.voices).toContain("vivian");
    expect(r.good).toBe(true);
    expect(r.bad).toBe(false);
    expect(r.voices).toContain(r.fallback);
  });

  /**
   * Bug 166: a live line fixed its gain from its first third of a second — often a breath, or one
   * quiet word — and a reply is several renders in a row, so each one's guess was heard as the level
   * STEPPING at the join. Measured through the real model (app/look/qwen-flow.mjs), the five renders
   * of one reply came out at 0.050 to 0.078 voiced RMS, a 3.8 dB spread on lines that all asked for
   * 0.064. With the refinement the same reply spans 0.99 dB and lands within 0.65 dB of the target.
   */
  it("refines a line's gain once a fuller measurement is in, and clamps the correction", () => {
    const r = run<{ up: number; down: number; tiny: number | null; wild: number }>([
      "print(json.dumps({",
      "  'up': q.refined_gain(1.0, 0.032, 0.064),",   // measured quieter than target: lift
      "  'down': q.refined_gain(1.0, 0.128, 0.064),", // measured louder: cut
      "  'tiny': q.refined_gain(1.0, 0.0645, 0.064),",// within 3%: leave it alone
      "  'wild': q.refined_gain(1.0, 1e-9, 0.064) or -1,",
      "}))",
    ].join("\n"));
    // Never more than MAX_REFINE either way: a bad measurement can move the level 2.5 dB, not decide it.
    expect(r.up).toBeCloseTo(1.33, 6);
    expect(r.down).toBeCloseTo(1 / 1.33, 6);
    expect(r.tiny).toBeNull();
    expect(r.wild).toBe(-1); // silence is never a measurement
  });

  it("glides to the refined gain instead of switching, so nothing pumps", () => {
    const r = run<{ first: number; last: number; ends: number; left: number; monotonic: boolean; after: number }>([
      "ramp, reached, left = q.glide(np, 6000, 1.0, 1.2, 12000)",
      "ramp2, reached2, left2 = q.glide(np, 12000, float(reached), 1.2, left)",
      "print(json.dumps({",
      "  'first': float(ramp[0]), 'last': float(ramp[-1]), 'ends': float(ramp2[-1]),",
      "  'left': int(left2), 'monotonic': bool(np.all(np.diff(ramp) >= -1e-7)),",
      "  'after': float(ramp2[6000]),",
      "}))",
    ].join("\n"));
    expect(r.first).toBeCloseTo(1.0, 5); // it starts exactly where the line already was
    expect(r.last).toBeCloseTo(1.1, 3); // half a glide in, half way there
    expect(r.monotonic).toBe(true);
    expect(r.ends).toBeCloseTo(1.2, 5); // and arrives, once
    expect(r.after).toBeCloseTo(1.2, 5); // then holds for the rest of the chunk
    expect(r.left).toBe(0);
  });

  it("the refinement window and glide are short enough to cost no latency", () => {
    const c = run<{ refine: number; glideS: number; max: number }>(
      "print(json.dumps({'refine': q.REFINE_S, 'glideS': q.GLIDE_S, 'max': q.MAX_REFINE}))");
    // The first audio goes out at the first estimate, exactly as before — the refinement only
    // touches audio that is already behind the playhead.
    expect(c.refine).toBeGreaterThanOrEqual(1);
    expect(c.glideS).toBeGreaterThanOrEqual(0.3);
    expect(c.max).toBeLessThanOrEqual(1.5);
  });

  // Bug 183: "it speaks like it's trying to sound lazy". The sidecar never gave the model a delivery
  // instruction, so each speaker fell back to its own casual default: ryan measured 9.5 chars/s on
  // real calls against Kokoro's 13-16. The 0.6B CustomVoice model does follow `instruct` (measured,
  // app/look/qwen-delivery.py: +13-17% syllables/s on vivian and ryan), so every line carries one.
  it("asks the model for a clear, crisp, steady delivery on every line, live and full", () => {
    const r = run<{ live: Record<string, unknown>; full: Record<string, unknown>; own: unknown; junk: unknown; long: unknown; d: string }>([
      "print(json.dumps({",
      "  'live': q.generate_kwargs('Hi there.', 'vivian', True),",
      "  'full': q.generate_kwargs('Hi there.', 'vivian', False),",
      "  'own': q.generate_kwargs('Hi.', 'ryan', True, 'Warm and slow.')['instruct'],",
      "  'junk': q.generate_kwargs('Hi.', 'ryan', True, 42)['instruct'],",
      "  'long': q.generate_kwargs('Hi.', 'ryan', True, 'x' * 999)['instruct'],",
      "  'd': q.DEFAULT_INSTRUCT}))",
    ].join("\n"));
    expect(r.d).toMatch(/clear/i);
    expect(r.live).toMatchObject({ text: "Hi there.", voice: "vivian", instruct: r.d, stream: true });
    expect(r.full).toMatchObject({ text: "Hi there.", voice: "vivian", instruct: r.d });
    expect(r.full.stream).toBeUndefined();
    // A per-Bot override rides on the synth command; anything that isn't a sane string is ignored.
    expect(r.own).toBe("Warm and slow.");
    expect(r.junk).toBe(r.d);
    expect(r.long).toBe(r.d);
  });

  // Bug 182: "why does the preview of the Qwen voice sound better than the actual conversation?"
  // A call line is "live": its gain is fixed from its opening third of a second, and a Qwen line opens
  // soft (a breath, a quiet first syllable), so the gain came out high — measured on real renders,
  // ryan's live lines sat +5.3 to +11.0 dB over their target (vivian +0.3 to +3.8), pushed into the
  // tanh rail, while the same lines rendered whole ("full", as greetings are) landed within 0.7 dB.
  // The refinement is clamped to 2.5 dB and could not pull that back. A voice's level is remembered
  // from the lines it has already said, so every line after the first starts at the right gain.
  it("a live line starts at the level this voice's earlier lines measured, not at its soft opening", () => {
    const r = run<{ first: number; second: number; third: number; target: number; saved: Record<string, number> }>([
      "import os, tempfile",
      "class R:",
      "  def __init__(s, a): s.audio = a; s.sample_rate = 24000",
      "class M:",
      "  def generate(s, **kw):",
      "    sr = 24000",
      "    t = np.arange(int(sr * 2.4)) / sr",
      "    x = 0.05 * np.sqrt(2) * np.sin(2 * np.pi * 180 * t)",       // speech at 0.05 RMS
      "    x[:int(sr * 0.44)] = 0",                                  // the model's silent lead
      "    x[int(sr * 0.44):int(sr * 0.74)] *= 0.3",                 // a soft, breathy opening
      "    for i in range(0, len(x), 11520): yield R(x[i:i + 11520].astype(np.float32))",
      "class MX:",
      "  class random:",
      "    @staticmethod",
      "    def seed(v): pass",
      "  @staticmethod",
      "  def eval(a): pass",
      "d = tempfile.mkdtemp()",
      "e = q.Engine('/m', 'vivian', 0.064, cache_dir=d)",
      "e.model, e.np, e.mx = M(), np, MX()",
      "lv = lambda: q.voiced_rms(np.concatenate(list(e.generate('Hi there.', 'ryan', 1.0, 'live', 0.064))), np)",
      "a = lv(); b = lv()",
      "e2 = q.Engine('/m', 'vivian', 0.064, cache_dir=d)",   // a new sidecar remembers it too
      "e2.model, e2.np, e2.mx = M(), np, MX()",
      "c = q.voiced_rms(np.concatenate(list(e2.generate('Hi there.', 'ryan', 1.0, 'live', 0.064))), np)",
      // A line with its own instruct neither moves nor uses the default delivery's level.
      "e2.levels['vivian'] = 0.05; before = dict(e2.levels)",
      "list(e2.generate('Hi there.', 'vivian', 1.0, 'live', 0.064, 'Whisper it.'))",
      "assert e2.levels == before, e2.levels",
      "import json as j2",
      "saved = j2.load(open(os.path.join(d, 'levels.json')))",
      "print(json.dumps({'first': a, 'second': b, 'third': c, 'target': 0.064, 'saved': saved}))",
    ].join("\n"));
    const db = (v: number) => 20 * Math.log10(v / r.target);
    // The first line of a voice still has only its opening to go on…
    expect(db(r.first)).toBeGreaterThan(1);
    // …every later one starts where this voice actually sits, in this sidecar and the next.
    expect(Math.abs(db(r.second))).toBeLessThan(1);
    expect(Math.abs(db(r.third))).toBeLessThan(1);
    expect(r.saved.ryan).toBeGreaterThan(0.04);
  });

  it("frames audio exactly the way the app's decoder reads it", () => {
    // The whole reason this sidecar drops into the existing engine interface.
    const r = run<{ head: number[]; headerLen: number; type: string }>([
      "import struct",
      "body = json.dumps({'type': 'audio', 'id': 'x', 'seq': 0, 'samples': 2}, separators=(',', ':')).encode()",
      "frame = struct.pack('>I', 2 + len(body) + 8) + struct.pack('>H', len(body)) + body + b'\\x00' * 8",
      "print(json.dumps({'head': list(frame[:4]), 'headerLen': struct.unpack('>H', frame[4:6])[0], 'type': json.loads(frame[6:6+len(body)])['type']}))",
    ].join("\n"));
    expect(r.type).toBe("audio");
    expect(r.headerLen).toBeGreaterThan(0);
  });
});
