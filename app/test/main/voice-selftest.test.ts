import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_SELFTEST, type SelfTestReport } from "@synapse/shared";
import { SELFTEST_REPLY, reportDir, runVoiceSelfTest, scheduleVoiceSelfTest, speechEndMs, writeReport } from "../../src/main/native/voice-selftest";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "voice-selftest-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A 16 kHz mono 16-bit WAV: `lead` ms of silence, `voice` ms of a tone, `tail` ms of silence. */
function wav(lead: number, voice: number, tail: number): Buffer {
  const n = (ms: number) => Math.round((ms / 1000) * 16_000);
  const total = n(lead) + n(voice) + n(tail);
  const data = Buffer.alloc(total * 2);
  for (let i = n(lead); i < n(lead) + n(voice); i++) data.writeInt16LE(Math.round(Math.sin(i / 5) * 8_000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A fake helper: after `audio` it plays the clip's clock; the test drives its events. */
function fakeHelper() {
  const c = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn>; on: () => void }; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  c.stdin = { write: vi.fn(), on: () => {} };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn(() => c.emit("close"));
  const say = (o: object) => c.stdout.emit("data", Buffer.from(`${JSON.stringify(o)}\n`));
  return { c, say };
}

function setup(o: { tts?: "fake" | null; renderMs?: number } = {}) {
  const dir = tmp();
  const clip = path.join(dir, "clip.wav");
  fs.writeFileSync(clip, wav(200, 1_800, 300)); // speech ends 2,000 ms into the clip
  const helper = path.join(dir, "bots-dictation");
  fs.writeFileSync(helper, "");
  const clock = { t: 10_000 };
  const h = fakeHelper();
  const synth = vi.fn((_job: { text: string }, hd: { audio(b: Buffer, s: number): void; done(i: unknown): void }) => {
    setTimeout(() => { clock.t += o.renderMs ?? 250; hd.audio(Buffer.alloc(8), 0); hd.done({}); }, 0);
  });
  const tts = o.tts === null ? null : { isWarm: () => true, synth, cancel: vi.fn() };
  const run = runVoiceSelfTest({ helper, clip, tts: tts as never, spawnFn: (() => h.c as unknown as ChildProcess) as never, now: () => clock.t });
  return { ...h, clock, run, synth, tts };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("5.8: the self-test's stages, with a fake helper and a fake natural voice", () => {
  it("the end of speech comes from the clip itself", () => {
    expect(speechEndMs(wav(200, 1_800, 300))).toBeCloseTo(2_000, -1);
    expect(speechEndMs(wav(500, 0, 500))).toBeNull();
  });

  it("times final, first chunk and first audio from the end of speech; passes inside the budget", async () => {
    const s = setup({ renderMs: 250 });
    s.say({ type: "audio", source: "file" }); // the clip starts: speech ends 2,000 ms later
    s.clock.t += 2_500; s.say({ type: "likely-end", text: "what time is it in tokyo" });
    s.clock.t += 400; s.say({ type: "final", text: "What time is it in Tokyo right now?" });
    await tick();
    const speak = s.c.stdin.write.mock.calls.map((x) => x[0] as string).find((l) => l.startsWith("speak "))!;
    const cmd = JSON.parse(speak.slice(6));
    expect(cmd.engine).toBe("pcm");
    expect(SELFTEST_REPLY.startsWith(cmd.text)).toBe(true); // the chunker's first line, not the whole reply
    s.clock.t += 5; s.say({ type: "speak-audio", id: cmd.id });
    const r = await s.run;
    expect(r).toMatchObject({ ok: true, tts: "kokoro", scriptedReply: true, stages: { likelyEnd: 500, sttFinal: 900, firstToken: 900, firstChunk: 1_150, firstAudio: 1_155 } });
    expect(s.c.stdin.write.mock.calls.map((x) => x[0]).some((l) => l === "stop\n")).toBe(true); // the helper is always stopped
  });

  it("fails over its own 1.4 s budget (the pipeline it measures, not the 1.2 s call goal), and says by how much", async () => {
    const s = setup({ renderMs: 650 });
    s.say({ type: "audio" });
    s.clock.t += 3_000; s.say({ type: "final", text: "What time is it?" });
    await tick();
    const id = JSON.parse((s.c.stdin.write.mock.calls.map((x) => x[0] as string).find((l) => l.startsWith("speak "))!).slice(6)).id;
    s.say({ type: "speak-audio", id });
    const r = await s.run;
    expect(r.ok).toBe(false);
    expect(r.stages.firstAudio).toBe(1_650);
    expect(r.error).toMatch(/1650 ms is over the 1400 ms budget/);
  });

  it("no natural voice: the helper's own voice says the line, and the report says so", async () => {
    const s = setup({ tts: null });
    s.say({ type: "audio" });
    s.clock.t += 2_800; s.say({ type: "final", text: "What time is it?" });
    await tick();
    const line = s.c.stdin.write.mock.calls.map((x) => x[0] as string).find((l) => l.startsWith("speak "))!;
    expect(JSON.parse(line.slice(6)).engine).toBeUndefined();
    s.clock.t += 300; s.say({ type: "speak-audio", id: JSON.parse(line.slice(6)).id });
    const r = await s.run;
    expect(r).toMatchObject({ ok: true, tts: "apple", stages: { firstChunk: null, firstAudio: 1_100 } });
  });

  it("nothing recognised, a helper that dies, a missing clip: a failed report, never a hang", async () => {
    const a = setup();
    a.say({ type: "audio" });
    a.say({ type: "final", text: " " });
    expect((await a.run).error).toMatch(/no words/);
    const b = setup();
    b.c.emit("close");
    expect((await b.run).error).toMatch(/stopped before/);
    const r = await runVoiceSelfTest({ helper: "/nope", clip: "/nope.wav", tts: null });
    expect(r).toMatchObject({ ok: false, error: "the fixture clip is missing or silent" });
  });

  it("a call starting mid-run stops it at once (and cancels its line in the natural voice)", async () => {
    const dir = tmp();
    const clip = path.join(dir, "clip.wav");
    fs.writeFileSync(clip, wav(0, 1_000, 0));
    fs.writeFileSync(path.join(dir, "h"), "");
    const h = fakeHelper();
    const ac = new AbortController();
    const tts = { isWarm: () => true, synth: vi.fn(), cancel: vi.fn() };
    const p = runVoiceSelfTest({ helper: path.join(dir, "h"), clip, tts, spawnFn: (() => h.c as unknown as ChildProcess) as never, signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, error: "stopped: a call started" });
    expect(tts.cancel).toHaveBeenCalled();
  });

  it("writes the report by date: the repo's test-reports in a dev build, the app's own folder when packaged", () => {
    const d = tmp();
    const r: SelfTestReport = { at: "2026-09-30T03:30:00.000Z", ok: true, budgetMs: 1_200, tts: "kokoro", scriptedReply: true, stages: { likelyEnd: 1, sttFinal: 2, firstToken: 2, firstChunk: 3, firstAudio: 4 } };
    expect(path.basename(writeReport(d, r))).toBe("2026-09-30.json");
    expect(reportDir({ isPackaged: false, appPath: "/repo/app", userData: "/ud" })).toBe("/repo/test-reports/voice-selftest");
    expect(reportDir({ isPackaged: true, appPath: "/x", userData: "/ud" })).toBe("/ud/voice-selftest");
  });
});

describe("5.8: the nightly schedule", () => {
  const quiet = new Date(2026, 8, 30, 3, 30);
  const idle = { enabled: true, inCall: false, onBattery: false, load1: 1, cpus: 10, idleMs: 60 * 60_000 };
  const report: SelfTestReport = { at: "", ok: true, budgetMs: 1_200, tts: "kokoro", scriptedReply: true, stages: { likelyEnd: null, sttFinal: null, firstToken: null, firstChunk: null, firstAudio: null } };

  function sched(c: Partial<typeof idle> = {}, o: { last?: number | null; run?: (s: AbortSignal) => Promise<SelfTestReport> } = {}) {
    const run = vi.fn(o.run ?? (async () => report));
    const done = vi.fn();
    const every = vi.fn(() => ({ stop: vi.fn() }));
    const s = scheduleVoiceSelfTest({ conditions: () => ({ ...idle, ...c }), lastRunAt: () => o.last ?? null, run, done, now: () => quiet, every });
    return { s, run, done, every };
  }

  it("looks every ten minutes and runs once at a quiet hour on an idle Mac", async () => {
    const x = sched();
    expect(x.every).toHaveBeenCalledWith(VOICE_SELFTEST.checkEveryMs, expect.any(Function));
    expect(await x.s.check()).toBe("ran");
    expect(x.done).toHaveBeenCalledWith(report);
  });

  it("skips during a call, on battery, on a busy or in-use Mac, with the setting off, or when it ran today", async () => {
    expect(await sched({ inCall: true }).s.check()).toBe("in-call");
    expect(await sched({ onBattery: true }).s.check()).toBe("on-battery");
    expect(await sched({ load1: 8 }).s.check()).toBe("busy");
    expect(await sched({ idleMs: 30_000 }).s.check()).toBe("in-use");
    expect(await sched({ enabled: false }).s.check()).toBe("off");
    expect(await sched({}, { last: quiet.getTime() - 3_600_000 }).s.check()).toBe("ran-today");
    const x = sched({ load1: 8 });
    await x.s.check();
    expect(x.run).not.toHaveBeenCalled();
  });

  it("one run at a time, and a call starting aborts the run in progress", async () => {
    let seen: AbortSignal | null = null;
    let release: (r: SelfTestReport) => void = () => {};
    const x = sched({}, { run: (s) => { seen = s; return new Promise((r) => { release = r; }); } });
    const first = x.s.check();
    expect(await x.s.check()).toBe("running");
    x.s.callStarted();
    expect(seen!.aborted).toBe(true);
    release(report);
    expect(await first).toBe("ran");
  });
});
