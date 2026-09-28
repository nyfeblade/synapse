import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITS, STR, type TeachState, type TeachStatus } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { SseHub } from "../gateway/sse-hub";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { collectHiddenTurn } from "../runner/prompt-collector";
import type { TurnRunner } from "../runner/turn-runner";
import { writeJsonAtomic } from "../util/atomic-json";
import { removeBoxPath } from "../util/box-file";
import { hostOutDir, teachWorkDir } from "../util/host-out";
import { chainIntact, ensureHostOwnedDir, removeHostOwnedPath } from "../util/host-owned-file";
import { log } from "../util/log";
import { appendQueueEntry, removeBotEntries } from "./queue";

/**
 * Bug 47: the handle is built synchronously around an asynchronous start (phase4.ts), so holding one
 * proves nothing about whether a sidecar is running. `started()` is how the handle reports its own
 * outcome — it resolves false when the start failed, and never rejects.
 */
export interface SidecarHandle { stop(): Promise<void>; started(): Promise<boolean> }
export interface ChildLike {
  pid?: number;
  stdin: NodeJS.WritableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(ev: "exit", cb: (code: number | null) => void): unknown;
  kill(sig?: NodeJS.Signals | number): boolean;
}
export type SpawnLike = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildLike;

export interface RecorderDeps {
  cfg: HostConfig;
  bots: BotService;
  runner: Pick<TurnRunner, "enqueueWake">;
  hub: SseHub;
  displayOf(botId: string): string | null;
  /** DISPLAY + XAUTHORITY for the Bot's screen (Phase 3 display manager); defaults to DISPLAY only. */
  displayEnv?(botId: string, display: string): Record<string, string>;
  cdpPortOf?(botId: string): number | null;
  now?(): number;
  spawn?: SpawnLike;
  sidecar?: (s: { botId: string; sessionDir: string; display: string; startedAtMs: number; cdpPort: number | null }) => SidecarHandle | null;
  afterFinalize?(s: { botId: string; sessionDir: string }): Promise<void>;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

/** TCH-03 capture, byte-for-byte: 1280×800, 15 fps, libx264 ultrafast, -g 75, no audio, 600 s. */
export function ffmpegArgs(display: string, outFile: string): string[] {
  // I8: the output is forced to a local mp4 file (no other protocol, no format guessed from the name).
  return ["-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "15", "-i", display, "-c:v", "libx264", "-preset", "ultrafast", "-g", "75", "-an", "-t", "600", "-protocol_whitelist", "file", "-f", "mp4", outFile];
}

/** Join paused segments after resume. Same output lock as capture. */
export function concatArgs(listFile: string, outFile: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-protocol_whitelist", "file", "-f", "mp4", outFile];
}

/** x11grab stamps its input with wall-clock seconds: "start: 1789751520.250000". */
export function parseVideoStartMs(ffmpegLog: string): number | null {
  const m = /start: (\d+\.\d+)/.exec(ffmpegLog);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** ORIG-08 §08.3 state machine; DISCARDED is reachable from every state before ACCEPTED. */
export const ALLOWED: Record<TeachState, TeachState[]> = {
  IDLE: ["RECORDING", "PAUSED"],
  RECORDING: ["FINALIZING", "DISCARDED", "PAUSED"],
  PAUSED: ["RECORDING", "FINALIZING", "DISCARDED"],
  FINALIZING: ["ANALYZING", "DISCARDED"],
  ANALYZING: ["DRAFTED", "DISCARDED"],
  DRAFTED: ["REHEARSING", "ACCEPTED", "DISCARDED"],
  REHEARSING: ["TESTED", "NEEDS_FIX", "DISCARDED"],
  NEEDS_FIX: ["DRAFTED", "DISCARDED"],
  TESTED: ["REHEARSING", "ACCEPTED", "DISCARDED"],
  ACCEPTED: ["IDLE", "RECORDING"],
  DISCARDED: ["IDLE", "RECORDING"],
};

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

interface Session {
  botId: string; sessionId: string; sessionDir: string; goal: string; display: string; cdpPort: number | null;
  startedAtMs: number; child: ChildLike | null; exited: Promise<void>; log: fs.WriteStream; logHead: string;
  sidecar: SidecarHandle | null; timer: unknown;
  /** Bug 47: what the sidecar reported, not whether a handle exists. False until it says otherwise. */
  sidecarStarted: boolean;
  /** The sidecar was asked for and reported that it failed: the recording bar says video only. */
  sidecarFailed?: boolean;
  videoStartPtsMs: number | null;
  capturedMs: number;
  segmentStartedAtMs: number;
  segments: string[];
}

export class TeachRecorder {
  private state: TeachState = "IDLE";
  private s: Session | null = null;
  private now: () => number;
  private viewers = 0;
  private orphanTimer: unknown = null;

  constructor(private d: RecorderDeps) {
    this.now = d.now ?? Date.now;
  }

  status(): TeachStatus {
    const s = this.s;
    return {
      state: this.state, botId: s?.botId ?? null, sessionId: s?.sessionId ?? null, sessionDir: s?.sessionDir ?? null,
      startedAtMs: s?.startedAtMs ?? null, elapsedMs: this.elapsedMs(), goal: s?.goal ?? null,
      ...(s?.sidecarFailed ? { videoOnly: true } : {}),
    };
  }

  /**
   * Bug 47's warn, the user's half: the sidecar's start is asynchronous and used to fail into
   * `log.warn` only, while the recording bar went on saying the Bot was watching and taking notes. When
   * the handle reports failure, the live status says so and is republished to the bar.
   */
  private watchSidecar(s: Session): void {
    const h = s.sidecar;
    if (!h) return;
    void h.started().then((ok) => {
      if (ok || s.sidecar !== h) return;
      s.sidecarFailed = true;
      if (this.s === s && (this.state === "RECORDING" || this.state === "PAUSED")) this.d.hub.publish({ channel: "teach-recording", payload: this.status() });
    });
  }

  private elapsedMs(): number {
    const s = this.s;
    if (!s) return 0;
    if (this.state === "RECORDING") return s.capturedMs + (this.now() - s.segmentStartedAtMs);
    if (this.state === "PAUSED") return s.capturedMs;
    return 0;
  }

  current(): { botId: string; sessionId: string; sessionDir: string; goal: string } | null {
    return this.s ? { botId: this.s.botId, sessionId: this.s.sessionId, sessionDir: this.s.sessionDir, goal: this.s.goal } : null;
  }

  setState(next: TeachState): void {
    if (!ALLOWED[this.state].includes(next)) throw new GatewayError("TEACH_STATE", `Teach a task can't go ${this.state} → ${next}.`, 409);
    this.state = next;
    this.d.hub.publish({ channel: "teach-recording", payload: this.status() });
  }

  start(botId: string, goal: string): TeachStatus {
    // Only IDLE, ACCEPTED and DISCARDED list RECORDING as an allowed next state (see ALLOWED).
    // Any other current state means a prior session is mid-review; refuse rather than silently
    // resetting to IDLE and orphaning it.
    if (this.state !== "IDLE" && this.state !== "ACCEPTED" && this.state !== "DISCARDED") {
      throw new GatewayError("TEACH_BUSY", "Another recording is in progress.", 409);
    }
    const bot = this.d.bots.summary(botId);
    if (bot.group) throw new GatewayError("TEACH_GROUP", "Teach a task works only in a one-to-one chat.", 409);
    const display = this.d.displayOf(botId);
    if (!display) throw new GatewayError("TEACH_NO_SCREEN", "Teach a task needs the Bot's own screen.", 409);
    const g = goal.trim();
    if (!g) throw new GatewayError("TEACH_GOAL", "Describe the result you want first.");
    const startedAtMs = this.now();
    const sessionId = `teach-${stamp(startedAtMs)}-${randomUUID()}`;
    // I8: record under hostPrivate (host-owned, never a Bot-planted link) until the files are scrubbed; stop() publishes.
    const privateRoot = path.join(this.d.cfg.hostPrivate, "teach-sessions");
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(privateRoot).isSymbolicLink()) throw new GatewayError("TEACH_PATH", "The recording folder is not usable.", 500);
    const sessionDir = path.join(privateRoot, sessionId);
    fs.mkdirSync(sessionDir, { mode: 0o755 });
    const cdpPort = this.d.cdpPortOf?.(botId) ?? null;
    const spawn: SpawnLike = this.d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ["pipe", "ignore", "pipe"] }));
    const child = spawn("ffmpeg", ffmpegArgs(display, path.join(sessionDir, "demo.mp4")), { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(this.d.displayEnv?.(botId, display) ?? {}), DISPLAY: display } });
    const logStream = fs.createWriteStream(path.join(sessionDir, "ffmpeg.log"));
    const session: Session = {
      botId, sessionId, sessionDir, goal: g, display, cdpPort, startedAtMs, child, log: logStream, logHead: "", sidecar: null, timer: null,
      sidecarStarted: false, videoStartPtsMs: null, capturedMs: 0, segmentStartedAtMs: startedAtMs, segments: ["demo.mp4"],
      exited: new Promise<void>((resolve) => child.once("exit", () => resolve())),
    };
    child.stderr?.on("data", (b: Buffer) => {
      logStream.write(b);
      if (session.logHead.length < 65_536) session.logHead += b.toString();
    });
    fs.writeFileSync(path.join(sessionDir, "ffmpeg.pid"), String(child.pid ?? ""));
    session.sidecar = this.d.sidecar?.({ botId, sessionDir, display, startedAtMs, cdpPort }) ?? null;
    // Bug 47: the sidecar's start is asynchronous, so at this point nothing has reported starting and
    // the partial record says so. stop() asks the handle for its outcome before the final write.
    this.writeSession(session);
    session.timer = (this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      void this.stop(botId).catch((e) => log.warn("teach auto-stop failed", { error: String(e) }));
    }, LIMITS.teachAutoStopMs);
    this.s = session;
    this.watchSidecar(session);
    this.setState("RECORDING");
    return this.status();
  }

  private writeSession(s: Session): void {
    writeJsonAtomic(path.join(s.sessionDir, "session.json"), {
      goal: s.goal, startedAtMs: s.startedAtMs, videoStartPtsMs: s.videoStartPtsMs, display: s.display, viewport: [1280, 800], cdpPort: s.cdpPort,
      sidecarVersion: s.sidecarStarted ? 1 : 0, // bug 47: what started, not what was asked for
      botId: s.botId, capturedMs: s.capturedMs, state: this.state === "IDLE" ? "RECORDING" : this.state, segments: s.segments,
    }, 0o644);
  }

  private async endCapture(s: Session, graceful: boolean): Promise<void> {
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(s.timer);
    if (s.child) {
      if (graceful) s.child.stdin?.write("q");
      else s.child.kill("SIGKILL");
      const timeout = new Promise<"t">((r) => setTimeout(() => r("t"), 5000).unref());
      if ((await Promise.race([s.exited.then(() => "x" as const), timeout])) === "t") s.child.kill("SIGINT");
      s.child = null;
    }
    await s.sidecar?.stop().catch((e) => log.warn("teach sidecar stop failed", { error: String(e) }));
    await new Promise<void>((r) => s.log.end(() => r()));
  }

  /**
   * I8: move the scrubbed session from hostPrivate into the workspace (never through a link). Final secfix round 3
   * (ruling 4): the destination is /workspace/.host-out/teach/<id> — every directory from .host-out down is
   * bothost-owned (2750); the tree is locked down (dirs 2750, files 0640, the bots group of .host-out/teach) while it
   * is still in hostPrivate, so the Bot can read the recording but never change or swap it. The Bot's own outputs go
   * to its work folder /workspace/teach-sessions/<id> instead.
   */
  private publish(s: Session): string {
    const root = hostOutDir(this.d.cfg.workspace, "teach");
    const refuse = () => new GatewayError("TEACH_PATH", "The host output folder for recordings is not usable; not publishing the recording.", 409);
    const chain = ensureHostOwnedDir(this.d.cfg.workspace, root);
    if (!chain) throw refuse();
    lockDownTree(s.sessionDir, fs.lstatSync(root).gid);
    const dest = path.join(root, s.sessionId);
    try {
      fs.renameSync(s.sessionDir, dest); // fails onto a planted link or a non-empty folder
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(s.sessionDir, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      fs.rmSync(s.sessionDir, { recursive: true, force: true });
    }
    if (!chainIntact(chain)) throw refuse(); // .host-out was swapped mid-publish: the Bot is never pointed at it
    return dest;
  }

  async stop(botId: string): Promise<TeachStatus> {
    const s = this.s;
    if (!s || s.botId !== botId || (this.state !== "RECORDING" && this.state !== "PAUSED")) {
      throw new GatewayError("TEACH_NOT_RECORDING", "No recording is running for this Bot.", 409);
    }
    if (this.state === "RECORDING") s.capturedMs += this.now() - s.segmentStartedAtMs;
    this.setState("FINALIZING");
    await this.endCapture(s, true);
    await this.concatSegments(s);
    // Bug 47: ask the sidecar what actually happened — by now its start has settled either way —
    // before writing the record the analyzer reads.
    s.sidecarStarted = s.sidecar ? await s.sidecar.started() : false;
    const started = parseVideoStartMs(s.logHead);
    s.videoStartPtsMs = started === null ? null : started - s.startedAtMs;
    this.writeSession(s);
    await this.d.afterFinalize?.({ botId, sessionDir: s.sessionDir });
    s.sessionDir = this.publish(s); // I8: only scrubbed files reach the workspace
    appendQueueEntry({
      keyFile: path.join(this.d.cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(this.d.cfg.hostPrivate, "teach-queue.jsonl"),
      entry: { sessionId: s.sessionId, botId, sessionDir: s.sessionDir, createdAt: this.now() },
    });
    this.setState("ANALYZING");
    const text = fillTemplate(loadPrompt("wakes/teach-finished.md"), { FINISHED: STR.teachFinishedWake, SESSION_DIR: s.sessionDir, WORK_DIR: teachWorkDir(this.d.cfg.workspace, s.sessionId), GOAL: s.goal, SESSION_ID: s.sessionId });
    this.d.runner.enqueueWake(botId, { source: "teach", lane: "user", silenceAllowed: false, prompt: () => collectHiddenTurn(text) });
    return this.status();
  }

  async pause(botId: string): Promise<TeachStatus> {
    const s = this.s;
    if (!s || s.botId !== botId || this.state !== "RECORDING") throw new GatewayError("TEACH_NOT_RECORDING", "No recording is running for this Bot.", 409);
    this.clearOrphan();
    s.capturedMs += this.now() - s.segmentStartedAtMs;
    await this.endCapture(s, true);
    this.writeSession(s);
    this.setState("PAUSED");
    return this.status();
  }

  resume(botId: string): TeachStatus {
    const s = this.s;
    if (!s || s.botId !== botId || this.state !== "PAUSED") throw new GatewayError("TEACH_NOT_PAUSED", "No paused recording to continue.", 409);
    const display = this.d.displayOf(botId);
    if (!display) throw new GatewayError("TEACH_NO_SCREEN", "Teach a task needs the Bot's own screen.", 409);
    s.display = display;
    s.cdpPort = this.d.cdpPortOf?.(botId) ?? s.cdpPort;
    const fileName = `demo-${s.segments.length + 1}.mp4`;
    s.segments.push(fileName);
    this.beginSegment(s, fileName);
    this.writeSession(s);
    this.setState("RECORDING");
    return this.status();
  }

  /**
   * A leftover session from a host restart (or an app close that killed ffmpeg) comes back paused,
   * never still-recording: there is no live capture to inherit.
   */
  restoreInterrupted(): TeachStatus {
    if (this.state !== "IDLE" || this.s) return this.status();
    const root = path.join(this.d.cfg.hostPrivate, "teach-sessions");
    if (!fs.existsSync(root)) return this.status();
    let best: { dir: string; rec: RestoredRecord; sessionId: string } | null = null;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const rec = readRestored(path.join(dir, "session.json"));
      if (!rec?.botId || !rec.goal) continue;
      const segs = rec.segments ?? ["demo.mp4"];
      if (!segs.some((n) => fs.existsSync(path.join(dir, n)))) continue;
      try { this.d.bots.summary(rec.botId); } catch { continue; }
      if (!best || rec.startedAtMs > best.rec.startedAtMs) best = { dir, rec, sessionId: name };
    }
    if (!best) return this.status();
    killPidFile(path.join(best.dir, "ffmpeg.pid"));
    const rec = best.rec;
    const log = fs.createWriteStream(path.join(best.dir, "ffmpeg.log"), { flags: "a" });
    this.s = {
      botId: rec.botId, sessionId: best.sessionId, sessionDir: best.dir, goal: rec.goal, display: rec.display,
      cdpPort: rec.cdpPort, startedAtMs: rec.startedAtMs, child: null, exited: Promise.resolve(), log, logHead: "",
      sidecar: null, timer: null, sidecarStarted: rec.sidecarVersion === 1, videoStartPtsMs: rec.videoStartPtsMs,
      capturedMs: rec.capturedMs, segmentStartedAtMs: rec.startedAtMs, segments: rec.segments ?? ["demo.mp4"],
    };
    this.setState("PAUSED");
    return this.status();
  }

  /** Last SSE client gone → pause after a short debounce so a reconnect blip does not cut the tape. */
  noteViewers(n: number): void {
    this.viewers = n;
    this.clearOrphan();
    if (n === 0 && this.state === "RECORDING" && this.s) {
      const botId = this.s.botId;
      this.orphanTimer = (this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        this.orphanTimer = null;
        if (this.viewers === 0 && this.state === "RECORDING" && this.s) {
          void this.pause(botId).catch((e) => log.warn("teach pause after viewer gone failed", { error: String(e) }));
        }
      }, LIMITS.teachViewerGoneMs);
    }
  }

  private clearOrphan(): void {
    if (this.orphanTimer !== null) {
      (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  private beginSegment(s: Session, fileName: string): void {
    const spawn: SpawnLike = this.d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ["pipe", "ignore", "pipe"] }));
    const child = spawn("ffmpeg", ffmpegArgs(s.display, path.join(s.sessionDir, fileName)), {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(this.d.displayEnv?.(s.botId, s.display) ?? {}), DISPLAY: s.display },
    });
    s.child = child;
    s.log = fs.createWriteStream(path.join(s.sessionDir, "ffmpeg.log"), { flags: "a" });
    s.exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stderr?.on("data", (b: Buffer) => {
      s.log.write(b);
      if (s.logHead.length < 65_536) s.logHead += b.toString();
    });
    fs.writeFileSync(path.join(s.sessionDir, "ffmpeg.pid"), String(child.pid ?? ""));
    s.sidecar = this.d.sidecar?.({ botId: s.botId, sessionDir: s.sessionDir, display: s.display, startedAtMs: s.startedAtMs, cdpPort: s.cdpPort }) ?? null;
    s.sidecarStarted = false;
    s.sidecarFailed = false; // this segment's sidecar reports for itself
    this.watchSidecar(s);
    s.segmentStartedAtMs = this.now();
    const remain = Math.max(0, LIMITS.teachAutoStopMs - s.capturedMs);
    s.timer = (this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      void this.stop(s.botId).catch((e) => log.warn("teach auto-stop failed", { error: String(e) }));
    }, remain);
  }

  private async concatSegments(s: Session): Promise<void> {
    const files = s.segments.filter((n) => fs.existsSync(path.join(s.sessionDir, n)));
    if (files.length <= 1) return;
    const list = path.join(s.sessionDir, "concat.txt");
    const merged = path.join(s.sessionDir, "demo-merged.mp4");
    fs.writeFileSync(list, files.map((n) => `file '${path.join(s.sessionDir, n).replace(/'/g, "'\\''")}'`).join("\n"));
    const spawn: SpawnLike = this.d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ["pipe", "ignore", "pipe"] }));
    const child = spawn("ffmpeg", concatArgs(list, merged), { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.write("q");
    const timeout = new Promise<"t">((r) => setTimeout(() => r("t"), 15_000).unref());
    if ((await Promise.race([exited.then(() => "x" as const), timeout])) === "t") child.kill("SIGKILL");
    await exited.catch(() => {});
    if (fs.existsSync(merged)) {
      fs.renameSync(merged, path.join(s.sessionDir, "demo.mp4"));
      s.segments = ["demo.mp4"];
    }
  }

  /** I7: a deleted Bot's live session is killed and removed, and its recorded sessions and queue entries go too. */
  async forgetBot(botId: string): Promise<void> {
    const s = this.s;
    if (s && s.botId === botId) {
      if (this.state === "RECORDING" || this.state === "FINALIZING") await this.endCapture(s, false).catch(() => {});
      fs.rmSync(s.sessionDir, { recursive: true, force: true });
      this.s = null;
      this.state = "IDLE";
      this.d.hub.publish({ channel: "teach-recording", payload: this.status() });
    }
    // Final secfix round 3: host-owned recordings only through a host-owned chain; the Bot's work folder (and a
    // recording published by an older build) only when no link is on the way; hostPrivate as before.
    const ws = this.d.cfg.workspace;
    const hostOut = `${path.resolve(hostOutDir(ws, "teach"))}/`;
    const work = `${path.resolve(ws, "teach-sessions")}/`;
    const priv = `${path.resolve(this.d.cfg.hostPrivate, "teach-sessions")}/`;
    const removed = removeBotEntries({ keyFile: path.join(this.d.cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(this.d.cfg.hostPrivate, "teach-queue.jsonl"), botId });
    for (const e of removed) {
      const dir = path.resolve(e.sessionDir);
      if (dir.startsWith(hostOut)) { removeHostOwnedPath(ws, dir); removeBoxPath(ws, teachWorkDir(ws, path.basename(dir))); }
      else if (dir.startsWith(work)) removeBoxPath(ws, dir);
      else if (dir.startsWith(priv)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async discard(botId: string): Promise<TeachStatus> {
    const s = this.s;
    if (!s || s.botId !== botId || this.state === "ACCEPTED" || this.state === "IDLE" || this.state === "DISCARDED") {
      throw new GatewayError("TEACH_NOTHING", "There is no recording to discard.", 409);
    }
    await this.endCapture(s, false);
    fs.rmSync(s.sessionDir, { recursive: true, force: true });
    this.setState("DISCARDED");
    return this.status();
  }
}

export function teachHandlers(r: TeachRecorder): Pick<CommandHandlers, "startTeachRecording" | "stopTeachRecording" | "pauseTeachRecording" | "resumeTeachRecording" | "discardTeachRecording" | "getTeachRecordingStatus"> {
  return {
    startTeachRecording: (a) => ({ status: r.start(a.id, a.goal) }),
    stopTeachRecording: async (a) => ({ status: await r.stop(a.id) }),
    pauseTeachRecording: async (a) => ({ status: await r.pause(a.id) }),
    resumeTeachRecording: (a) => ({ status: r.resume(a.id) }),
    discardTeachRecording: async (a) => ({ status: await r.discard(a.id) }),
    getTeachRecordingStatus: () => ({ status: r.status() }),
  };
}

/**
 * Final secfix round 3 (ruling 4): before a recording leaves hostPrivate, every directory becomes 2750 and every file
 * 0640, all in `gid` (the bots group of .host-out/teach), so box reads it through the group and nothing else. A
 * link (never created by the host) is dropped rather than published.
 */
interface RestoredRecord {
  goal: string; startedAtMs: number; display: string; botId: string; capturedMs: number;
  cdpPort: number | null; videoStartPtsMs: number | null; sidecarVersion: number; segments?: string[];
}

function readRestored(file: string): RestoredRecord | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RestoredRecord>;
    if (typeof o.goal !== "string" || typeof o.startedAtMs !== "number" || typeof o.display !== "string" || typeof o.botId !== "string") return null;
    return {
      goal: o.goal, startedAtMs: o.startedAtMs, display: o.display, botId: o.botId,
      capturedMs: typeof o.capturedMs === "number" ? o.capturedMs : 0,
      cdpPort: typeof o.cdpPort === "number" ? o.cdpPort : null,
      videoStartPtsMs: typeof o.videoStartPtsMs === "number" ? o.videoStartPtsMs : null,
      sidecarVersion: o.sidecarVersion === 1 ? 1 : 0,
      segments: Array.isArray(o.segments) ? o.segments.filter((n): n is string => typeof n === "string") : undefined,
    };
  } catch {
    return null;
  }
}

function killPidFile(file: string): void {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    if (pid > 0) process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

function lockDownTree(dir: string, gid: number): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const walk = (p: string): void => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { fs.unlinkSync(p); return; }
    if (uid >= 0 && st.gid !== gid) fs.lchownSync(p, uid, gid);
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o2750);
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else fs.chmodSync(p, 0o640);
  };
  walk(dir);
}
