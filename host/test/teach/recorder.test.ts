import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { STR, type SseEvent, type TeachStatus } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import type { WakeSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { findQueueEntry } from "../../teach/queue";
import { ffmpegArgs, parseVideoStartMs, TeachRecorder, teachHandlers, type ChildLike, type RecorderDeps } from "../../teach/recorder";
import { tmpConfig } from "../helpers";

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdin = new PassThrough();
  stderr = new PassThrough();
  killed: (string | number | undefined)[] = [];
  constructor() {
    super();
    this.stdin.on("data", (b: Buffer) => { if (b.toString().includes("q")) setTimeout(() => this.emit("exit", 0), 5); });
  }
  kill(sig?: NodeJS.Signals | number) { this.killed.push(sig); setTimeout(() => this.emit("exit", null), 5); return true; }
}

function setup(o: { display?: string | null; sidecar?: RecorderDeps["sidecar"] } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  const wakes: WakeSpec[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let sidecarStopped = 0;
  let t = Date.UTC(2026, 8, 18, 17, 12, 0);
  const rec = new TeachRecorder({
    cfg, bots, hub, now: () => t,
    runner: { enqueueWake: (_b: string, w: WakeSpec) => { wakes.push(w); return "task"; } },
    displayOf: () => (o.display === undefined ? ":3" : o.display),
    cdpPortOf: () => 9223,
    spawn: (cmd, args, opts) => { const child = new FakeChild(); spawned.push({ cmd, args, env: opts.env, child }); return child; },
    // Bug 47: a handle that reports its own outcome — the fixture starts, so it says so.
    sidecar: o.sidecar ?? (() => ({ stop: async () => { sidecarStopped++; }, started: async () => true })),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { cfg, bots, id, rec, spawned, wakes, timers, events, advance: (ms: number) => { t += ms; }, sidecarStopped: () => sidecarStopped };
}

describe("ffmpeg capture (TCH-03, byte-for-byte parity)", () => {
  it("uses the exact capture arguments", () => {
    expect(ffmpegArgs(":3", "/w/demo.mp4")).toEqual([
      "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "15", "-i", ":3",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "75", "-an", "-t", "600", "-protocol_whitelist", "file", "-f", "mp4", "/w/demo.mp4", // + I8 output lock
    ]);
  });
  it("reads the first-frame wall-clock start from the log", () => {
    expect(parseVideoStartMs("Input #0, x11grab, from ':3':\n  Duration: N/A, start: 1789751520.250000, bitrate: N/A")).toBe(1789751520250);
    expect(parseVideoStartMs("nothing here")).toBeNull();
  });
});

describe("TeachRecorder (TCH-01, TCH-02, ORIG-08 §08.3)", () => {
  it("starts a recording: session folder, pid, partial session.json, auto stop at 602 s, SSE status", () => {
    const s = setup();
    const st = s.rec.start(s.id, "File an expense from the receipt");
    expect(st).toMatchObject({ state: "RECORDING", botId: s.id, goal: "File an expense from the receipt" });
    expect(st.sessionId).toMatch(/^teach-20260918-171200-[0-9a-f-]{36}$/);
    expect(st.sessionDir).toBe(path.join(s.cfg.hostPrivate, "teach-sessions", st.sessionId!)); // I8: hostPrivate until scrubbed
    expect(s.spawned[0]).toMatchObject({ cmd: "ffmpeg", args: ffmpegArgs(":3", path.join(st.sessionDir!, "demo.mp4")) });
    expect(s.spawned[0]!.env.DISPLAY).toBe(":3");
    expect(fs.readFileSync(path.join(st.sessionDir!, "ffmpeg.pid"), "utf8")).toBe("4242");
    // Bug 47: the partial record is written before the sidecar's asynchronous start has reported, so
    // it says 0 here; the claim that a sidecar that DID start is recorded as version 1 moved to the
    // stop test below, where the record is final and the outcome is known.
    expect(JSON.parse(fs.readFileSync(path.join(st.sessionDir!, "session.json"), "utf8"))).toMatchObject({ goal: "File an expense from the receipt", display: ":3", viewport: [1280, 800], cdpPort: 9223, sidecarVersion: 0 });
    expect(s.timers.at(-1)!.ms).toBe(602_000);
    expect(s.events.some((e) => e.channel === "teach-recording" && e.payload.state === "RECORDING")).toBe(true);
  });

  it("allows one recording globally, one-to-one chats only, and needs the Bot's own screen", () => {
    const s = setup();
    s.rec.start(s.id, "goal");
    const other = s.bots.create({ origin: "user", kickstart: false, name: "Scout" });
    expect(() => s.rec.start(other, "goal")).toThrow("Another recording is in progress.");
    const noScreen = setup({ display: null });
    expect(() => noScreen.rec.start(noScreen.id, "goal")).toThrow("Teach a task needs the Bot's own screen.");
    const grp = setup();
    const orig = grp.bots.summary.bind(grp.bots);
    grp.bots.summary = (x: string) => ({ ...orig(x), group: { memberIds: ["a", "b"] } });
    expect(() => grp.rec.start(grp.id, "goal")).toThrow("Teach a task works only in a one-to-one chat.");
  });

  it("stop finalizes: ffmpeg quits gracefully, session.json gets the video offset, a signed queue entry, and the Bot is woken", async () => {
    const s = setup();
    const st = s.rec.start(s.id, "File an expense");
    s.spawned[0]!.child.stderr.write("Input #0, x11grab, from ':3':\n  Duration: N/A, start: 1789751520.250000, bitrate: N/A\n");
    s.advance(30_000);
    const done = await s.rec.stop(s.id);
    expect(done.state).toBe("ANALYZING");
    expect(s.sidecarStopped()).toBe(1);
    const published = done.sessionDir!; // I8: published to the workspace after the scrub
    expect(published).toBe(path.join(s.cfg.workspace, ".host-out", "teach", st.sessionId!)); // secfix round 3: host-owned output
    const session = JSON.parse(fs.readFileSync(path.join(published, "session.json"), "utf8"));
    expect(session.videoStartPtsMs).toBe(1789751520250 - session.startedAtMs);
    expect(session.sidecarVersion, "this fixture's sidecar reports that it started").toBe(1);
    expect(fs.readFileSync(path.join(published, "ffmpeg.log"), "utf8")).toContain("x11grab");
    expect(findQueueEntry({ keyFile: path.join(s.cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(s.cfg.hostPrivate, "teach-queue.jsonl"), sessionId: st.sessionId!, botId: s.id })).toMatchObject({ sessionDir: published });
    expect(fs.statSync(path.join(s.cfg.hostPrivate, "teach-queue-key.json")).mode & 0o777).toBe(0o600);
    expect(s.wakes).toHaveLength(1);
    expect(s.wakes[0]).toMatchObject({ source: "teach", lane: "user", silenceAllowed: false });
    const text = s.wakes[0]!.prompt().map((m) => (m as { text: string }).text).join("\n");
    expect(text).toContain(STR.teachFinishedWake);
    expect(text).toContain(published);
  });

  it("the auto-stop timer finalizes the recording", async () => {
    const s = setup();
    s.rec.start(s.id, "goal");
    s.timers.at(-1)!.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.rec.status().state).toBe("ANALYZING");
  });

  it("discard kills ffmpeg and removes the folder; a forged queue entry never verifies", async () => {
    const s = setup();
    const st = s.rec.start(s.id, "goal");
    const done = await s.rec.discard(s.id);
    expect(done.state).toBe("DISCARDED");
    expect(s.spawned[0]!.child.killed).toContain("SIGKILL");
    expect(fs.existsSync(st.sessionDir!)).toBe(false);
    fs.appendFileSync(path.join(s.cfg.hostPrivate, "teach-queue.jsonl"), JSON.stringify({ sessionId: "teach-x", botId: s.id, sessionDir: "/etc", createdAt: 1, sig: "00" }) + "\n");
    expect(findQueueEntry({ keyFile: path.join(s.cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(s.cfg.hostPrivate, "teach-queue.jsonl"), sessionId: "teach-x", botId: s.id })).toBeNull();
  });

  it("enforces the state machine", async () => {
    const s = setup();
    s.rec.start(s.id, "goal");
    expect(() => s.rec.setState("TESTED")).toThrow("RECORDING → TESTED");
    await s.rec.stop(s.id);
    s.rec.setState("DRAFTED");
    s.rec.setState("REHEARSING");
    s.rec.setState("NEEDS_FIX");
    s.rec.setState("DRAFTED");
    s.rec.setState("REHEARSING");
    s.rec.setState("TESTED");
    s.rec.setState("ACCEPTED");
    expect(() => s.rec.setState("DISCARDED")).toThrow("ACCEPTED → DISCARDED");
  });

  it("refuses to start a new recording while a prior session is mid-review, and leaves it untouched", async () => {
    const s = setup();
    const first = s.rec.start(s.id, "first goal");
    await s.rec.stop(s.id);
    s.rec.setState("DRAFTED");
    expect(s.rec.status().state).toBe("DRAFTED");
    expect(() => s.rec.start(s.id, "second goal")).toThrow("Another recording is in progress.");
    // the prior session must survive untouched: no silent reset to IDLE, no orphaned second recording
    expect(s.rec.status().state).toBe("DRAFTED");
    expect(s.rec.current()?.sessionId).toBe(first.sessionId);
    expect(s.spawned).toHaveLength(1);
    expect(fs.existsSync(s.rec.current()!.sessionDir)).toBe(true);
    void first;
  });

  it("gateway handlers wrap the recorder", async () => {
    const s = setup();
    const h = teachHandlers(s.rec);
    expect((await h.startTeachRecording!({ id: s.id, goal: "g" })).status.state).toBe("RECORDING");
    expect((await h.getTeachRecordingStatus!({} as never)).status.state).toBe("RECORDING");
    expect((await h.stopTeachRecording!({ id: s.id })).status.state).toBe("ANALYZING");
  });
});

describe("TeachRecorder pause when the app goes away", () => {
  it("pauses capture without finalizing, and resume starts the next segment from the same elapsed time", async () => {
    const s = setup();
    s.rec.start(s.id, "File an expense");
    s.advance(12_000);
    const paused = await s.rec.pause(s.id);
    expect(paused.state).toBe("PAUSED");
    expect(paused.elapsedMs).toBe(12_000);
    expect(s.wakes).toHaveLength(0);
    expect(() => s.rec.start(s.id, "something else")).toThrow("Another recording is in progress.");
    const resumed = s.rec.resume(s.id);
    expect(resumed.state).toBe("RECORDING");
    expect(s.spawned).toHaveLength(2);
    expect(s.spawned[1]!.args.at(-1)).toMatch(/demo-2\.mp4$/);
    s.advance(8_000);
    expect(s.rec.status().elapsedMs).toBe(20_000);
  });

  it("stop from paused finalizes what was already captured, without recording more", async () => {
    const s = setup();
    const st = s.rec.start(s.id, "File an expense");
    await s.rec.pause(s.id);
    const done = await s.rec.stop(s.id);
    expect(done.state).toBe("ANALYZING");
    expect(s.spawned).toHaveLength(1);
    expect(s.wakes).toHaveLength(1);
    expect(fs.existsSync(path.join(s.cfg.workspace, ".host-out", "teach", st.sessionId!))).toBe(true);
  });

  it("restores an interrupted session as paused so closing the app does not lose it", () => {
    const s = setup();
    const sessionId = "teach-20260918-171200-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const dir = path.join(s.cfg.hostPrivate, "teach-sessions", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "demo.mp4"), "mp4");
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({
      goal: "File an expense", startedAtMs: 1, display: ":3", viewport: [1280, 800], cdpPort: 9223,
      botId: s.id, capturedMs: 45_000, state: "RECORDING", segments: ["demo.mp4"],
    }));
    const st = s.rec.restoreInterrupted();
    expect(st).toMatchObject({ state: "PAUSED", botId: s.id, sessionId, goal: "File an expense", elapsedMs: 45_000 });
    expect(s.spawned).toHaveLength(0);
    expect(() => s.rec.start(s.id, "something else")).toThrow("Another recording is in progress.");
  });

  it("pauses once the last viewer has been gone for the debounce, and a blip does not", async () => {
    const s = setup();
    s.rec.start(s.id, "goal");
    s.rec.noteViewers(1);
    s.rec.noteViewers(0);
    expect(s.rec.status().state).toBe("RECORDING");
    const orphan = s.timers.find((t) => t.ms === 3_000);
    expect(orphan, "closing the app schedules a short pause, not an immediate one").toBeTruthy();
    s.rec.noteViewers(1);
    await orphan!.fn();
    expect(s.rec.status().state, "a reconnect before the debounce must keep recording").toBe("RECORDING");
    s.rec.noteViewers(0);
    const again = s.timers.filter((t) => t.ms === 3_000).at(-1)!;
    await again.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.rec.status().state).toBe("PAUSED");
  });
});

/**
 * Bug 47 — "a session claims a sidecar it never had."
 *
 * `phase4.ts` builds the sidecar handle around an async `started` promise and returns the handle
 * synchronously; a failed start was only `log.warn`ed. `writeSession` recorded `s.sidecar ? 1 : 0`,
 * so the record said "this recording has an event sidecar" whether or not one ever ran. Evidence,
 * from the first real recording this repo produced: `{ffmpeg.log, ffmpeg.pid, session.json}` with
 * `"sidecarVersion": 1` and no `events.jsonl` — spawnXInput cannot work with no X server.
 *
 * The fixture is phase4's shape exactly (handle now, outcome later), so the guard fails again if
 * that shape comes back with nothing reporting the outcome.
 */
describe("session.json records the sidecar that actually started (bug 47)", () => {
  const phase4Handle = (startSidecar: () => Promise<{ stop(): Promise<void> }>) => {
    const started = (async () => startSidecar())();
    const ok = started.then(() => true, () => false); // phase4's log.warn, minus the log
    return { stop: async () => { await (await started.catch(() => null))?.stop(); }, started: () => ok };
  };

  it("a sidecar whose start fails is recorded as absent, not as version 1", async () => {
    const s = setup({ sidecar: () => phase4Handle(async () => { throw new Error("xinput: no X server"); }) });
    s.rec.start(s.id, "File an expense");
    const done = await s.rec.stop(s.id);
    const session = JSON.parse(fs.readFileSync(path.join(done.sessionDir!, "session.json"), "utf8")) as { sidecarVersion: number };
    expect(session.sidecarVersion, "the published session claimed an event sidecar that never ran").toBe(0);
    expect(fs.existsSync(path.join(done.sessionDir!, "events.jsonl")), "the fixture is only honest if the sidecar really wrote nothing").toBe(false);
  });

  it("a sidecar that does start is still recorded as version 1", async () => {
    let stopped = 0;
    const s = setup({ sidecar: () => phase4Handle(async () => ({ stop: async () => { stopped++; } })) });
    s.rec.start(s.id, "File an expense");
    const done = await s.rec.stop(s.id);
    expect((JSON.parse(fs.readFileSync(path.join(done.sessionDir!, "session.json"), "utf8")) as { sidecarVersion: number }).sidecarVersion).toBe(1);
    expect(stopped, "the handle is still the thing that stops the sidecar").toBe(1);
  });

  it("while recording, the user is told clicks and typing are not being captured — not only the log (bug 47's warn)", async () => {
    const s = setup({ sidecar: () => phase4Handle(async () => { throw new Error("xinput: no X server"); }) });
    const first = s.rec.start(s.id, "File an expense");
    expect(first.videoOnly ?? false, "must not fire before the sidecar has reported anything").toBe(false);
    await new Promise((r) => setImmediate(r));
    const live = s.events.filter((e) => e.channel === "teach-recording").at(-1)?.payload as TeachStatus | undefined;
    expect(live?.state).toBe("RECORDING");
    expect(live?.videoOnly, "the recording bar keeps saying the Bot is watching and taking notes while only video is captured").toBe(true);
    expect(s.rec.status().videoOnly).toBe(true);
  });

  it("a sidecar that starts, or one switched off by choice, never raises the video-only notice (must not fire)", async () => {
    for (const sidecar of [() => phase4Handle(async () => ({ stop: async () => {} })), () => null]) {
      const s = setup({ sidecar });
      s.rec.start(s.id, "File an expense");
      await new Promise((r) => setImmediate(r));
      expect(s.rec.status().videoOnly ?? false).toBe(false);
      expect(s.events.some((e) => e.channel === "teach-recording" && (e.payload as TeachStatus).videoOnly)).toBe(false);
    }
  });

  it("video-only by choice (Advanced: teach sidecar off) is recorded as absent too", async () => {
    const s = setup({ sidecar: () => null });
    s.rec.start(s.id, "File an expense");
    const done = await s.rec.stop(s.id);
    expect((JSON.parse(fs.readFileSync(path.join(done.sessionDir!, "session.json"), "utf8")) as { sidecarVersion: number }).sidecarVersion).toBe(0);
  });
});
