import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS5 } from "@synapse/shared";
import {
  FrameReader, KOKORO_VOICES, KokoroSidecar, encodeFrame, findKokoro, kokoroCommand, kokoroVoiceId, probeKokoro, type KokoroEngine,
} from "../../src/main/native/kokoro";
import { registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Bug 107: Kokoro, a local neural TTS, is Synapse's "Natural" voice engine. A long-running Python
// sidecar (the runtime and model bundled in Synapse.app) streams PCM frames; the Swift helper
// plays them through the call's echo-cancelled audio engine; Apple's voice is the fallback.

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
const ENGINE: KokoroEngine = { python: "/opt/kokoro/python/bin/python3.12", modelDir: "/opt/kokoro/model", source: "settings" };
const pcm = (n: number) => Buffer.from(new Float32Array(n).fill(0.25).buffer);

describe("engine discovery", () => {
  const model = (dir: string) => [`${dir}/config.json`, `${dir}/kokoro-v1_0.safetensors`, `${dir}/voices/af_heart.safetensors`];
  const fs = (files: string[], dirs: Record<string, string[]> = {}) => ({ exists: (p: string) => files.includes(p) || p in dirs, listDir: (p: string) => dirs[p] ?? [] });

  // Portable install: the runtime and model ship inside Synapse.app. The bundled copy comes first, a path
  // the user set by hand second, Synapse's own env last. a voice path outside Synapse's own data and the Hugging Face cache are never
  // probed: a Mac that has them must not be able to hide a broken bundle, and a Mac without them is the norm.
  const bundled = "/App/Synapse.app/Contents/Resources/kokoro";
  const bundledFiles = [`${bundled}/python/bin/python3.12`, ...model(`${bundled}/model`)];
  const outsideFiles = ["/u/voice-lab/.venv/bin/python", ...model("/u/voice-lab/models/tts/kokoro-82m-4bit")];
  const hfRoot = "/u/.cache/huggingface/hub/models--prince-canuma--Kokoro-82M/snapshots";
  const o = { home: "/u", userData: "/data" };

  it("the bundled runtime comes first, whatever else is on the Mac", () => {
    const files = [...bundledFiles, "/opt/py", ...model("/opt/m"), ...outsideFiles, "/data/kokoro/.venv/bin/python", ...model("/data/kokoro/model")];
    expect(findKokoro({ ...o, bundled, ...fs(files), settings: { python: "/opt/py", modelDir: "/opt/m" } }))
      .toEqual({ python: `${bundled}/python/bin/python3.12`, modelDir: `${bundled}/model`, source: "bundled" });
  });

  it("a path set by hand is second, then Synapse's own env", () => {
    const files = ["/opt/py", ...model("/opt/m"), "/data/kokoro/.venv/bin/python", ...model("/data/kokoro/model")];
    expect(findKokoro({ ...o, bundled, ...fs(files), settings: { python: "/opt/py", modelDir: "/opt/m" } })).toEqual({ python: "/opt/py", modelDir: "/opt/m", source: "settings" });
    expect(findKokoro({ ...o, bundled, ...fs(files), settings: { python: "/gone/py", modelDir: "/opt/m" } }))
      .toEqual({ python: "/data/kokoro/.venv/bin/python", modelDir: "/data/kokoro/model", source: "synapse" });
    // A bundle missing its model is not "the bundled runtime".
    expect(findKokoro({ ...o, bundled, ...fs([`${bundled}/python/bin/python3.12`, "/opt/py", ...model("/opt/m")]), settings: { python: "/opt/py", modelDir: "/opt/m" } })?.source).toBe("settings");
  });

  it("never auto-detects a voice path outside its own data or the Hugging Face cache", () => {
    const files = [...outsideFiles, ...model(`${hfRoot}/abc123`)];
    expect(findKokoro({ ...o, bundled: null, ...fs(files, { [hfRoot]: ["abc123"] }) })).toBeNull();
    expect(findKokoro({ ...o, bundled: "/missing", ...fs(files, { [hfRoot]: ["abc123"] }) })).toBeNull();
    // Only a path the user typed in reaches it.
    expect(findKokoro({ ...o, bundled: null, ...fs(files), settings: { python: "/u/voice-lab/.venv/bin/python", modelDir: "/u/voice-lab/models/tts/kokoro-82m-4bit" } })?.source).toBe("settings");
  });

  it("keeps compiled bytecode out of the bundle: every spawn points pycache at Synapse's cache folder", async () => {
    const e: KokoroEngine = { python: `${bundled}/python/bin/python3.12`, modelDir: `${bundled}/model`, source: "bundled" };
    expect(kokoroCommand(e, "/s.py", { cacheDir: "/data/kokoro-cache" }).args.slice(0, 6)).toEqual(["-arm64", e.python, "-s", "-E", "-X", "pycache_prefix=/data/kokoro-cache/pycache"]);
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const cached = probeKokoro(e, { spawnFn: spawnFn as never, cacheDir: "/data/kokoro-cache" });
    expect(spawnFn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["-X", "pycache_prefix=/data/kokoro-cache/pycache"]));
    kids[0]!.emit("close", 0, null);
    await cached;
    const plain = probeKokoro(e, { spawnFn: spawnFn as never });
    expect(spawnFn.mock.calls[1]![1]).toContain("-B");
    kids[1]!.emit("close", 0, null);
    await plain;
  });

  it("runs under arm64 with an isolated Python (no user site, no PYTHON* env)", () => {
    expect(kokoroCommand(ENGINE, "/app/native/kokoro_server.py")).toEqual({
      cmd: "/usr/bin/arch", args: ["-arm64", ENGINE.python, "-s", "-E", "/app/native/kokoro_server.py", "--model-dir", ENGINE.modelDir],
    });
  });

  it("probe: a 3 s import test — ok on exit 0, a reason on failure, killed on timeout", async () => {
    vi.useFakeTimers();
    try {
      const kids: Fake[] = [];
      const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
      const ok = probeKokoro(ENGINE, { spawnFn: spawnFn as never });
      expect(spawnFn.mock.calls[0]![0]).toBe("/usr/bin/arch");
      expect((spawnFn.mock.calls[0]![1] as string[]).join(" ")).toMatch(/-c .*mlx_audio.*misaki/);
      kids[0]!.emit("close", 0, null);
      await expect(ok).resolves.toMatchObject({ ok: true });
      const bad = probeKokoro(ENGINE, { spawnFn: spawnFn as never });
      kids[1]!.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'misaki'\n"));
      kids[1]!.emit("close", 1, null);
      await expect(bad).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("misaki") });
      const slow = probeKokoro(ENGINE, { spawnFn: spawnFn as never });
      vi.advanceTimersByTime(LIMITS5.kokoroProbeMs + 1);
      expect(kids[2]!.kill).toHaveBeenCalledWith("SIGKILL");
      kids[2]!.emit("close", null, "SIGKILL");
      await expect(slow).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/3 s|timed out/i) });
    } finally { vi.useRealTimers(); }
  });

  it("the curated voices are English Kokoro voices, and only a kokoro: id names one", () => {
    expect(KOKORO_VOICES.map((v) => v.id)).toEqual(expect.arrayContaining(["af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "am_puck", "bf_emma", "bm_george", "bm_fable"]));
    for (const v of KOKORO_VOICES) expect(v.id).toMatch(/^[ab][fm]_[a-z]+$/);
    expect(kokoroVoiceId("kokoro:af_heart")).toBe("af_heart");
    expect(kokoroVoiceId("af_heart")).toBeNull();
    expect(kokoroVoiceId("kokoro:../../etc")).toBeNull();
    expect(kokoroVoiceId("com.apple.voice.premium.en-US.Zoe")).toBeNull();
  });
});

describe("the sidecar's frames", () => {
  it("decodes length-prefixed frames split anywhere across chunks", () => {
    const a = encodeFrame({ type: "audio", id: "s1", seq: 0, samples: 3 }, pcm(3));
    const d = encodeFrame({ type: "done", id: "s1", seq: 1, synthMs: 90, audioMs: 1000, rtf: 0.09, firstMs: 80 });
    const all = Buffer.concat([a, d]);
    const r = new FrameReader();
    const out = [...r.push(all.subarray(0, 5)), ...r.push(all.subarray(5, a.length + 3)), ...r.push(all.subarray(a.length + 3))];
    expect(out.map((f) => f.header.type)).toEqual(["audio", "done"]);
    expect(out[0]!.pcm.length).toBe(12);
    expect(new Float32Array(out[0]!.pcm.buffer, out[0]!.pcm.byteOffset, 3)[2]).toBeCloseTo(0.25);
  });

  it("a corrupt length resets the reader instead of buffering forever", () => {
    const r = new FrameReader();
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(0x7fffffff, 0);
    expect(r.push(bad)).toEqual([]);
    expect(r.push(encodeFrame({ type: "warm", ms: 5 })).map((f) => f.header.type)).toEqual(["warm"]);
  });
});

describe("the sidecar process", () => {
  afterEach(() => vi.useRealTimers());
  function setup() {
    vi.useFakeTimers();
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const log = vi.fn();
    const s = new KokoroSidecar({ engine: ENGINE, script: "/app/kokoro_server.py", spawnFn: spawnFn as never, log });
    const send = (c: Fake, h: Record<string, unknown>, p?: Buffer) => c.stdout.emit("data", encodeFrame(h, p));
    const handlers = () => ({ audio: vi.fn(), done: vi.fn(), error: vi.fn() });
    return { kids, spawnFn, log, s, send, handlers };
  }

  it("spawns once, reports warm, streams audio then done to the right job, and logs the timings", () => {
    const t = setup();
    t.s.start();
    t.s.start();
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.s.isWarm()).toBe(false);
    t.send(t.kids[0]!, { type: "ready", sampleRate: 24000, loadMs: 812 });
    t.send(t.kids[0]!, { type: "warm", ms: 240 });
    expect(t.s.isWarm()).toBe(true);
    const h = t.handlers();
    t.s.synth({ id: "sp-1", text: "Hello there.", voice: "af_heart", speed: 1 }, h);
    expect(JSON.parse(written(t.kids[0]!).at(-1)!)).toEqual({ op: "synth", id: "sp-1", text: "Hello there.", voice: "af_heart", speed: 1 });
    t.send(t.kids[0]!, { type: "audio", id: "sp-1", seq: 0, samples: 4 }, pcm(4));
    t.send(t.kids[0]!, { type: "audio", id: "other", seq: 0, samples: 4 }, pcm(4));
    t.send(t.kids[0]!, { type: "done", id: "sp-1", seq: 1, synthMs: 150, audioMs: 1200, rtf: 0.125, firstMs: 140 });
    expect(h.audio).toHaveBeenCalledTimes(1);
    expect(h.done).toHaveBeenCalledWith(expect.objectContaining({ synthMs: 150, rtf: 0.125 }));
    const lines = t.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toMatch(/model loaded in 812 ms/);
    expect(lines).toMatch(/warm in 240 ms/);
    expect(lines).toMatch(/sp-1.*150 ms.*1200 ms.*rtf 0\.125/);
  });

  it("cancel drops the job's handlers and tells the sidecar; cancel-all clears everything", () => {
    const t = setup();
    t.s.start();
    const a = t.handlers(), b = t.handlers();
    t.s.synth({ id: "a", text: "One.", voice: "af_heart", speed: 1 }, a);
    t.s.synth({ id: "b", text: "Two.", voice: "af_heart", speed: 1 }, b);
    t.s.cancel("a");
    expect(JSON.parse(written(t.kids[0]!).at(-1)!)).toEqual({ op: "cancel", id: "a" });
    t.send(t.kids[0]!, { type: "audio", id: "a", seq: 0, samples: 4 }, pcm(4));
    expect(a.audio).not.toHaveBeenCalled();
    t.s.cancel();
    expect(JSON.parse(written(t.kids[0]!).at(-1)!)).toEqual({ op: "cancel" });
    t.send(t.kids[0]!, { type: "done", id: "b", seq: 0, synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    expect(b.done).not.toHaveBeenCalled();
  });

  it("a crash fails every pending job (so each falls back to Apple) and the next synth respawns", () => {
    const t = setup();
    t.s.start();
    const h = t.handlers();
    t.s.synth({ id: "a", text: "One.", voice: "af_heart", speed: 1 }, h);
    t.kids[0]!.stderr.emit("data", Buffer.from("Traceback: boom\n"));
    t.kids[0]!.emit("close", 1, null);
    expect(h.error).toHaveBeenCalledWith(expect.stringMatching(/exit 1/));
    expect(t.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/kokoro: Traceback: boom/);
    t.s.synth({ id: "b", text: "Two.", voice: "af_heart", speed: 1 }, t.handlers());
    expect(t.spawnFn).toHaveBeenCalledTimes(2);
  });

  it("an error frame fails only that job", () => {
    const t = setup();
    t.s.start();
    const a = t.handlers(), b = t.handlers();
    t.s.synth({ id: "a", text: "One.", voice: "af_heart", speed: 1 }, a);
    t.s.synth({ id: "b", text: "Two.", voice: "af_heart", speed: 1 }, b);
    t.send(t.kids[0]!, { type: "error", id: "a", message: "ValueError: unknown voice" });
    expect(a.error).toHaveBeenCalledWith("ValueError: unknown voice");
    expect(b.error).not.toHaveBeenCalled();
  });

  it("idles out after 5 minutes without work, never while a job is pending, and is killed on dispose", () => {
    const t = setup();
    t.s.start();
    t.s.synth({ id: "a", text: "One.", voice: "af_heart", speed: 1 }, t.handlers());
    vi.advanceTimersByTime(LIMITS5.kokoroIdleMs + 1);
    expect(t.kids[0]!.stdin.end).not.toHaveBeenCalled(); // busy (and not stalled: it just went quiet… see the stall test)
    t.send(t.kids[0]!, { type: "done", id: "a", seq: 0, synthMs: 1, audioMs: 1, rtf: 1, firstMs: 1 });
    vi.advanceTimersByTime(LIMITS5.kokoroIdleMs - 1000);
    expect(t.kids[0]!.stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(t.kids[0]!.stdin.end).toHaveBeenCalled();
    expect(t.s.isRunning()).toBe(false);
    t.s.start();
    t.s.dispose();
    expect(t.kids[1]!.stdin.end).toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(t.kids[1]!.kill).toHaveBeenCalled();
  });

  it("a sidecar that goes silent with work pending is killed, and its jobs fail", () => {
    const t = setup();
    t.s.start();
    t.send(t.kids[0]!, { type: "ready", sampleRate: 24000, loadMs: 1 });
    t.send(t.kids[0]!, { type: "warm", ms: 1 });
    const h = t.handlers();
    t.s.synth({ id: "a", text: "One.", voice: "af_heart", speed: 1 }, h);
    vi.advanceTimersByTime(LIMITS5.kokoroStallMs + 500);
    expect(t.kids[0]!.kill).toHaveBeenCalled();
    t.kids[0]!.emit("close", null, "SIGKILL");
    expect(h.error).toHaveBeenCalled();
  });
});

describe("voice calls speak through Kokoro, played by the helper (bug 107)", () => {
  function setup(o: { ready?: boolean; warm?: boolean } = {}) {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const win = { isDestroyed: () => false, webContents: { send: (_ch: string, msg: { channel: string; payload: Record<string, unknown> }) => sent.push(msg) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
    const jobs: Array<{ job: { id: string; text: string; voice: string; speed: number }; h: { audio(p: Buffer, seq: number): void; done(i: unknown): void; error(m: string): void } }> = [];
    const tts = { isReady: vi.fn(() => o.ready ?? true), isWarm: vi.fn(() => o.warm ?? true), warm: vi.fn(), cancel: vi.fn(), synth: vi.fn((job, h) => void jobs.push({ job, h })) };
    const log = vi.fn();
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, log, tts, voice: () => "kokoro:bf_emma" });
    const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    return { sent, kids, jobs, tts, dispatch, log, spawnFn };
  }

  it("a call warms Kokoro at start and never passes a kokoro: voice to the helper's Apple synthesizer", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    expect(h.tts.warm).toHaveBeenCalled();
    expect((h.spawnFn.mock.calls[0]![1] as string[]).join(" ")).not.toMatch(/kokoro/);
  });

  it("a kokoro: line opens a PCM line in the helper, streams each chunk to it, and ends it", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const r = await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hello there.", voice: "kokoro:af_bella", rate: 1.25, queue: true, pauseMs: LIMITS5.sentencePauseMs });
    expect(r.result).toEqual({ spoken: true });
    const lines = written(h.kids[0]!);
    const speak = JSON.parse(lines.at(-1)!.replace(/^speak /, ""));
    expect(speak).toMatchObject({ id: "sp-1", text: "Hello there.", engine: "pcm", queue: true, pauseMs: LIMITS5.sentencePauseMs });
    expect(speak.voice).toBeUndefined(); // the Apple fallback uses the helper's own best voice
    expect(h.jobs[0]!.job).toEqual({ id: "sp-1", text: "Hello there.", voice: "af_bella", speed: 1.25 });
    h.jobs[0]!.h.audio(pcm(4), 0);
    h.jobs[0]!.h.done({});
    const out = written(h.kids[0]!);
    // Bug 161: the silence gate now closes every chunk on a zero sample (a 5 ms raised cosine, or a
    // quarter of the line when it is shorter than that), so what the helper receives is the
    // sidecar's audio with its edges faded — the same samples, the same count, not the same bytes.
    const sent = JSON.parse(out.at(-2)!.replace(/^pcm /, ""));
    expect(sent.id).toBe("sp-1");
    expect(Buffer.from(sent.data, "base64")).toHaveLength(pcm(4).length);
    expect(out.at(-1)).toBe(`pcm-end ${JSON.stringify({ id: "sp-1" })}\n`);
  });

  it("a Kokoro failure tells the helper to fall back to Apple for that line, logs it and shows a note", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hello.", voice: "kokoro:af_bella" });
    h.jobs[0]!.h.error("The natural voice stopped (exit 1).");
    expect(written(h.kids[0]!).at(-1)).toBe(`pcm-fail ${JSON.stringify({ id: "sp-1" })}\n`);
    expect(h.sent.some((m) => m.payload.type === "tts-fallback" && m.payload.sessionId === "c1")).toBe(true);
    expect(h.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/kokoro.*fell back to Apple.*exit 1/i);
  });

  it("not ready or still warming: the line is spoken by Apple straight away (logged, no PCM line)", async () => {
    for (const o of [{ ready: false }, { warm: false }]) {
      const h = setup(o);
      await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
      await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hello.", voice: "kokoro:af_bella" });
      const speak = JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, ""));
      expect(speak.engine).toBeUndefined();
      expect(speak.voice).toBeUndefined();
      expect(h.jobs).toHaveLength(0);
    }
  });

  it("hush, barge-in and stop cancel Kokoro; audio for a superseded helper never reaches the new one", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hello.", voice: "kokoro:af_bella" });
    await h.dispatch("dictation.hush", { sessionId: "c1" });
    expect(h.tts.cancel).toHaveBeenCalledTimes(1);
    h.kids[0]!.stdout.emit("data", Buffer.from('{"type":"barge-in"}\n'));
    expect(h.tts.cancel).toHaveBeenCalledTimes(2);
    await h.dispatch("dictation.start", { sessionId: "c2", mode: "call" });
    const before = written(h.kids[1]!).length;
    h.jobs[0]!.h.audio(pcm(4), 0);
    expect(written(h.kids[1]!).length).toBe(before);
    expect(written(h.kids[0]!).some((l) => l.startsWith("pcm "))).toBe(false); // the old helper was told to stop, not fed
    await h.dispatch("dictation.stop", { sessionId: "c2" });
    expect(h.tts.cancel.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("an Apple voice line is unchanged, plus the pause between sentences the call asks for (bounded)", async () => {
    const h = setup();
    await h.dispatch("dictation.start", { sessionId: "c1", mode: "call" });
    const bad = await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-0", text: "Hello.", voice: "Zoe", pauseMs: 60_000 });
    expect(bad.ok).toBe(false);
    await h.dispatch("dictation.speak", { sessionId: "c1", id: "sp-1", text: "Hello.", voice: "Zoe", pauseMs: LIMITS5.sentencePauseMs });
    const speak = JSON.parse(written(h.kids[0]!).at(-1)!.replace(/^speak /, ""));
    expect(speak).toEqual({ id: "sp-1", text: "Hello.", voice: "Zoe", pauseMs: LIMITS5.sentencePauseMs });
    expect(h.jobs).toHaveLength(0);
  });
});
