import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROSODY_DEFAULT, PROSODY_QWEN, plainProsody, qwenProsody, withProsody, type KokoroHandlers, type Prosody } from "../../src/main/native/kokoro";
import { PhraseCache } from "../../src/main/native/voice-cache";
import { registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";
import type { QwenTts } from "../../src/main/native/qwen";

/**
 * Bug 190: "Qwen3 voice still glitches at a question. Remove whatever you did to make it pronounce
 * questions correctly." A Bot whose voice is Qwen3 gets NO question handling anywhere — not on its
 * Qwen lines, and not on the lines its Kokoro stand-in says for it (a whole reply when Qwen is unavailable, or the whole
 * call once a short Mac drops the call to Light mode — which is what both of the user's calls after
 * the install did, 200 and 393 MB free). A "?" line and the same line with "." go through the same
 * bytes of processing, and the tail ends clean.
 */

const SR = 24_000;

/** A voiced line: a 180 Hz vowel, 1.2 s, that ends on a 40 ms decay into Kokoro-like padding. */
function line(): Float32Array {
  const n = Math.round(SR * 1.2);
  const decay = Math.round(SR * 0.04);
  const x = new Float32Array(n + decay + Math.round(SR * 0.5));
  for (let i = 0; i < n + decay; i++) {
    const env = i < n ? 1 : 1 - (i - n) / decay;
    x[i] = 0.4 * env * Math.sin((2 * Math.PI * 180 * i) / SR);
  }
  return x;
}
const f32 = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.length * 4);
function unpack(b: Buffer): Float32Array {
  const out = new Float32Array(b.length >>> 2);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
/** What `withProsody` hands on for this text, fed the same PCM in the sidecar's half-second frames. */
function through(text: string, x: Float32Array, p: Prosody): Buffer {
  const got: Buffer[] = [];
  const h = withProsody(text, { audio: (b) => got.push(Buffer.from(b)), done: () => {}, error: () => {} }, p);
  for (let i = 0; i < x.length; i += SR / 2) h.audio(f32(x.subarray(i, i + SR / 2)), 0);
  h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
  return Buffer.concat(got);
}
/** The tail is clean: it ends on zero and its last 30 ms steps no harder than the vowel itself did. */
function cleanTail(y: Float32Array, x: Float32Array): void {
  expect(Math.abs(y[y.length - 1]!)).toBeLessThan(1e-3);
  let own = 0;
  for (let i = 1; i < SR * 0.5; i++) own = Math.max(own, Math.abs(x[i]! - x[i - 1]!));
  let tail = 0;
  for (let i = Math.max(1, y.length - SR * 0.03); i < y.length; i++) tail = Math.max(tail, Math.abs(y[i]! - y[i - 1]!));
  expect(tail).toBeLessThanOrEqual(own * 1.01);
}

describe("a Qwen line's processing does not know it is a question (bug 190)", () => {
  const x = line();
  it("'?' and '.' go through byte-identical processing on Qwen's own chain, whatever the base prosody", () => {
    for (const base of [PROSODY_DEFAULT, { ...PROSODY_DEFAULT, semitones: 5 }]) {
      const p = qwenProsody(base);
      expect(p.questionRamp).toBe(false);
      const q = through("Should I send it now?", x, p);
      const s = through("Should I send it now.", x, p);
      expect(q.equals(s)).toBe(true);
      cleanTail(unpack(q), x);
    }
    expect(PROSODY_QWEN.questionRamp).toBe(false);
  });

  it("a Qwen Bot's Kokoro stand-in keeps Kokoro's trim but loses the ramp: '?' and '.' are byte-identical", () => {
    const p = plainProsody(PROSODY_DEFAULT);
    expect(p).toEqual({ ...PROSODY_DEFAULT, questionRamp: false, semitones: 0, rampMs: 0 });
    const q = through("Should I send it now?", x, p);
    expect(q.equals(through("Should I send it now.", x, p))).toBe(true);
    cleanTail(unpack(q), x);
    // …and bug 224: a Kokoro Bot's own question is flat too now.
    expect(through("Should I send it now?", x, PROSODY_DEFAULT).equals(through("Should I send it now.", x, PROSODY_DEFAULT))).toBe(true);
  });
});

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
  c.pid = 4245;
  return c;
}

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-noq-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("a Qwen Bot's call: every line, whichever engine says it (bug 190)", () => {
  type Job = { id: string; text: string; voice: string };
  function setup(o: { phrases?: PhraseCache; qwenReady?: boolean } = {}) {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: ReturnType<typeof fakeChild>[] = [];
    const kokoro: Array<{ job: Job; h: KokoroHandlers }> = [];
    const qwenJobs: Array<{ job: Job; h: KokoroHandlers }> = [];
    const tts = { isReady: () => true, isWarm: () => true, warm: () => {}, cancel: () => {}, synth: (job: Job, h: KokoroHandlers) => void kokoro.push({ job, h }) };
    const qwen = {
      isReady: () => o.qwenReady ?? true, isWarm: () => o.qwenReady ?? true, warm: () => {}, cancel: () => {},
      synth: (job: Job, h: KokoroHandlers) => void qwenJobs.push({ job, h }),
      synthQwen: (job: Job, h: KokoroHandlers) => void qwenJobs.push({ job, h }),
    };
    registerDictation({
      binary: "bots-dictation", log: () => {}, tts: tts as never, qwen: qwen as unknown as QwenTts, phrases: o.phrases,
      prosody: () => PROSODY_DEFAULT,
      spawnFn: (() => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; }) as never,
    });
    const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    const pcmOut = (id: string) => Buffer.concat(kids[0]!.stdin.write.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("pcm "))
      .map((l) => JSON.parse(l.slice(4)) as { id: string; data: string })
      .filter((m) => m.id === id)
      .map((m) => Buffer.from(m.data, "base64")));
    return { kids, kokoro, qwenJobs, dispatch, pcmOut };
  }
  const x = line();
  const say = async (h: ReturnType<typeof setup>, id: string, text: string, a: Record<string, unknown>, jobs: "kokoro" | "qwenJobs") => {
    const before = h[jobs].length;
    await h.dispatch("dictation.speak", { sessionId: "c1", id, text, ...a });
    const j = h[jobs][before];
    expect(j, `${id} went to ${jobs}`).toBeDefined();
    for (let i = 0; i < x.length; i += SR / 2) j!.h.audio(f32(x.subarray(i, i + SR / 2)), 0);
    j!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    return h.pcmOut(id);
  };

  it("Qwen unavailable: the Kokoro stand-in for a Qwen Bot says '?' exactly as it says '.' (decision 184)", async () => {
    const h = setup({ qwenReady: false }); // the whole reply goes to the Bot's Kokoro voice
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const a = { voice: "qwen3:vivian", fallbackVoice: "kokoro:af_heart", qwenBot: true };
    const q = await say(h, "sp-1", "Should I send it now?", a, "kokoro");
    const s = await say(h, "sp-2", "Should I send it now.", a, "kokoro");
    expect(q.length).toBeGreaterThan(0);
    expect(q.equals(s)).toBe(true);
    cleanTail(unpack(q), x);
  });

  it("a Qwen Bot dropped to Light mode: its Kokoro stand-in says '?' exactly as '.', and never shares a Kokoro Bot's cached lines", async () => {
    const phrases = new PhraseCache({ dir });
    const h = setup({ phrases });
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const a = { voice: "kokoro:af_heart", qwenBot: true, cache: true };
    // A Kokoro Bot's ramped take of the same greeting is already in the cache: it must not be played.
    phrases.put("af_heart", 1, "Hey, what's up?", f32(new Float32Array(2400).fill(0.5)));
    const q = await say(h, "sp-1", "Hey, what's up?", a, "kokoro");
    const s = await say(h, "sp-2", "Hey, what's up.", a, "kokoro");
    expect(q.equals(s)).toBe(true);
    cleanTail(unpack(q), x);
    // …and its un-ramped take is not stored over the Kokoro Bot's.
    expect(phrases.get("af_heart", 1, "Hey, what's up?")!.equals(f32(new Float32Array(2400).fill(0.5)))).toBe(true);
    expect(phrases.has("af_heart", 1, "Hey, what's up.")).toBe(false);
  });

  it("a Qwen line itself: '?' and '.' reach the helper byte-identical", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const a = { voice: "qwen3:vivian", fallbackVoice: "kokoro:af_heart", qwenBot: true };
    const q = await say(h, "sp-1", "Should I send it now?", a, "qwenJobs");
    const s = await say(h, "sp-2", "Should I send it now.", a, "qwenJobs");
    expect(q.equals(s)).toBe(true);
    cleanTail(unpack(q), x);
  });

  it("bug 224 (the user's decision): a Kokoro Bot's question is flat too — '?' and '.' byte-identical, a clean tail", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const q = await say(h, "sp-1", "Should I send it now?", { voice: "kokoro:af_heart" }, "kokoro");
    const s = await say(h, "sp-2", "Should I send it now.", { voice: "kokoro:af_heart" }, "kokoro");
    expect(q.equals(s)).toBe(true);
    cleanTail(unpack(q), line());
  });

  it("bug 224: no prosody the app ships lifts a question any more", () => {
    expect(PROSODY_DEFAULT.questionRamp).toBe(false);
    const x = line();
    expect(through("Is it green?", x, PROSODY_DEFAULT).equals(through("Is it green.", x, PROSODY_DEFAULT))).toBe(true);
  });
});
