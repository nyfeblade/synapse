import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { registerAudioDevices } from "../../src/main/native/audio-devices";
import { installNativeIpc } from "../../src/main/native";
import { PhraseCache } from "../../src/main/native/voice-cache";

// Bug 134 (item 11): a Bot's voicemail plays in the chat. Its audio is rendered in the Bot's Kokoro
// voice once, kept on this Mac only (30 days), and played through the helper on the chosen speaker;
// without Kokoro, Apple's voice reads the transcript.

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
const TEXT = "Hi, it's Nova. I tried to call you about this: the deploy failed. It's in the chat too, so reply whenever you can.";

function setup(o: { ready?: boolean; warm?: boolean } = {}) {
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as never);
  const kids: Fake[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[]) => { const c = fakeChild(); kids.push(c); return c as unknown as ChildProcess; });
  const jobs: Array<{ job: { id: string; text: string; voice: string }; h: { audio(p: Buffer, seq: number): void; done(i: unknown): void; error(m: string): void } }> = [];
  const tts = { isReady: () => o.ready ?? true, isWarm: () => o.warm ?? true, warm: vi.fn(), cancel: vi.fn(), whenWarm: vi.fn(async () => o.warm ?? true), synth: vi.fn((job, h) => void jobs.push({ job, h })) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-"));
  const voicemails = new PhraseCache({ dir, maxText: 600 });
  registerAudioDevices({ binary: "bots-dictation", spawnFn: spawnFn as never, readPrefs: () => ({ input: null, output: "SPK" }), writePrefs: (p) => p, tts, voicemails });
  const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
  return { kids, jobs, tts, dispatch, spawnFn, voicemails, dir };
}

describe("voicemail playback", () => {
  it("first play renders it in the Bot's Kokoro voice (kept on the Mac); the next play is straight from the file", async () => {
    const h = setup();
    const p = h.dispatch("voicemail.play", { id: "x12", text: TEXT, voice: "kokoro:af_bella" });
    await settle();
    const args = h.spawnFn.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--test-speaker", "--pcm-stdin", "--phrase", TEXT, "--max-seconds", "60", "--output-device", "SPK"]));
    h.jobs[0]!.h.audio(pcm(8), 0);
    h.jobs[0]!.h.done({});
    h.kids[0]!.emit("close", 0, null);
    expect((await p).result).toEqual({ ok: true, engine: "kokoro" });
    expect(h.voicemails.get("af_bella", 1, TEXT)!.length).toBe(32);
    const p2 = h.dispatch("voicemail.play", { id: "x12", text: TEXT, voice: "kokoro:af_bella" });
    await settle();
    expect(h.jobs).toHaveLength(1); // no second synth
    // Bug 161: the silence gate now closes every chunk on a zero sample (a 5 ms raised cosine, or a
    // quarter of the line when it is shorter than that), so what the helper receives is the
    // sidecar's audio with its edges faded — the same samples, the same count, not the same bytes.
    const out = written(h.kids[1]!);
    expect(out).toHaveLength(2);
    // Straight from the cache, so these are the very bytes the first play stored.
    expect(JSON.parse(out[0]!.replace(/^pcm /, "")).data).toBe(h.voicemails.get("af_bella", 1, TEXT)!.toString("base64"));
    expect(out[1]).toBe(`pcm-end ${JSON.stringify({ id: "test" })}\n`);
    h.kids[1]!.emit("close", 0, null);
    expect((await p2).result).toEqual({ ok: true, engine: "kokoro" });
  });

  it("no Kokoro: Apple's voice reads the transcript; stop ends playback", async () => {
    const h = setup({ ready: false });
    const p = h.dispatch("voicemail.play", { id: "x13", text: TEXT, voice: "kokoro:af_bella" });
    await settle();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--test-speaker", "--phrase", TEXT, "--max-seconds", "60", "--output-device", "SPK"]);
    await h.dispatch("voicemail.stop", {});
    expect(h.kids[0]!.kill).toHaveBeenCalled();
    h.kids[0]!.emit("close", null, "SIGTERM");
    await p;
  });

  it("rejects junk", async () => {
    const h = setup();
    expect((await h.dispatch("voicemail.play", { id: "../x", text: TEXT })).ok).toBe(false);
    expect((await h.dispatch("voicemail.play", { id: "x", text: "" })).ok).toBe(false);
    expect((await h.dispatch("voicemail.play", { id: "x", text: "a".repeat(700) })).ok).toBe(false);
  });
});
