import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_PHRASE } from "../../src/main/native/kokoro";
import { registerAudioDevices } from "../../src/main/native/audio-devices";
import { installNativeIpc } from "../../src/main/native";

// Bug 107: Settings → Voice "Preview" of a natural (Kokoro) voice plays through the helper, on the
// chosen output, and still plays (in Apple's voice) when Kokoro can't.

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}
type Fake = ReturnType<typeof fakeChild>;
const written = (c: Fake) => c.stdin.write.mock.calls.map((x) => String(x[0]));
const pcm = (n: number) => Buffer.from(new Float32Array(n).fill(0.25).buffer);
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(o: { ready?: boolean; warm?: boolean } = {}) {
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as never);
  const kids: Fake[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
  const jobs: Array<{ job: { id: string; text: string; voice: string }; h: { audio(p: Buffer, seq: number): void; done(i: unknown): void; error(m: string): void } }> = [];
  const tts = {
    isReady: () => o.ready ?? true, isWarm: () => o.warm ?? true, warm: vi.fn(), cancel: vi.fn(),
    whenWarm: vi.fn(async () => o.warm ?? true), synth: vi.fn((job, h) => void jobs.push({ job, h })),
  };
  registerAudioDevices({ binary: "bots-dictation", spawnFn: spawnFn as never, readPrefs: () => ({ input: null, output: "SPK" }), writePrefs: (p) => p, tts });
  const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
  return { kids, jobs, tts, dispatch, spawnFn };
}

describe("Preview of a natural voice (bug 107)", () => {
  it("waits for Kokoro to be warm, then feeds its PCM to a --pcm-stdin speaker test on the chosen output", async () => {
    const h = setup();
    const p = h.dispatch("audio.testSpeaker", { voice: "kokoro:bm_george" });
    await settle();
    expect(h.tts.whenWarm).toHaveBeenCalled();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--test-speaker", "--pcm-stdin", "--output-device", "SPK"]);
    expect(h.jobs[0]!.job).toMatchObject({ text: PREVIEW_PHRASE, voice: "bm_george" });
    h.jobs[0]!.h.audio(pcm(4), 0);
    h.jobs[0]!.h.done({});
    // Bug 161: the silence gate now closes every chunk on a zero sample (a 5 ms raised cosine, or a
    // quarter of the line when it is shorter than that), so what the helper receives is the
    // sidecar's audio with its edges faded — the same samples, the same count, not the same bytes.
    const out = written(h.kids[0]!);
    expect(out).toHaveLength(2);
    expect(Buffer.from(JSON.parse(out[0]!.replace(/^pcm /, "")).data, "base64")).toHaveLength(pcm(4).length);
    expect(out[1]).toBe(`pcm-end ${JSON.stringify({ id: "test" })}\n`);
    h.kids[0]!.emit("close", 0, null);
    expect((await p).result).toEqual({ ok: true, engine: "kokoro" });
  });

  it("Kokoro failing (or never warming) still plays the preview, in the Apple voice", async () => {
    const h = setup({ warm: false });
    const p = h.dispatch("audio.testSpeaker", { voice: "kokoro:bm_george" });
    await settle();
    expect(written(h.kids[0]!)).toEqual([`pcm-fail ${JSON.stringify({ id: "test" })}\n`]);
    h.kids[0]!.emit("close", 0, null);
    expect((await p).result).toEqual({ ok: true, engine: "apple" });
    const h2 = setup();
    const p2 = h2.dispatch("audio.testSpeaker", { voice: "kokoro:bm_george" });
    await settle();
    h2.jobs[0]!.h.error("boom");
    expect(written(h2.kids[0]!).at(-1)).toBe(`pcm-fail ${JSON.stringify({ id: "test" })}\n`);
    h2.kids[0]!.emit("close", 0, null);
    expect((await p2).result).toEqual({ ok: true, engine: "apple" });
  });

  it("not found: a kokoro: voice previews with Apple's best voice (no --voice, no PCM)", async () => {
    const h = setup({ ready: false });
    const p = h.dispatch("audio.testSpeaker", { voice: "kokoro:bm_george" });
    await settle();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--test-speaker", "--output-device", "SPK"]);
    h.kids[0]!.emit("close", 0, null);
    expect((await p).result).toEqual({ ok: true });
  });

  // Bug 181: the preview is the user's reference for how a Qwen voice sounds, and it was trimmed as a
  // KOKORO line — its tail cut at the last loud sample — while a call keeps Qwen's own 220 ms.
  it("a Qwen voice previews through Qwen's own prosody: the model's tail is kept, as on a call", async () => {
    const h = setup();
    const jobs: Array<{ h: { audio(p: Buffer, seq: number): void; done(i: unknown): void } }> = [];
    const qwen = { isReady: () => true, isWarm: () => true, whenWarm: vi.fn(async () => true), warm: vi.fn(), cancel: vi.fn(), synth: vi.fn((_j: unknown, hh: never) => void jobs.push({ h: hh })) };
    registerAudioDevices({ binary: "bots-dictation", spawnFn: h.spawnFn as never, readPrefs: () => ({ input: null, output: "SPK" }), writePrefs: (x) => x, tts: h.tts, qwen: qwen as never });
    const p = h.dispatch("audio.testSpeaker", { voice: "qwen3:vivian" });
    await settle();
    const x = new Float32Array(24_000);
    for (let i = 0; i < 12_000; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 150 * i) / 24_000);
    for (let i = 12_000; i < x.length; i++) x[i] = 1e-4 * Math.sin(i * 0.3); // the model's quiet tail
    jobs[0]!.h.audio(Buffer.from(x.buffer), 0);
    jobs[0]!.h.done({});
    const sent = written(h.kids[0]!).filter((l) => l.startsWith("pcm ")).reduce((n, l) => n + Buffer.from(JSON.parse(l.slice(4)).data, "base64").length / 4, 0);
    expect(sent).toBeGreaterThanOrEqual(12_000 + 24 * 200); // 500 ms of speech and ~220 ms of its own tail
    h.kids[0]!.emit("close", 0, null);
    expect((await p).result).toMatchObject({ ok: true, engine: "qwen" });
  });
});
