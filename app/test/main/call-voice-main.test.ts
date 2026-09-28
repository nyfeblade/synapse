import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_FEEL, LIMITS5 } from "@synapse/shared";
import { KokoroSidecar, PROSODY_OFF, PROSODY_QWEN, kokoroCommand, encodeFrame, withProsody, type KokoroEngine, type Prosody } from "../../src/main/native/kokoro";
import { helperArgs, parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";
import { PhraseCache, PhrasePrerender, pruneOld } from "../../src/main/native/voice-cache";
import { KOKORO_LEVEL_DEFAULT } from "../../src/main/native/qwen";
import { chimePcm } from "../../src/main/native/chimes";

// Bug 134, the Mac side: pre-rendered phrases play from a PCM cache even before Kokoro loads; Kokoro
// loads faster and is kept hot while the app runs ("Keep voice ready"); lines are panned; chimes.

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
type Fake = ReturnType<typeof fakeChild>;
const written = (c: Fake) => c.stdin.write.mock.calls.map((x) => String(x[0]));
const ENGINE: KokoroEngine = { python: "/u/py", modelDir: "/u/model", source: "bundled" };
const pcm = (n: number, v = 0.25) => Buffer.from(new Float32Array(n).fill(v).buffer);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vcache-"));

describe("Kokoro readiness: a faster start, kept hot while the app runs", () => {
  afterEach(() => vi.useRealTimers());

  it("the sidecar starts with Synapse's bytecode cache and the voice the call needs (its accent is built first)", () => {
    const c = kokoroCommand(ENGINE, "/app/k.py", { cacheDir: "/ud/kokoro-cache", voice: "bm_george" });
    expect(c.args.join(" ")).toMatch(/--cache-dir \/ud\/kokoro-cache/);
    expect(c.args.join(" ")).toMatch(/--voice bm_george/);
    expect(kokoroCommand(ENGINE, "/app/k.py").args).not.toContain("--voice");
  });

  it("prime asks the sidecar to build the call's voices ahead of their first line", () => {
    vi.useFakeTimers();
    const kids: Fake[] = [];
    const s = new KokoroSidecar({ engine: ENGINE, script: "/k.py", spawnFn: (() => { const c = fakeChild(); kids.push(c); return c; }) as never, log: () => {}, cacheDir: "/c" });
    s.start("bf_emma");
    s.prime(["bf_emma", "am_fenrir"]);
    expect(written(kids[0]!).map((l) => JSON.parse(l))).toContainEqual({ op: "prime", voices: ["bf_emma", "am_fenrir"] });
  });

  it("kept hot while the app runs: no idle timeout; a crash restarts it with backoff (logged); quitting stops it for good", () => {
    vi.useFakeTimers();
    const kids: Fake[] = [];
    const log = vi.fn();
    let hot = true;
    const s = new KokoroSidecar({ engine: ENGINE, script: "/k.py", spawnFn: (() => { const c = fakeChild(); kids.push(c); return c; }) as never, log, keepAlive: () => hot });
    s.start();
    vi.advanceTimersByTime(LIMITS5.kokoroIdleMs * 12);
    expect(s.isRunning()).toBe(true);
    expect(kids[0]!.stdin.end).not.toHaveBeenCalled();
    // Crashes: restarted after 1 s, then 2 s, then 4 s…
    kids[0]!.emit("close", 1, null);
    expect(s.isRunning()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(kids).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(kids).toHaveLength(2);
    kids[1]!.emit("close", null, "SIGKILL");
    vi.advanceTimersByTime(1_500);
    expect(kids).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(kids).toHaveLength(3);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/kokoro: restarting in 2 s \(crash 2\)/);
    // Quitting: stopped, never restarted.
    s.dispose();
    vi.advanceTimersByTime(120_000);
    expect(kids).toHaveLength(3);
    // "Keep voice ready" off: back to idling out after 5 minutes.
    hot = false;
    s.start();
    s.relax();
    vi.advanceTimersByTime(LIMITS5.kokoroIdleMs + 1_000);
    expect(s.isRunning()).toBe(false);
  });

  it("the app loads it 10 s after launch when Kokoro is ready and 'Keep voice ready' is on (default); never when it's off", async () => {
    vi.useFakeTimers();
    const spawned: string[][] = [];
    const exists = (p: string) => !p.includes("nothing");
    const spawnFn = ((cmd: string, args: string[]) => {
      spawned.push(args);
      const c = fakeChild();
      // The import probe (-c …) exits 0 at once; the sidecar stays up.
      if (args.includes("-c")) setTimeout(() => c.emit("close", 0, null), 0);
      return c;
    }) as never;
    const { registerKokoro } = await import("../../src/main/native/kokoro");
    let on = true;
    const k = registerKokoro({ script: "/app/k.py", home: "/Users/u", userData: "/ud", log: () => {}, spawnFn, exists, listDir: () => [], keepReady: () => on, launchDelayMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(spawned.some((a) => a.includes("--model-dir"))).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawned.some((a) => a.includes("--model-dir") && a.includes("--cache-dir"))).toBe(true);
    k.dispose();
    spawned.length = 0;
    on = false;
    registerKokoro({ script: "/app/k.py", home: "/Users/u", userData: "/ud", log: () => {}, spawnFn, exists, listDir: () => [], keepReady: () => on, launchDelayMs: 10_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawned.some((a) => a.includes("--model-dir"))).toBe(false);
  });

  it("busy() while a job is out (pre-rendering waits for live speech)", () => {
    vi.useFakeTimers();
    const kids: Fake[] = [];
    const s = new KokoroSidecar({ engine: ENGINE, script: "/k.py", spawnFn: (() => { const c = fakeChild(); kids.push(c); return c; }) as never, log: () => {} });
    s.start();
    expect(s.busy()).toBe(false);
    s.synth({ id: "a", text: "Hi.", voice: "af_heart", speed: 1 }, { audio: () => {}, done: () => {}, error: () => {} });
    expect(s.busy()).toBe(true);
    kids[0]!.stdout.emit("data", encodeFrame({ type: "done", id: "a", seq: 0, synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 }));
    expect(s.busy()).toBe(false);
  });
});

describe("the phrase cache (greetings, fillers: rendered once, played instantly)", () => {
  it("keys on voice, speed and text; LRU-prunes past its size cap", () => {
    const dir = tmp();
    const c = new PhraseCache({ dir, maxBytes: 3 * 4000 });
    c.put("af_heart", 1, "Hey!", pcm(1000));
    expect(c.get("af_heart", 1, "Hey!")!.length).toBe(4000);
    expect(c.get("af_heart", 1.25, "Hey!")).toBeNull();
    expect(c.get("bm_george", 1, "Hey!")).toBeNull();
    for (let i = 0; i < 5; i++) c.put("af_heart", 1, `line ${i}`, pcm(1000));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".f32"));
    expect(files.length).toBeLessThanOrEqual(3);
    expect(c.get("af_heart", 1, "line 4")).not.toBeNull();
  });

  it("pre-rendering: only missing phrases, one at a time, only while Kokoro is warm and not speaking a live line", () => {
    const dir = tmp();
    const cache = new PhraseCache({ dir });
    cache.put("af_heart", 1, "One sec.", pcm(10));
    const jobs: { id: string; text: string; h: { audio(p: Buffer, s: number): void; done(i: unknown): void; error(m: string): void } }[] = [];
    let warm = false, busy = false;
    const tts = { isReady: () => true, isWarm: () => warm, busy: () => busy, synth: (j: { id: string; text: string }, h: never) => void jobs.push({ ...j, h }) };
    const pre = new PhrasePrerender({ cache, tts: tts as never, log: () => {} });
    pre.prepare([{ voice: "kokoro:af_heart", speed: 1, text: "One sec." }, { voice: "kokoro:af_heart", speed: 1, text: "Hey Alex!" }, { voice: "kokoro:af_heart", speed: 1, text: "Hmm." }, { voice: "Samantha", speed: 1, text: "Apple voice: never cached" }]);
    pre.pump();
    expect(jobs).toHaveLength(0); // not warm
    warm = true; busy = true;
    pre.pump();
    expect(jobs).toHaveLength(0); // a live line is being synthesized
    busy = false;
    pre.pump();
    pre.pump();
    expect(jobs.map((j) => j.text)).toEqual(["Hey Alex!"]); // one at a time
    jobs[0]!.h.audio(pcm(20), 0);
    jobs[0]!.h.done({});
    expect(cache.get("af_heart", 1, "Hey Alex!")!.length).toBe(80);
    pre.pump();
    expect(jobs.map((j) => j.text)).toEqual(["Hey Alex!", "Hmm."]);
  });

  // Bug 141: voice.log 16:49 — the first call after an update rendered pre-1…pre-38 WHILE the call ran
  // (a CPU burst beside the mic and the greeting). Pre-rendering waits for the call to end, and the
  // lines a call asked for are remembered on this Mac, so the next launch renders them before any call.
  it("never pre-renders while a call (or dictation) has the microphone; resumes after it", () => {
    const cache = new PhraseCache({ dir: tmp() });
    const jobs: string[] = [];
    let live = true;
    const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: (j: { text: string }) => void jobs.push(j.text) };
    const pre = new PhrasePrerender({ cache, tts: tts as never, log: () => {}, live: () => live });
    pre.prepare([{ voice: "kokoro:am_fenrir", speed: 1, text: "Hey, what's up?" }]);
    pre.pump();
    expect(jobs).toEqual([]);
    live = false;
    pre.pump();
    expect(jobs).toEqual(["Hey, what's up?"]);
  });

  it("the lines a call asked for are remembered, and a new launch prepares the missing ones with no call open", () => {
    const dir = tmp();
    const book = path.join(dir, "phrasebook.json");
    const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: vi.fn() };
    const a = new PhrasePrerender({ cache: new PhraseCache({ dir }), tts: tts as never, log: () => {}, book });
    a.prepare([{ voice: "kokoro:am_fenrir", speed: 1, text: "Hey, what's up?" }, { voice: "kokoro:am_fenrir", speed: 1, text: "One sec." }]);
    const cache = new PhraseCache({ dir });
    cache.put("am_fenrir", 1, "One sec.", pcm(10));
    const jobs: string[] = [];
    const b = new PhrasePrerender({ cache, tts: { ...tts, synth: (j: { text: string }) => void jobs.push(j.text) } as never, log: () => {}, book });
    expect(b.restore()).toBe(1);
    b.pump();
    expect(jobs).toEqual(["Hey, what's up?"]);
  });

  // Bug 151: the user heard "Hi, I've drafted three replies for you." as a pick-up line. The host
  // re-authors that Bot's set; this Mac throws away the audio it already rendered, so it can't play.
  it("a remembered greeting that isn't a greeting is purged on launch, with its audio, and never rendered again", () => {
    const dir = tmp();
    const book = path.join(dir, "phrasebook.json");
    const bad = "Hi, I've drafted three replies for you.";
    const cache = new PhraseCache({ dir });
    cache.put("am_fenrir", 1, bad, pcm(2400));
    fs.writeFileSync(book, JSON.stringify([
      { voice: "kokoro:am_fenrir", speed: 1, text: bad, kind: "greeting" },
      { voice: "kokoro:am_fenrir", speed: 1, text: "Hey, what's up?", kind: "greeting" },
      { voice: "kokoro:am_fenrir", speed: 1, text: "Your inbox is quiet." }, // written before `kind` existed
      { voice: "kokoro:am_fenrir", speed: 1, text: "One sec." }, // a stock call line: left alone
    ]));
    const jobs: string[] = [];
    const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: (j: { text: string }) => void jobs.push(j.text) };
    const pre = new PhrasePrerender({ cache, tts: tts as never, log: () => {}, book });
    expect(pre.restore()).toBe(2); // the two good lines
    expect(pre.droppedCount()).toBe(2);
    expect(cache.has("am_fenrir", 1, bad)).toBe(false); // the rendered audio is gone
    expect(JSON.parse(fs.readFileSync(book, "utf8")).map((x: { text: string }) => x.text)).toEqual(["Hey, what's up?", "One sec."]);
    pre.pump(); // one render at a time: the good line, never the purged one
    expect(jobs).toEqual(["Hey, what's up?"]);
    expect(jobs).not.toContain(bad);
    // …and asking for it again doesn't bring it back (nothing new is queued).
    const pending = pre.pending();
    pre.prepare([{ voice: "kokoro:am_fenrir", speed: 1, text: bad, kind: "greeting" }]);
    expect(pre.pending()).toBe(pending);
  });

  // Bug 156: a greeting rendered ahead is stored as it will be PLAYED. Without this, a cached
  // greeting ending in "?" would be the one line on a call whose pitch still falls at the end.
  it("a pre-rendered question gets the same prosody a spoken line gets, and none of it with the flag off", () => {
    const render = (prosody?: Prosody) => {
      const dir = tmp();
      const cache = new PhraseCache({ dir });
      let handlers: { audio(p: Buffer, i: number): void; done(m: unknown): void } | null = null;
      const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: (_j: unknown, h: never) => { handlers = h; } };
      const pre = new PhrasePrerender({ cache, tts: tts as never, log: () => {}, ...(prosody ? { prosody } : {}) });
      pre.prepare([{ voice: "kokoro:af_heart", speed: 1, text: "Hey, what's up?", kind: "greeting" }]);
      pre.pump();
      const h = handlers!;
      // 300 ms of speech and the trailing pad the sidecar always sends.
      h.audio(pcm(7_200), 0);
      h.audio(pcm(14_400, 0), 1);
      h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
      return cache.get("af_heart", 1, "Hey, what's up?")!;
    };
    const raw = Buffer.concat([pcm(7_200), pcm(14_400, 0)]);
    const off = render(PROSODY_OFF);
    expect(off.equals(raw)).toBe(true); // the sidecar's own bytes, cached unchanged
    const on = render();
    expect(on.equals(raw)).toBe(false); // the ramp and the silence trim ran before it was cached
    expect(on.length).toBeLessThan(raw.length); // the trailing pad is gone
  });

  // Bug 181: "when the bot asks me a question in the Qwen voice, it glitches at the end". Measured
  // (app/look/qwen-question.mjs): a Qwen greeting or filler rendered ahead went through KOKORO's
  // prosody — the +4 st question ramp bug 166 turned off for Qwen (it lifted the model's own rise by
  // another 1.3-3.7 st) and Kokoro's hard tail trim (6-25 ms kept, cut 30-37 dB under the peak).
  it("a pre-rendered Qwen line gets Qwen's prosody: no question ramp, the model's own tail kept", () => {
    const sine = (ms: number, padMs: number) => {
      const n = Math.round(24 * ms);
      const x = new Float32Array(n + Math.round(24 * padMs));
      for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 150 * i) / 24_000) * Math.min(1, i / 240, (n - i) / 240);
      for (let i = n; i < x.length; i++) x[i] = 1e-4 * Math.sin(i * 0.3); // the model's quiet tail
      return Buffer.from(x.buffer);
    };
    const text = "Want me to send it over?";
    const line = Buffer.concat([pcm(4_800, 0), sine(1_200, 600)]);
    const dir = tmp();
    const cache = new PhraseCache({ dir });
    let handlers: { audio(p: Buffer, i: number): void; done(m: unknown): void } | null = null;
    const jobs: { quality?: string }[] = [];
    const qwen = { isReady: () => true, isWarm: () => true, busy: () => false, synthQwen: (j: { quality?: string }, h: never) => { jobs.push(j); handlers = h; } };
    const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth: () => {} };
    const pre = new PhrasePrerender({ cache, tts: tts as never, qwen: qwen as never, log: () => {} });
    pre.prepare([{ voice: "qwen3:vivian", speed: 1, text }]);
    pre.pump();
    expect(jobs[0]?.quality).toBe("full");
    for (let i = 0; i < line.length; i += 48_000) handlers!.audio(line.subarray(i, i + 48_000), 0);
    handlers!.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    const got = cache.get("vivian", 1, text, KOKORO_LEVEL_DEFAULT)!; // bug 221: keyed by the level it was held to
    // Exactly what a live Qwen line of the same audio becomes on a call.
    const want: Buffer[] = [];
    const h = withProsody(text, { audio: (b) => want.push(Buffer.from(b)), done: () => {}, error: () => {} }, PROSODY_QWEN);
    for (let i = 0; i < line.length; i += 48_000) h.audio(line.subarray(i, i + 48_000), 0);
    h.done({ synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(got.equals(Buffer.concat(want))).toBe(true);
  });

  it("a call start whose lines are all cached sends no synth request at all", async () => {
    const dir = tmp();
    const phrases = new PhraseCache({ dir });
    phrases.put("am_fenrir", 1, "Hey, what's up?", pcm(2400));
    const synth = vi.fn();
    const tts = { isReady: () => true, isWarm: () => true, busy: () => false, synth, warm: vi.fn(), cancel: vi.fn(), prime: vi.fn() };
    const pre = new PhrasePrerender({ cache: phrases, tts: tts as never, log: () => {}, live: () => false });
    pre.prepare([{ voice: "kokoro:am_fenrir", speed: 1, text: "Hey, what's up?" }]);
    pre.pump();
    expect(synth).not.toHaveBeenCalled();
    expect(pre.pending()).toBe(0);
  });

  it("voicemails older than 30 days are pruned; newer ones stay", () => {
    const dir = tmp();
    const old = path.join(dir, "old.f32"), fresh = path.join(dir, "new.f32");
    fs.writeFileSync(old, pcm(4));
    fs.writeFileSync(fresh, pcm(4));
    const now = Date.now();
    fs.utimesSync(old, new Date(now - CALL_FEEL.voicemailKeepMs - 60_000), new Date(now - CALL_FEEL.voicemailKeepMs - 60_000));
    expect(pruneOld(dir, CALL_FEEL.voicemailKeepMs, now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("a call's lines through the helper (dictation.speak)", () => {
  function setup(o: { ready?: boolean; warm?: boolean } = {}) {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const jobs: Array<{ job: { id: string; text: string; voice: string; speed: number }; h: { audio(p: Buffer, seq: number): void; done(i: unknown): void; error(m: string): void } }> = [];
    const tts = { isReady: vi.fn(() => o.ready ?? true), isWarm: vi.fn(() => o.warm ?? true), warm: vi.fn(), cancel: vi.fn(), busy: () => false, synth: vi.fn((job, h) => void jobs.push({ job, h })) };
    const cache = new PhraseCache({ dir: tmp() });
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, log: () => {}, tts, phrases: cache, voice: () => null });
    const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    return { sent, kids, jobs, tts, dispatch, cache, spawnFn };
  }

  it("a cached phrase (the pick-up greeting) plays from the Mac's PCM at once, even when Kokoro isn't loaded", async () => {
    const h = setup({ ready: false, warm: false });
    h.cache.put("bm_george", 1, "Hey Alex, what's up?", pcm(30_000));
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const r = await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hey Alex, what's up?", voice: "kokoro:bm_george", cache: true });
    expect(r.result).toEqual({ spoken: true, cached: true });
    const lines = written(h.kids[0]!);
    const speakAt = lines.findIndex((l) => l.startsWith("speak "));
    expect(JSON.parse(lines[speakAt]!.slice(6))).toMatchObject({ id: "sp-1", engine: "pcm" });
    const chunks = lines.slice(speakAt + 1).filter((l) => l.startsWith("pcm "));
    expect(chunks.length).toBe(Math.ceil(30_000 / 12_000)); // 0.5 s chunks
    expect(lines.at(-1)).toBe(`pcm-end ${JSON.stringify({ id: "sp-1" })}\n`);
    expect(h.jobs).toHaveLength(0);
  });

  it("not cached yet but Kokoro is warm: synthesized live, and kept for next time", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "One sec.", voice: "kokoro:af_heart", cache: true });
    h.jobs[0]!.h.audio(pcm(100), 0);
    h.jobs[0]!.h.audio(pcm(50), 1);
    h.jobs[0]!.h.done({});
    expect(h.cache.get("af_heart", 1, "One sec.")!.length).toBe(600);
    // A reply line (no cache flag) is never stored.
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-2", text: "Your meeting moved.", voice: "kokoro:af_heart" });
    h.jobs[1]!.h.audio(pcm(100), 0);
    h.jobs[1]!.h.done({});
    expect(h.cache.get("af_heart", 1, "Your meeting moved.")).toBeNull();
  });

  it("not cached and Kokoro not ready: Apple's voice says it now (never waits)", async () => {
    const h = setup({ warm: false });
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hey!", voice: "kokoro:af_heart", cache: true });
    const speak = JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, ""));
    expect(speak.engine).toBeUndefined();
    expect(h.jobs).toHaveLength(0);
  });

  it("a group call pans each line to its Bot's seat (clamped); a 1:1 line has no pan", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hi.", voice: "Zoe", pan: -0.4 });
    expect(JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, "")).pan).toBe(-0.4);
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-2", text: "Hi.", voice: "Zoe", pan: 9 });
    expect(JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, "")).pan).toBe(1);
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-3", text: "Hi.", voice: "Zoe" });
    expect(JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, "")).pan).toBeUndefined();
    await h.dispatch("dictation.spatial", { sessionId: "c1", on: true });
    expect(written(h.kids[0]!).at(-1)).toBe("spatial on\n");
  });

  it("bug 213: a group call's line carries its seat angle (clamped to ±90°) and whose seat it is", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const last = () => JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, "")) as Record<string, unknown>;
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hi.", voice: "Zoe", azimuth: -40, seat: "bot-n" });
    expect(last()).toMatchObject({ azimuth: -40, seat: "bot-n" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-2", text: "Hi.", voice: "Zoe", azimuth: 400, seat: "x".repeat(200) });
    expect(last().azimuth).toBe(90);
    expect(String(last().seat).length).toBeLessThanOrEqual(80);
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-3", text: "Hi.", voice: "Zoe", azimuth: Number.NaN, seat: 5 });
    expect(last().azimuth).toBeUndefined();
    expect(last().seat).toBeUndefined();
  });

  it("bug 213 (review): only a call that starts as a group call starts the helper spatial; a 1:1 call is exactly as before", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    expect(h.spawnFn.mock.calls.at(-1)![1]).not.toContain("--spatial");
    await h.dispatch("dictation.start", { sessionId: "c2", mode: "call", spatial: true });
    expect(h.spawnFn.mock.calls.at(-1)![1]).toContain("--spatial");
    // A 1:1 call that becomes a group call: one "spatial on" (the helper rebuilds once); a Bot leaving: the seats it frees.
    await h.dispatch("dictation.spatial", { sessionId: "c2", on: true });
    expect(written(h.kids.at(-1)!).at(-1)).toBe("spatial on\n");
    await h.dispatch("dictation.seats", { sessionId: "c2", ids: ["n", "l", 7] });
    expect(written(h.kids.at(-1)!).at(-1)).toBe(`seats ${JSON.stringify({ ids: ["n", "l"] })}\n`);
    expect(helperArgs("dictation", undefined, undefined, null, undefined, undefined, [], false, true)).not.toContain("--spatial");
    expect(helperArgs("call", undefined, undefined, null, undefined, undefined, [], true, true)).not.toContain("--spatial"); // a phone call stays mono
  });

  it("bug 213: the helper's output route and microphone choice are parsed events", () => {
    expect(parseDictationLine(JSON.stringify({ type: "route", mode: "headphones", stereo: true, output: { uid: "AP", name: "AirPods Pro" }, transport: "bluetooth", channels: 2 })))
      .toEqual({ type: "route", mode: "headphones", stereo: true, output: { uid: "AP", name: "AirPods Pro" }, transport: "bluetooth", channels: 2 });
    expect(parseDictationLine(JSON.stringify({ type: "route", mode: "bogus" }))).toBeNull();
    expect(parseDictationLine(JSON.stringify({ type: "mic-choice", input: { uid: "B", name: "MacBook Pro Microphone" }, instead: { uid: "AP", name: "AirPods Pro" }, reason: "keep-stereo" })))
      .toEqual({ type: "mic-choice", input: { uid: "B", name: "MacBook Pro Microphone" }, instead: { uid: "AP", name: "AirPods Pro" }, reason: "keep-stereo" });
    expect(parseDictationLine(JSON.stringify({ type: "mic-choice", input: null, instead: null, reason: "none" })))
      .toEqual({ type: "mic-choice", input: null, instead: null, reason: "none" });
  });

  it("join / leave chimes go to the helper's own sound player (never the speech queue)", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.chime", { sessionId: "c1", kind: "join" });
    const fx = written(h.kids[0]!).at(-1)!;
    expect(fx.startsWith("fx ")).toBe(true);
    expect(JSON.parse(fx.slice(3)).data).toBe(chimePcm("join").toString("base64"));
    expect((await h.dispatch("dictation.chime", { sessionId: "c1", kind: "ring" })).ok).toBe(false);
  });
});

describe("the join and leave chimes (synthesized, original)", () => {
  const samples = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const pitch = (x: Float32Array) => { let z = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) z++; return z / x.length; };
  it("short, quiet, click-free; join rises, leave falls", () => {
    for (const kind of ["join", "leave"] as const) {
      const s = samples(chimePcm(kind));
      const ms = (s.length / 24_000) * 1000;
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(450);
      const peak = Math.max(...s.map(Math.abs));
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(0.3);
      expect(Math.abs(s[0]!)).toBeLessThan(0.01);
      expect(Math.abs(s[s.length - 1]!)).toBeLessThan(0.01);
    }
    const j = samples(chimePcm("join")), l = samples(chimePcm("leave"));
    const half = (x: Float32Array, second: boolean) => x.subarray(second ? x.length / 2 : 0, second ? x.length : x.length / 2);
    expect(pitch(half(j, true))).toBeGreaterThan(pitch(half(j, false)));
    expect(pitch(half(l, true))).toBeLessThan(pitch(half(l, false)));
  });
});
