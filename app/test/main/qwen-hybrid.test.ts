import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KOKORO_LEVELS, KOKORO_LEVEL_DEFAULT, targetRmsFor, type QwenTts } from "../../src/main/native/qwen";
import { PhraseCache } from "../../src/main/native/voice-cache";
import { registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Decision 184: dropped the hybrid Kokoro opener a Qwen Bot's reply used to open with while the big
// model loaded (bug 164) — the switch inside one reply was a +19 semitone pitch-centre jump (bug
// 182). A Qwen Bot's WHOLE reply is now said by Qwen, warm or cold; Qwen still warms as early as
// before (the first line of a reply that needs it). Kokoro only ever says a WHOLE reply, and only
// when Qwen is genuinely unavailable (not installed, its probe failed, Light voice mode, or the mode
// dropped it mid-call) — never a mix of the two inside one reply.

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
  c.pid = 4244;
  return c;
}
type Fake = ReturnType<typeof fakeChild>;
const written = (c: Fake) => c.stdin.write.mock.calls.map((x) => String(x[0]));
const speakLines = (c: Fake) => written(c).filter((l) => l.startsWith("speak ")).map((l) => JSON.parse(l.replace(/^speak /, "")) as Record<string, unknown>);
const pcm = (n: number) => Buffer.from(new Float32Array(n).fill(0.25).buffer);

type Handlers = { audio(pcm: Buffer, seq: number): void; done(info: unknown): void; error(message: string): void };
type Job = { id: string; text: string; voice: string; speed: number };
type QwenJob = Job & { quality?: "live" | "full"; targetRms?: number };

/** The Bot's own Kokoro voice. am_puck is the loudest of the nine, so its level can't be the default. */
const FALLBACK = "kokoro:am_puck";
const VOICE = "qwen3:vivian";
const LINE = "The first thing you notice is how ordinary it sounds, and that is the whole point.";

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-hybrid-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("a Qwen voice's whole reply is Qwen's, never split (decision 184)", () => {
  function setup(o: { ready?: boolean; warm?: boolean; wired?: boolean; phrases?: PhraseCache } = {}) {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const kokoroJobs: Array<{ job: Job; h: Handlers }> = [];
    const qwenJobs: Array<{ job: QwenJob; h: Handlers }> = [];
    const tts = { isReady: vi.fn(() => true), isWarm: vi.fn(() => true), warm: vi.fn(), cancel: vi.fn(), synth: vi.fn((job: Job, h: Handlers) => void kokoroJobs.push({ job, h })) };
    const qwen = {
      isReady: vi.fn(() => o.ready ?? true), isWarm: vi.fn(() => o.warm ?? true), warm: vi.fn(), cancel: vi.fn(),
      synth: vi.fn((job: Job, h: Handlers) => void qwenJobs.push({ job, h })),
      synthQwen: vi.fn((job: QwenJob, h: Handlers) => void qwenJobs.push({ job, h })),
    };
    const log = vi.fn();
    registerDictation({
      binary: "bots-dictation", spawnFn: spawnFn as never, log, tts,
      qwen: o.wired === false ? undefined : (qwen as unknown as QwenTts),
      phrases: o.phrases, voice: () => FALLBACK,
    });
    const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    return { sent, kids, kokoroJobs, qwenJobs, tts, qwen, dispatch, log, spawnFn };
  }

  /** A call, then one line of a reply. Everything a renderer sends for a Qwen Bot rides along. */
  const speak = async (h: ReturnType<typeof setup>, a: Record<string, unknown>) => {
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    return h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", voice: VOICE, fallbackVoice: FALLBACK, ...a });
  };

  it("says the opening line of a reply in Qwen, warm or not — there is no opener any more", async () => {
    const h = setup();
    await speak(h, { text: LINE, first: true, more: true });
    expect(h.qwenJobs[0]!.job).toMatchObject({ id: "sp-1", text: LINE, voice: "vivian", speed: 1, quality: "live" });
    expect(h.kokoroJobs).toHaveLength(0);
    // Held at this Bot's own Kokoro voice's measured level, so a call that ever DOES fall back to
    // Kokoro (Qwen going unavailable) sounds like the same Bot.
    expect(h.qwenJobs[0]!.job.targetRms).toBe(targetRmsFor(FALLBACK));
    expect(h.qwenJobs[0]!.job.targetRms).toBe(KOKORO_LEVELS.am_puck);
    expect(h.qwenJobs[0]!.job.targetRms).not.toBe(KOKORO_LEVEL_DEFAULT);
    // Warmed as early as before: the first line of the reply that needs it starts it loading.
    expect(h.qwen.warm).toHaveBeenCalledWith(["vivian"]);
  });

  it("says every later line in Qwen too, at the same level", async () => {
    const h = setup();
    await speak(h, { text: LINE, first: false, more: true, queue: true });
    expect(h.kokoroJobs).toHaveLength(0);
    expect(h.qwenJobs[0]!.job).toMatchObject({ id: "sp-1", text: LINE, voice: "vivian", speed: 1, quality: "live" });
    expect(h.qwenJobs[0]!.job.targetRms).toBe(KOKORO_LEVELS.am_puck);
  });

  it("still speaks the opening line in Qwen while it is cold, and starts it loading", async () => {
    const h = setup({ warm: false });
    await speak(h, { text: LINE, first: true, more: true });
    // No more Kokoro opener to bridge the load: the only added cost is Qwen's own first-audio time
    // (bug 182), which is the tradeoff the user chose over the +19 st seam.
    expect(h.kokoroJobs).toHaveLength(0);
    expect(h.qwenJobs[0]!.job.voice).toBe("vivian");
    expect(h.qwen.warm).toHaveBeenCalledWith(["vivian"]);
  });

  it("speaks even a lone short sentence in Qwen — no exception for it any more", async () => {
    const h = setup();
    const text = "Sure, give me a second.";
    await speak(h, { text, first: true, more: false });
    expect(h.qwenJobs[0]!.job).toMatchObject({ text, voice: "vivian" });
    expect(h.kokoroJobs).toHaveLength(0);
    expect(h.qwen.warm).toHaveBeenCalledWith(["vivian"]);
  });

  it("says the WHOLE reply in Kokoro — never a mix — when Qwen is genuinely unavailable", async () => {
    const h = setup({ ready: false });
    await speak(h, { text: LINE, first: true, more: true });
    expect(h.kokoroJobs[0]!.job).toEqual({ id: "sp-1", text: LINE, voice: "am_puck", speed: 1 });
    expect(h.qwenJobs).toHaveLength(0);
    // Every later line of the same reply stays Kokoro too — not just the opener.
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-2", voice: VOICE, fallbackVoice: FALLBACK, text: LINE, first: false, more: false });
    expect(h.kokoroJobs[1]!.job).toMatchObject({ text: LINE, voice: "am_puck" });
    expect(h.qwenJobs).toHaveLength(0);
  });

  it("plays a pre-rendered Qwen line from the cache, in the Bot's own Qwen voice", async () => {
    const phrases = new PhraseCache({ dir });
    const text = "Hey, good to hear from you.";
    const audio = pcm(8);
    // Pre-rendered under the BARE qwen id at the Bot's own level (bug 221), which is how the pre-renderer stores a
    // Qwen Bot's lines.
    phrases.put("vivian", 1, text, audio, targetRmsFor(FALLBACK));
    const h = setup({ phrases });
    const r = await speak(h, { text, first: true, more: true, cache: true });
    expect(r.result).toEqual({ spoken: true, cached: true });
    const lines = written(h.kids[0]!);
    expect(speakLines(h.kids[0]!)[0]).toMatchObject({ id: "sp-1", text, engine: "pcm" });
    expect(Buffer.from((JSON.parse(lines.at(-2)!.replace(/^pcm /, "")) as { data: string }).data, "base64")).toEqual(audio);
    expect(lines.at(-1)).toBe(`pcm-end ${JSON.stringify({ id: "sp-1" })}\n`);
    // The engine check never runs for a line that already exists: handing an opening greeting to
    // Kokoro would swap the voice on the one line the user hears first, and buy no latency at all.
    expect(h.qwenJobs).toHaveLength(0);
    expect(h.kokoroJobs).toHaveLength(0);
    expect(h.qwen.warm).not.toHaveBeenCalled();
  });

  it("bug 221: a take held to another level is not played (it would sit ±2.6 dB off the reply); the live one is kept at the Bot's", async () => {
    const phrases = new PhraseCache({ dir });
    const text = "Mm-hm.";
    phrases.put("vivian", 1, text, pcm(8), KOKORO_LEVEL_DEFAULT); // the old default-level take
    const h = setup({ phrases });
    const r = await speak(h, { text, first: true, more: true, cache: true });
    expect(r.result).toEqual({ spoken: true });
    expect(h.qwenJobs[0]!.job).toMatchObject({ text, targetRms: KOKORO_LEVELS.am_puck });
    h.qwenJobs[0]!.h.audio(pcm(16), 0);
    h.qwenJobs[0]!.h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(phrases.has("vivian", 1, text, KOKORO_LEVELS.am_puck)).toBe(true);
  });

  it("still speaks when this build has no Qwen engine at all", async () => {
    const h = setup({ wired: false });
    const r = await speak(h, { text: LINE, first: false, more: true });
    // An older build, or Light voice mode: a Bot saved with a qwen3: voice is not a crash, and not
    // a silent line — it simply speaks in the Kokoro voice it would have handed over from.
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ spoken: true });
    expect(h.qwen.synthQwen).not.toHaveBeenCalled();
    expect(h.kokoroJobs[0]!.job.voice).toBe("am_puck");
  });

  it("never passes the qwen3: id to the helper as an Apple voice", async () => {
    const h = setup();
    await speak(h, { text: LINE, first: true, more: true });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-2", text: LINE, voice: VOICE, fallbackVoice: FALLBACK, first: false, more: true });
    const speaks = speakLines(h.kids[0]!);
    expect(speaks).toHaveLength(2);
    // Same rule as kokoro: and f5: — an engine's voice id is meaningless to AVSpeechSynthesizer, so
    // the helper keeps the text and its own best voice as the fallback for the line.
    for (const s of speaks) expect(s.voice).toBeUndefined();
    expect(written(h.kids[0]!).join("")).not.toMatch(/qwen3:/);
  });
});
