import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  PROSODY_DEFAULT, PROSODY_OFF, endsQuestion, prosodyFrom, rampQuestionTail, voicedEnd, withProsody,
  type KokoroHandlers,
} from "../../src/main/native/kokoro";
import { registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

/**
 * Bug 156: Kokoro renders "…send it?" and "…send it." the same way — measured over the nine curated
 * voices at 0.95 / 1.0 / 1.05, the question's final syllable sits a median 0.27 semitones from the
 * statement's and FALLS in six of the nine. The punctuation is not lost on the way in (misaki hands the
 * model "ɪt?"), so we lift the end of a question ourselves, on the PCM, behind a flag. What matters
 * here: with the flag off — or on any line that is not a question — the bytes the helper receives are
 * the sidecar's own, unchanged; and the ramp really does raise the end and only the end.
 *
 * The measuring tape that produced the numbers is app/look/prosody.py (dev only, never packaged).
 */

const SR = 24_000;

/** A steady tone at `hz`, `ms` long, with the trailing silence Kokoro pads every line with. */
function tone(hz: number, ms: number, padMs = 600): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const x = new Float32Array(n + Math.round((SR * padMs) / 1000));
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
}

/** Mean period of `x` over [a, b), by counting rising zero crossings: a cheap, exact-enough F0. */
function f0(x: Float32Array, a: number, b: number): number {
  let crossings = 0;
  let firstAt = -1;
  let lastAt = -1;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (firstAt < 0) firstAt = i;
      lastAt = i;
      crossings++;
    }
  }
  return crossings < 2 ? 0 : (SR * (crossings - 1)) / (lastAt - firstAt);
}

const semitones = (a: number, b: number) => 12 * Math.log2(a / b);
const f32 = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.length * 4);
/** Float32Array throws on an unaligned byteOffset, and a Buffer out of Node's pool may well be one. */
function unpack(b: Buffer): Float32Array {
  const out = new Float32Array(b.length >>> 2);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

/** Bug 224: no shipped prosody lifts a question any more; the ramp itself (kept for measurements) is tested switched on. */
const RAMP = { ...PROSODY_DEFAULT, questionRamp: true };

describe("which lines are questions (bug 151)", () => {
  it("only the LAST sentence decides, and closing quotes stay with it", () => {
    for (const t of ["You want me to send it?", "Sure. Do you want me to send it?", 'He asked "why?"', "Really?  ", "Right?)"]) {
      expect(endsQuestion(t), t).toBe(true);
    }
    for (const t of ["You want me to send it.", "Do you want me to send it? Let me know.", "No way!", "Sure,", "", "?x"]) {
      expect(endsQuestion(t), t).toBe(false);
    }
  });

  it("anything that is not a string is not a question", () => {
    for (const t of [undefined, null, 42, {}, ["?"]]) expect(endsQuestion(t)).toBe(false);
  });
});

describe("the flag (bug 151)", () => {
  it("SYNAPSE_TTS_PROSODY=0 / off / false turns the ramp off; anything else leaves it on", () => {
    for (const v of ["0", "off", "false", "OFF", " 0 "]) expect(prosodyFrom({ SYNAPSE_TTS_PROSODY: v })).toEqual(PROSODY_OFF);
    for (const v of [undefined, "", "1", "on", "yes"]) expect(prosodyFrom({ SYNAPSE_TTS_PROSODY: v })).toEqual(PROSODY_DEFAULT);
  });
});

describe("finding the end of the voiced speech (bug 151)", () => {
  it("ignores Kokoro's trailing silence — the ramp has to end where the WORDS end", () => {
    const end = voicedEnd(tone(200, 800, 600));
    expect(end).toBeGreaterThan(SR * 0.7);
    expect(end).toBeLessThanOrEqual(SR * 0.82);
  });

  it("ignores an unvoiced /t/-like burst after the vowel (high zero-crossing rate, so no pitch)", () => {
    const x = tone(200, 800, 600);
    // 150 ms of loud noise where the final consonant and breath would be.
    let seed = 7;
    for (let i = Math.round(SR * 0.8); i < Math.round(SR * 0.95); i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      x[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.4;
    }
    expect(voicedEnd(x)).toBeLessThanOrEqual(SR * 0.82);
  });
});

describe("the ramp itself (bug 151)", () => {
  const opts = { semitones: 2, rampMs: 350 };

  it("raises the end of the line by the semitones asked for, and leaves the start alone", () => {
    const x = tone(200, 1200, 600);
    const y = rampQuestionTail(x, opts);
    const end = voicedEnd(x);
    // The first half of the word is untouched...
    expect(f0(y, 0, Math.round(SR * 0.4))).toBeCloseTo(200, 0);
    // ...and the last 100 ms of voiced speech is up by ~2 semitones.
    const lift = semitones(f0(y, end - Math.round(SR * 0.1), end), f0(x, end - Math.round(SR * 0.1), end));
    expect(lift).toBeGreaterThan(1.5);
    expect(lift).toBeLessThan(2.5);
  });

  it("is smooth: no click at the seam and no sample louder than the line already was", () => {
    const x = tone(200, 1200, 600);
    const y = rampQuestionTail(x, opts);
    let peak = 0;
    let jump = 0;
    for (let i = 1; i < y.length; i++) {
      peak = Math.max(peak, Math.abs(y[i]!));
      jump = Math.max(jump, Math.abs(y[i]! - y[i - 1]!));
    }
    expect(peak).toBeLessThanOrEqual(0.51);
    // A 200 Hz sine at 24 kHz steps at most 2*pi*200/24000*0.5 = 0.027 per sample; a click is orders more.
    expect(jump).toBeLessThan(0.05);
  });

  it("leaves a chunk too short to ramp exactly as it was (a filler is never worth an artefact)", () => {
    const x = tone(200, 120, 40);
    expect(rampQuestionTail(x, opts)).toBe(x);
    expect(rampQuestionTail(tone(200, 1200, 600), { semitones: 0, rampMs: 350 })).toBeInstanceOf(Float32Array);
    const flat = tone(200, 1200, 600);
    expect(rampQuestionTail(flat, { semitones: 0, rampMs: 350 })).toBe(flat);
  });

  it("does not mutate its input", () => {
    const x = tone(200, 1200, 600);
    const before = Float32Array.from(x);
    rampQuestionTail(x, opts);
    expect(x).toEqual(before);
  });
});

describe("withProsody: what actually reaches the helper (bug 151)", () => {
  function collect(text: string, p = RAMP) {
    const got: Buffer[] = [];
    const seqs: number[] = [];
    let done = 0;
    const h: KokoroHandlers = { audio: (b, s) => { got.push(Buffer.from(b)); seqs.push(s); }, done: () => { done++; }, error: () => {} };
    return { got, seqs, done: () => done, w: withProsody(text, h, p) };
  }

  it("the flag off: the same handlers come back, so the PCM is byte-identical and still streams", () => {
    const h: KokoroHandlers = { audio: () => {}, done: () => {}, error: () => {} };
    expect(withProsody("You want me to send it?", h, PROSODY_OFF)).toBe(h);
  });

  it("a line that is not a question streams frame by frame and is never held for its end", () => {
    const c = collect("You want me to send it.");
    const a = f32(tone(200, 500, 0));
    const b = f32(tone(200, 500, 0));
    c.w.audio(a, 0);
    expect(c.got).toHaveLength(1); // released immediately: nothing is held back
    c.w.audio(b, 1);
    c.w.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    // Unbroken speech, so the gate has nothing to drop: the same audio, same order, same total.
    // Bug 161: "the same audio" now means the same samples with a 5 ms raised cosine on each edge,
    // so the chunk meets the helper's pause silence at zero instead of mid-waveform. Everything
    // between those two edges is the sidecar's own bytes.
    const sent = unpack(Buffer.concat(c.got));
    const want = unpack(Buffer.concat([a, b]));
    expect(sent).toHaveLength(want.length);
    const fade = Math.round(SR * 0.005);
    for (let i = fade; i < want.length - fade; i++) expect(sent[i]).toBeCloseTo(want[i]!, 6);
    expect(Math.abs(sent[0]!)).toBeLessThan(1e-3);
    expect(Math.abs(sent[sent.length - 1]!)).toBeLessThan(1e-3);
    expect(c.done()).toBe(1);
  });

  it("with everything off the handlers come back untouched — the sidecar's own bytes reach the helper", () => {
    const c = collect("You want me to send it.", PROSODY_OFF);
    const a = f32(tone(200, 500, 300));
    c.w.audio(a, 0);
    c.w.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(Buffer.concat(c.got).equals(a)).toBe(true); // pad and all
    expect(c.seqs).toEqual([0]);
  });

  it("a question is held to the end, ramped, and released in frames — higher ending, pad gone", () => {
    const x = tone(200, 1200, 600);
    const pcm = f32(x);
    const c = collect("You want me to send it?");
    const half = pcm.length >>> 1;
    c.w.audio(pcm.subarray(0, half), 0);
    c.w.audio(pcm.subarray(half), 1);
    expect(c.got).toHaveLength(0); // nothing goes out until the line's end is known
    c.w.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    const out = Buffer.concat(c.got);
    // The gate ran first, so the 600 ms of trailing pad is gone and only the words are left.
    expect(out.length / 4 / SR).toBeCloseTo(1.2, 1);
    expect(c.seqs).toEqual([...c.seqs.keys()]); // seq numbers are contiguous from 0
    const y = unpack(out);
    const end = voicedEnd(y);
    const lift = semitones(f0(y, end - Math.round(SR * 0.1), end), f0(x, end - Math.round(SR * 0.1), end));
    expect(lift).toBeGreaterThan(3);
    expect(c.done()).toBe(1);
  });

  it("the gate alone drops Kokoro's lead and tail and caps a mid-line gap, without touching the words", () => {
    // 200 ms of pad, 300 ms of tone, a 900 ms gap, 300 ms of tone, 600 ms of pad.
    const parts = [new Float32Array(Math.round(SR * 0.2)), tone(200, 300, 0), new Float32Array(Math.round(SR * 0.9)), tone(200, 300, 0), new Float32Array(Math.round(SR * 0.6))];
    const x = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { x.set(p, at); at += p.length; }
    const c = collect("Some words here.");
    c.w.audio(f32(x), 0);
    c.w.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    const secs = Buffer.concat(c.got).length / 4 / SR;
    // 300 + (900 capped to 350) + 300 = 950 ms, give or take a 10 ms block.
    expect(secs).toBeGreaterThan(0.93);
    expect(secs).toBeLessThan(0.98);
  });

  it("a line shorter than one 10 ms block still reaches the helper — audio is never dropped on a guess", () => {
    const c = collect("Mm.");
    const tiny = f32(new Float32Array(100).fill(0.25));
    c.w.audio(tiny, 0);
    c.w.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    // Bug 161: every sample is still there, and the edge fade shrinks with the line (a quarter of it
    // at most), so a line this short is delivered rather than faded away to nothing.
    const sent = unpack(Buffer.concat(c.got));
    expect(sent).toHaveLength(100);
    expect(sent[50]).toBeCloseTo(0.25, 6);
  });

  it("the first speech is not delayed by the gate: it goes out on the frame it arrives in", () => {
    const c = collect("Hello there.");
    const lead = new Float32Array(Math.round(SR * 0.25));
    const first = new Float32Array(lead.length + Math.round(SR * 0.3));
    first.set(tone(200, 300, 0), lead.length);
    c.w.audio(f32(first), 0);
    expect(c.got.length).toBeGreaterThan(0); // no waiting for done
    expect(Buffer.concat(c.got).length / 4 / SR).toBeCloseTo(0.3, 1); // and the lead is already gone
  });

  it("an error on a held question drops the audio and reports it (no half a line played)", () => {
    const got: Buffer[] = [];
    let err = "";
    const w = withProsody("Send it?", { audio: (b) => got.push(b), done: () => {}, error: (m) => { err = m; } }, RAMP);
    w.audio(f32(tone(200, 500, 0)), 0);
    w.error("The natural voice stopped (exit 1).");
    expect(got).toHaveLength(0);
    expect(err).toMatch(/exit 1/);
  });
});

// ---- the wiring: dictation.speak hands the ramp the line it is about to say ----
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: string | null; pid: number;
  };
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  c.exitCode = null;
  c.signalCode = null;
  c.pid = 4242;
  return c;
}

describe("a call's questions go through the ramp (bug 151)", () => {
  function setup(prosody: typeof PROSODY_DEFAULT = RAMP) {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: ReturnType<typeof fakeChild>[] = [];
    const jobs: Array<{ job: { text: string }; h: KokoroHandlers }> = [];
    const tts = {
      isReady: () => true, isWarm: () => true, warm: () => {}, cancel: () => {},
      synth: (job: { text: string }, h: KokoroHandlers) => void jobs.push({ job, h }),
    };
    registerDictation({
      binary: "bots-dictation", log: () => {}, tts: tts as never, prosody: () => prosody,
      spawnFn: (() => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; }) as never,
    });
    return {
      kids, jobs,
      dispatch: (name: string, args: unknown) => handlers.get("native")!({}, { name, args }),
      pcmOut: () => Buffer.concat(kids[0]!.stdin.write.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("pcm "))
        .map((l) => Buffer.from(JSON.parse(l.slice(4)).data as string, "base64"))),
    };
  }

  const x = tone(200, 1200, 600);

  it("a statement streams straight through, with Kokoro's trailing pad dropped", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "You want me to send it.", voice: "kokoro:af_bella" });
    h.jobs[0]!.h.audio(f32(x), 0);
    expect(h.pcmOut().length).toBeGreaterThan(0); // not held: the words are already on their way
    h.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(h.pcmOut().length / 4 / SR).toBeCloseTo(1.2, 1); // 1200 ms of words, 600 ms of pad gone
  });

  it("a question's PCM is lifted at the end — and is byte-identical again with the flag off", async () => {
    const on = setup();
    await on.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await on.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "You want me to send it?", voice: "kokoro:af_bella" });
    on.jobs[0]!.h.audio(f32(x), 0);
    expect(on.pcmOut()).toHaveLength(0); // held until the line ends
    on.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    const out = on.pcmOut();
    const y = unpack(out);
    const end = voicedEnd(y);
    expect(semitones(f0(y, end - Math.round(SR * 0.1), end), f0(x, end - Math.round(SR * 0.1), end))).toBeGreaterThan(3);

    const off = setup(PROSODY_OFF);
    await off.dispatch("dictation.start", { sessionId: "c2", mode: "call" });
    await off.dispatch("dictation.speak", { sessionId: "c2", id: "sp-1", text: "You want me to send it?", voice: "kokoro:af_bella" });
    off.jobs[0]!.h.audio(f32(x), 0);
    expect(off.pcmOut().equals(f32(x))).toBe(true); // straight through, and not even held
    off.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(off.pcmOut().equals(f32(x))).toBe(true);
  });

  it("the pcm-end still comes last, after the held audio", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Send it?", voice: "kokoro:af_bella" });
    h.jobs[0]!.h.audio(f32(x), 0);
    h.jobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    const lines = h.kids[0]!.stdin.write.mock.calls.map((c) => String(c[0]));
    expect(lines.at(-1)).toMatch(/^pcm-end /);
    expect(lines.at(-2)).toMatch(/^pcm /);
  });
});
