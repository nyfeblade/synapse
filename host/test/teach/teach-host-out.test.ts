import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { TeachState } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { newSlot } from "../../runner/turn-slot";
import type { WakeSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { teachAnalyzeProvider } from "../../teach/analyze";
import { appendQueueEntry } from "../../teach/queue";
import { TeachRecorder, type ChildLike } from "../../teach/recorder";
import { teachReviewProvider } from "../../teach/rehearsal";
import { tmpConfig } from "../helpers";

// Final secfix round 3, ruling 4: a finished Teach recording is published to /workspace/.host-out/teach/<id>
// (bothost-owned 2750 dirs, 0640 files: the Bot reads it, can't change or swap it). What the Bot writes itself
// (trace.json, rehearsal.json) goes to its own work folder /workspace/teach-sessions/<id>, which the host only reads
// (never through a link).
class FakeChild extends EventEmitter implements ChildLike {
  pid = 1;
  stdin = new PassThrough();
  stderr = new PassThrough();
  constructor() { super(); this.stdin.on("data", () => setTimeout(() => this.emit("exit", 0), 5)); }
  kill() { setTimeout(() => this.emit("exit", null), 5); return true; }
}

function recorderSetup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  fs.mkdirSync(cfg.workspace, { recursive: true });
  const hub = new SseHub();
  const bots = new BotService({ cfg, hub, settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const wakes: WakeSpec[] = [];
  const rec = new TeachRecorder({
    cfg, bots, hub, now: () => Date.UTC(2026, 8, 19, 12, 0, 0),
    runner: { enqueueWake: (_b: string, w: WakeSpec) => { wakes.push(w); return "task"; } },
    displayOf: () => ":3", cdpPortOf: () => null,
    spawn: () => new FakeChild(), setTimer: () => 1, clearTimer: () => {},
  });
  return { cfg, id, rec, wakes };
}

function modes(dir: string): { dirs: number[]; files: number[] } {
  const out = { dirs: [fs.statSync(dir).mode & 0o777] as number[], files: [] as number[] };
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    if (e.isDirectory()) out.dirs.push(fs.statSync(p).mode & 0o777);
    else out.files.push(fs.lstatSync(p).mode & 0o777);
  }
  return out;
}

describe("secfix3 ruling 4: Teach recordings publish to /workspace/.host-out/teach", () => {
  it("stop publishes under .host-out/teach/<id> with 0750 dirs and 0640 files, and the wake names the Bot's work folder", async () => {
    const s = recorderSetup();
    const st = s.rec.start(s.id, "File an expense");
    const done = await s.rec.stop(s.id);
    expect(done.sessionDir).toBe(path.join(s.cfg.workspace, ".host-out", "teach", st.sessionId!));
    const m = modes(done.sessionDir!);
    expect(new Set(m.dirs)).toEqual(new Set([0o750]));
    expect(m.files.length).toBeGreaterThan(0);
    expect(new Set(m.files)).toEqual(new Set([0o640]));
    const text = s.wakes[0]!.prompt().map((x) => (x as { text: string }).text).join("\n");
    expect(text).toContain(done.sessionDir!);
    expect(text).toContain(path.join(s.cfg.workspace, "teach-sessions", st.sessionId!));
    expect(fs.existsSync(path.join(s.cfg.workspace, "teach-sessions", st.sessionId!, "session.json"))).toBe(false);
  });

  it("refuses to publish when .host-out/teach is a box-planted link", async () => {
    const s = recorderSetup();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "teach-elsewhere-"));
    fs.mkdirSync(path.join(s.cfg.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(s.cfg.workspace, ".host-out", "teach"));
    s.rec.start(s.id, "goal");
    await expect(s.rec.stop(s.id)).rejects.toThrow(/not publishing/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe("secfix3 ruling 4: TeachAnalyze and TeachReview", () => {
  const EVENTS = [{ t: 0, type: "nav", url: "https://x.example/", title: "X", tabId: "T1" }];

  function analyzeSetup() {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    const sid = "teach-20260919-120000-abc";
    const dir = path.join(cfg.workspace, ".host-out", "teach", sid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ goal: "g", startedAtMs: 1, videoStartPtsMs: 0, sidecarVersion: 1 }));
    fs.writeFileSync(path.join(dir, "events.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n");
    appendQueueEntry({ keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl"), entry: { sessionId: sid, botId: "bot-1", sessionDir: dir, createdAt: 1 } });
    const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "teach", hidden: true, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
    const outDirs: string[] = [];
    const tool = teachAnalyzeProvider({
      cfg,
      extractFrames: async (_v, picks, outDir) => {
        outDirs.push(outDir);
        fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
        const files = picks.length ? picks.map((p) => path.join(outDir, p.file)) : [path.join(outDir, "frames", "f0001.jpg")];
        for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "JPG"); }
        return files;
      },
    })("bot-1", () => slot)[0]!;
    return { cfg, sid, dir, tool, outDirs };
  }

  it("TeachAnalyze extracts in host-private scratch and publishes analysis.json and frames 0640 into the host-owned folder; trace.json goes to the work folder", async () => {
    const a = analyzeSetup();
    const r = await a.tool.handler({ session: a.sid });
    expect(r.isError).toBeUndefined();
    expect(a.outDirs.every((d) => d.startsWith(`${a.cfg.hostPrivate}/`))).toBe(true);
    expect(fs.statSync(path.join(a.dir, "analysis.json")).mode & 0o777).toBe(0o640);
    const frames = fs.readdirSync(path.join(a.dir, "frames"));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(fs.statSync(path.join(a.dir, "frames", f)).mode & 0o777).toBe(0o640);
    expect(r.text).toContain(path.join(a.cfg.workspace, "teach-sessions", a.sid, "trace.json"));
    // a second analysis replaces the first
    expect((await a.tool.handler({ session: a.sid })).isError).toBeUndefined();
  });

  it("TeachReview reads rehearsal.json from the work folder, and never through a link", async () => {
    const cfg = tmpConfig({ BRAIN: "fake" });
    const sid = "teach-1";
    const dir = path.join(cfg.workspace, ".host-out", "teach", sid);
    fs.mkdirSync(dir, { recursive: true });
    const work = path.join(cfg.workspace, "teach-sessions", sid);
    fs.mkdirSync(work, { recursive: true });
    const skillPath = path.join(cfg.claudeConfigDir, "skills", "x", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, `---\nname: X\ndescription: Use this when testing.\nmetadata:\n  teachSession: teach-1\n  status: draft\n---\n## When to use\nt\n\n## Inputs and access\nt\n\n## Steps\nt\n\n## Decision points\nt\n\n## Validation\nt\n\n## Output\nt\n\n## Approval points\nnone\n\n## Failure handling\nIf a site blocks you, use request_box_help.\n`);
    let state: TeachState = "ANALYZING";
    const recorder = {
      current: () => ({ botId: "bot-1", sessionId: sid, sessionDir: dir, goal: "g" }),
      setState: (x: TeachState) => { state = x; },
      status: () => ({ state, botId: "bot-1", sessionId: sid, sessionDir: dir, startedAtMs: 1, elapsedMs: 0, goal: "g" }),
    };
    const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
    const tool = teachReviewProvider({ cfg, recorder, write: () => {} })("bot-1", () => slot)[0]!;
    // a link planted in the work folder is never read
    const secret = path.join(cfg.hostPrivate, "secret.json");
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(secret, JSON.stringify({ steps: [{ n: 1, status: "ok", note: "HOST-SECRET" }] }));
    fs.symlinkSync(secret, path.join(work, "rehearsal.json"));
    const bad = await tool.handler({ session: sid, skill_path: skillPath, action: "rehearsed" });
    expect(bad.isError).toBe(true);
    expect(state).toBe("ANALYZING");
    fs.unlinkSync(path.join(work, "rehearsal.json"));
    fs.writeFileSync(path.join(work, "rehearsal.json"), JSON.stringify({ steps: [{ n: 1, status: "ok", observedUrl: "u", note: "" }] }));
    const good = await tool.handler({ session: sid, skill_path: skillPath, action: "rehearsed" });
    expect(good.isError).toBeFalsy();
    expect(good.text).toMatch(/Rehearsal passed/);
    expect(fs.existsSync(path.join(work, "rehearsal.json"))).toBe(false);
  });
});
