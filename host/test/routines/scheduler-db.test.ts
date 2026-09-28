import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SchedulerDb } from "../../routines/scheduler-db";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sched-")), "scheduler.db");
const claim = (runId: string, dedupeKey: string | null = runId) => ({ runId, botId: "b", routineId: "r", trigger: "schedule" as const, scheduledFor: 100, defHash: "h", eventJson: null, dedupeKey });

describe("SchedulerDb (ORIG-02 §02.1)", () => {
  it("creates exactly the spec schema in WAL mode", () => {
    const file = tmpFile();
    new SchedulerDb(file).close();
    const db = new DatabaseSync(file);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("schedule_index")).toEqual(["bot_id", "routine_id", "def_hash", "enabled", "kind", "tz", "next_run_at"]);
    expect(cols("fires")).toEqual(["run_id", "bot_id", "routine_id", "trigger", "scheduled_for", "def_hash", "state", "reason", "attempts", "event_json", "dedupe_key", "created_at", "updated_at"]);
    expect(cols("offline_skips")).toEqual(["bot_id", "routine_id", "count", "first_at", "last_at"]);
    expect(cols("meta")).toEqual(["k", "v"]);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
  });

  it("claims a run id once, and a dedupe key once", () => {
    const db = new SchedulerDb(":memory:");
    expect(db.claimFire(claim("a"), 1)).toBe(true);
    expect(db.claimFire(claim("a"), 2)).toBe(false);
    expect(db.claimFire({ ...claim("b", "a"), trigger: "event" }, 3)).toBe(false);
    expect(db.claimFire({ ...claim("c", null), trigger: "manual" }, 4)).toBe(true);
    expect(db.claimFire({ ...claim("d", null), trigger: "manual" }, 5)).toBe(true);
    expect(db.fire("a")).toMatchObject({ runId: "a", state: "claimed", attempts: 0, reason: null, createdAt: 1 });
  });

  it("tracks state, attempts, queries by state, dedupe windows, skips, meta and pruning", () => {
    const db = new SchedulerDb(":memory:");
    db.claimFire(claim("a"), 1_000);
    db.setFireState("a", "gated", null, 2_000);
    expect(db.fires({ states: ["gated", "queued"] }).map((f) => f.runId)).toEqual(["a"]);
    expect(db.bumpAttempts("a")).toBe(1);
    expect(db.dedupeSeen("a", 0)).toBe(true);
    expect(db.dedupeSeen("a", 5_000)).toBe(false);
    db.addOfflineSkip("b", "r", 10);
    db.addOfflineSkip("b", "r", 20);
    expect(db.offlineSkips("b")).toEqual([{ botId: "b", routineId: "r", count: 2, firstAt: 10, lastAt: 20 }]);
    db.clearOfflineSkips("b");
    expect(db.offlineSkips()).toEqual([]);
    db.setMeta("last_tick_at", "5");
    expect(db.meta("last_tick_at")).toBe("5");
    db.claimFire({ ...claim("ev", "github:1"), trigger: "event" }, 1_000);
    db.prune(1_000 + 25 * 3_600_000);
    expect(db.fire("ev")!.dedupeKey).toBeNull(); // event dedupe window is 24 h
    db.prune(1_000 + 31 * 86_400_000);
    expect(db.fire("a")).toBeNull(); // fires are kept 30 days
  });

  it("stores and replaces index rows", () => {
    const db = new SchedulerDb(":memory:");
    db.upsertIndex({ botId: "b", routineId: "r", defHash: "h", enabled: true, kind: "cron", tz: "UTC", nextRunAt: 10 });
    db.upsertIndex({ botId: "b", routineId: "r", defHash: "h2", enabled: false, kind: "cron", tz: "UTC", nextRunAt: null });
    expect(db.index()).toEqual([{ botId: "b", routineId: "r", defHash: "h2", enabled: false, kind: "cron", tz: "UTC", nextRunAt: null }]);
    db.deleteIndex("b");
    expect(db.index()).toEqual([]);
  });
});
