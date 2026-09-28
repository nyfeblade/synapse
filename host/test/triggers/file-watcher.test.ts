import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineDef } from "@synapse/shared";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { SchedulerDb } from "../../routines/scheduler-db";
import { EventQueue } from "../../triggers/event-queue";
import { FileTriggerWatcher, baseDir, fileEventLine, type FSWatcherLike, type WatchFactory } from "../../triggers/file-watcher";
import type { TriggerEvent } from "../../triggers/types";

type Cb = (p: string, st?: { size: number; mtimeMs: number }) => void;
function fakeWatch() {
  const opened: { paths: string[]; handlers: Record<string, Cb>; closed: boolean; ignored: (p: string) => boolean }[] = [];
  const watch: WatchFactory = (paths, opts) => {
    const w = { paths, handlers: {} as Record<string, Cb>, closed: false, ignored: opts.ignored };
    opened.push(w);
    const api: FSWatcherLike = { on: (e, cb) => { w.handlers[e] = cb; return api; }, close: async () => { w.closed = true; } };
    return api;
  };
  return { watch, opened };
}
const rec = (def: Partial<RoutineDef>, id = "inbox", hash = "h1"): RoutineRecord => ({
  botId: "b1", id, defHash: hash, def: { name: "Inbox", prompt: "p", trigger: { file: { paths: ["inbox"], events: ["created", "modified"] } }, enabled: true, createdAt: 0, ...def },
});

afterEach(() => vi.useRealTimers());

describe("FileTriggerWatcher (ORIG-04 §04.4)", () => {
  it("watches the static base folder of each glob and turns fs events into file events", () => {
    const f = fakeWatch();
    const ingested: TriggerEvent[] = [];
    let recs = [rec({ trigger: { file: { paths: ["inbox", "/workspace/drop/*.pdf"], events: ["created"] } } })];
    const w = new FileTriggerWatcher({
      store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: (ev: TriggerEvent) => { ingested.push(ev); return []; } } as unknown as EventQueue,
      workspace: "/workspace", isRunActive: () => false, lastRunEndedAt: () => null, now: () => 5000, watch: f.watch,
    });
    w.sync();
    expect(f.opened[0]!.paths.sort()).toEqual(["/workspace/drop", "/workspace/inbox"]);
    expect(f.opened[0]!.ignored("/workspace/inbox/.git/HEAD")).toBe(true);
    expect(f.opened[0]!.ignored("/workspace/inbox/a.tmp")).toBe(true);
    f.opened[0]!.handlers.add!("/workspace/inbox/a.pdf", { size: 1234, mtimeMs: Date.UTC(2026, 8, 19, 10) });
    expect(ingested[0]).toMatchObject({ source: "file", kind: "created", path: "/workspace/inbox/a.pdf", occurredAt: 5000, raw: { event: "created", size: 1234 } });
    expect(ingested[0]!.text).toBe("created /workspace/inbox/a.pdf size=1234 mtime=2026-09-19T10:00:00.000Z");
    f.opened[0]!.handlers.add!("/workspace/inbox/a.pdf", { size: 1234, mtimeMs: Date.UTC(2026, 8, 19, 10) });
    expect(ingested[1]!.eventId).toBe(ingested[0]!.eventId);
    f.opened[0]!.handlers.unlink!("/workspace/inbox/a.pdf");
    expect(ingested[2]).toMatchObject({ kind: "deleted", raw: { size: 0 } });

    recs = [rec({ enabled: false })];
    w.sync();
    expect(f.opened[0]!.closed).toBe(true);
  });

  it("reopens a watcher when the definition changes and watches file listeners in a group", () => {
    const f = fakeWatch();
    let recs = [rec({})];
    const w = new FileTriggerWatcher({ store: { all: () => recs } as unknown as RoutineStore, queue: { ingest: () => [] } as unknown as EventQueue, workspace: "/workspace", isRunActive: () => false, lastRunEndedAt: () => null, now: () => 0, watch: f.watch });
    w.sync();
    recs = [rec({ trigger: { group: { listeners: [{ webhook: {} }, { file: { paths: ["out/**/*.csv"], events: ["created"] } }] } } }, "inbox", "h2")];
    w.sync();
    expect(f.opened).toHaveLength(2);
    expect(f.opened[0]!.closed).toBe(true);
    expect(f.opened[1]!.paths).toEqual(["/workspace/out"]);
  });

  it("suppresses events during the routine's own run and for 5 s after it ends", () => {
    const f = fakeWatch();
    const ingested: TriggerEvent[] = [];
    let active = true;
    let ended: number | null = null;
    let now = 100_000;
    const w = new FileTriggerWatcher({ store: { all: () => [rec({})] } as unknown as RoutineStore, queue: { ingest: (ev: TriggerEvent) => { ingested.push(ev); return []; } } as unknown as EventQueue, workspace: "/workspace", isRunActive: () => active, lastRunEndedAt: () => ended, now: () => now, watch: f.watch });
    w.sync();
    const add = f.opened[0]!.handlers.add!;
    add("/workspace/inbox/own-output.txt", { size: 1, mtimeMs: 1 });
    active = false;
    ended = now;
    now += 4999;
    add("/workspace/inbox/own-output-2.txt", { size: 1, mtimeMs: 2 });
    expect(ingested).toHaveLength(0);
    now += 2;
    add("/workspace/inbox/user-file.txt", { size: 1, mtimeMs: 3 });
    expect(ingested).toHaveLength(1);
  });

  it("100 files in 1 s become one wake with 25 events and the rest stay queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fakeWatch();
    const r = rec({ createdAt: 0 });
    const store = { all: () => [r], get: () => r } as unknown as RoutineStore;
    const db = { claimFire: () => true, setFireState: () => {}, dedupeSeen: () => false } as unknown as SchedulerDb;
    const submitted: FireRequest[] = [];
    const consumer = { submit: (q: FireRequest) => { submitted.push(q); return { accepted: true, runId: q.runId }; } } as unknown as FireConsumer;
    const queue = new EventQueue({ store, db, consumer, metrics: null, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout), workspace: "/workspace" });
    const w = new FileTriggerWatcher({ store, queue, workspace: "/workspace", isRunActive: () => false, lastRunEndedAt: () => null, now: () => Date.now(), watch: f.watch });
    w.sync();
    for (let i = 0; i < 100; i++) {
      f.opened[0]!.handlers.add!(`/workspace/inbox/f${i}.txt`, { size: i, mtimeMs: 1 });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(750);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.events).toHaveLength(25);
    expect(queue.pending("b1", "inbox")).toBe(75);
  });

  it("baseDir and fileEventLine", () => {
    expect(baseDir("inbox/*.pdf", "/workspace")).toBe("/workspace/inbox");
    expect(baseDir("/workspace/a/b/**/c.txt", "/workspace")).toBe("/workspace/a/b");
    expect(baseDir("reports", "/workspace")).toBe("/workspace/reports");
    expect(fileEventLine("modified", "/workspace/x", 0, 0)).toBe("modified /workspace/x size=0 mtime=1970-01-01T00:00:00.000Z");
  });
});

describe("FileTriggerWatcher with real chokidar (awaitWriteFinish)", () => {
  it("a file written over ~1 s produces exactly one event after the write settles", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    fs.mkdirSync(path.join(ws, "inbox"));
    const ingested: TriggerEvent[] = [];
    const r = rec({ trigger: { file: { paths: ["inbox"], events: ["created", "modified"] } } });
    const w = new FileTriggerWatcher({ store: { all: () => [r] } as unknown as RoutineStore, queue: { ingest: (ev: TriggerEvent) => { ingested.push(ev); return []; } } as unknown as EventQueue, workspace: ws, isRunActive: () => false, lastRunEndedAt: () => null, now: () => Date.now() });
    w.sync();
    await new Promise((res) => setTimeout(res, 300));
    const file = path.join(ws, "inbox", "big.bin");
    for (let i = 0; i < 5; i++) { fs.appendFileSync(file, Buffer.alloc(1024 * 1024, i)); await new Promise((res) => setTimeout(res, 200)); }
    await vi.waitFor(() => expect(ingested).toHaveLength(1), { timeout: 8000, interval: 100 });
    await new Promise((res) => setTimeout(res, 2500));
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({ kind: "created", raw: { size: 5 * 1024 * 1024 } });
    await w.close();
  }, 20_000);
});
