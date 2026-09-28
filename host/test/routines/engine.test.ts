import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb, type FireRow } from "../../routines/scheduler-db";
import { SchedulerEngine, eventRunId, jitterMs, planTick, scheduleRunId, uuidv5 } from "../../routines/engine";
import { botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 21, 6, 0, 0);

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const botId = randomUUID();
  fs.mkdirSync(botDir(cfg, botId), { recursive: true });
  const clock = { now: T0, mono: 0 };
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const claims: FireRow[] = [];
  const skipped: string[][] = [];
  const engine = new SchedulerEngine({
    db, store, botTz: () => "UTC", now: () => clock.now, mono: () => clock.mono,
    setTimer: () => 0, clearTimer: () => {}, onClaim: (f) => claims.push(f), onOfflineSkips: (ids) => skipped.push(ids),
  });
  return { botId, clock, store, db, engine, claims, skipped };
}

describe("run ids and jitter (ORIG-02 §02.2, §02.4)", () => {
  it("implements RFC 4122 UUIDv5", () => {
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
  it("derives schedule and event run ids deterministically", () => {
    expect(scheduleRunId("b", "r", 1)).toBe(scheduleRunId("b", "r", 1));
    expect(scheduleRunId("b", "r", 1)).not.toBe(scheduleRunId("b", "r", 2));
    expect(eventRunId("b", "r", "github", "d1")).not.toBe(eventRunId("b", "r", "github", "d2"));
    expect(scheduleRunId("b", "r", 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("jitter = fnv1a(routineId) mod 31 seconds", () => {
    expect(jitterMs("a")).toBe((0xe40c292c % 31) * 1000); // FNV-1a-32("a") = 0xe40c292c
    for (const id of ["morning", "x", "weekly-report"]) {
      expect(jitterMs(id)).toBe(jitterMs(id));
      expect(jitterMs(id) % 1000).toBe(0);
      expect(jitterMs(id)).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("planTick", () => {
  const row = { botId: "b", routineId: "r", defHash: "h", enabled: true, kind: "every" as const, tz: null, nextRunAt: T0 };
  const hourly = (_r: unknown, from: number) => T0 + (Math.floor((from - T0) / H) + 1) * H;
  it("claims a slot within the 60 s tolerance and advances past now", () => {
    const p = planTick({ rows: [row], now: T0 + 30_000, nextAfter: hourly });
    expect(p.claims).toEqual([{ row, slot: T0 }]);
    expect(p.skips).toEqual([]);
    expect(p.updated[0]!.nextRunAt).toBe(T0 + H);
  });
  it("skips every missed slot and never claims a late one (D5-A)", () => {
    const p = planTick({ rows: [row], now: T0 + 9 * H + 120_000, nextAfter: hourly });
    expect(p.claims).toEqual([]);
    expect(p.skips.map((s) => s.slot)).toEqual(Array.from({ length: 10 }, (_, i) => T0 + i * H));
    expect(p.updated[0]!.nextRunAt).toBe(T0 + 10 * H);
  });
  it("ignores disabled and unschedulable rows, and waits for the jittered fire time on cron rows", () => {
    expect(planTick({ rows: [{ ...row, enabled: false }], now: T0 + 1, nextAfter: hourly }).updated).toEqual([]);
    expect(planTick({ rows: [{ ...row, nextRunAt: null }], now: T0 + 1, nextAfter: hourly }).updated).toEqual([]);
    const cron = { ...row, kind: "cron" as const, routineId: "a" };
    const j = jitterMs("a");
    expect(planTick({ rows: [cron], now: T0 + j - 1, nextAfter: hourly }).claims).toEqual([]);
    expect(planTick({ rows: [cron], now: T0 + j, nextAfter: hourly }).claims).toHaveLength(1);
  });
});

describe("SchedulerEngine", () => {
  it("indexes routines at boot from now; saving never runs it (RTN-06)", () => {
    const s = setup();
    s.store.create(s.botId, { name: "Hourly", prompt: "p", schedule: "@every 60m", enabled: true });
    s.engine.boot();
    expect(s.engine.nextRunAt(s.botId, "hourly")).toBe(T0 + H);
    s.engine.tick();
    expect(s.claims).toEqual([]);
  });

  it("sleep simulation: +30 s fires, +3 min and +9 h skip with exact counts (ORIG-02 §02.9)", () => {
    const s = setup();
    s.store.create(s.botId, { name: "Hourly", prompt: "p", schedule: "@every 60m", enabled: true });
    s.engine.boot();
    s.clock.now = T0 + H + 30_000;
    s.engine.tick();
    expect(s.claims.map((c) => [c.trigger, c.scheduledFor, c.runId])).toEqual([["schedule", T0 + H, scheduleRunId(s.botId, "hourly", T0 + H)]]);
    s.clock.now = T0 + 2 * H + 180_000;
    s.engine.tick();
    expect(s.claims).toHaveLength(1);
    expect(s.db.offlineSkips(s.botId)[0]!.count).toBe(1);
    s.clock.now = T0 + 3 * H + 9 * H + 120_000;
    s.engine.tick();
    expect(s.claims).toHaveLength(1);
    expect(s.db.offlineSkips(s.botId)[0]!.count).toBe(11);
    expect(s.skipped).toEqual([[s.botId], [s.botId]]);
    expect(s.engine.nextRunAt(s.botId, "hourly")).toBe(T0 + 13 * H);
  });

  it("never fires a disabled routine, and reindexes on edit from now", () => {
    const s = setup();
    s.store.create(s.botId, { name: "Hourly", prompt: "p", schedule: "@every 60m", enabled: false });
    s.engine.boot();
    s.clock.now = T0 + 5 * H;
    s.engine.tick();
    expect(s.claims).toEqual([]);
    expect(s.engine.nextRunAt(s.botId, "hourly")).toBeNull();
    s.store.update(s.botId, "hourly", { enabled: true });
    s.engine.reindex(s.botId, "hourly");
    expect(s.engine.nextRunAt(s.botId, "hourly")).toBe(T0 + 6 * H);
    s.store.remove(s.botId, "hourly");
    s.engine.reindex(s.botId, "hourly");
    expect(s.db.index()).toEqual([]);
  });

  it("a slot claimed before a crash can't fire twice after it (ORIG-02 §02.4)", () => {
    const s = setup();
    s.store.create(s.botId, { name: "Hourly", prompt: "p", schedule: "@every 60m", enabled: true });
    s.engine.boot();
    s.clock.now = T0 + H + 1_000;
    s.engine.tick();
    // simulate a crash that lost the index update: put the old next_run_at back and tick again
    const row = s.db.index()[0]!;
    s.db.upsertIndex({ ...row, nextRunAt: T0 + H });
    s.engine.tick();
    expect(s.claims).toHaveLength(1);
  });

  it("boot returns claimed/gated/queued/retry_wait fires to re-queue and running fires as interrupted (ORIG-02 §02.5)", () => {
    const s = setup();
    const mk = (runId: string, state: FireRow["state"]) => {
      s.db.claimFire({ runId, botId: s.botId, routineId: "r", trigger: "schedule", scheduledFor: 1, defHash: "h", eventJson: null, dedupeKey: runId }, 1);
      s.db.setFireState(runId, state, null, 2);
    };
    mk("c", "claimed"); mk("g", "gated"); mk("q", "queued"); mk("w", "retry_wait"); mk("run", "running"); mk("ok", "finished_ok");
    const b = s.engine.boot();
    expect(b.recovered.map((f) => f.runId).sort()).toEqual(["c", "g", "q", "w"]);
    expect(b.interrupted.map((f) => f.runId)).toEqual(["run"]);
  });
});
