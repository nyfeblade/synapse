import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { RoutineStore, defHash } from "../../routines/routine-store";
import { SchedulerDb, type FireRow } from "../../routines/scheduler-db";
import { SchedulerEngine, planTick } from "../../routines/engine";
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
  const claims: { fire: FireRow; missed: number }[] = [];
  const skipped: string[][] = [];
  const engine = new SchedulerEngine({
    db, store, botTz: () => "UTC", now: () => clock.now, mono: () => clock.mono,
    setTimer: () => 0, clearTimer: () => {}, onClaim: (f, extra) => claims.push({ fire: f, missed: extra?.missed ?? 0 }), onOfflineSkips: (ids) => skipped.push(ids),
  });
  return { botId, clock, store, db, engine, claims, skipped };
}

describe("catch-up after sleep", () => {
  const row = { botId: "b", routineId: "r", defHash: "h", enabled: true, kind: "every" as const, tz: null, nextRunAt: T0 };
  const hourly = (_r: unknown, from: number) => T0 + (Math.floor((from - T0) / H) + 1) * H;

  it("planTick claims the latest missed slot once (never a burst) when the routine catches up", () => {
    const p = planTick({ rows: [row], now: T0 + 9 * H + 120_000, nextAfter: hourly, catchUp: () => true });
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]!.slot).toBe(T0 + 9 * H);
    expect(p.claims[0]!.missed).toBe(10);
    expect(p.skips).toEqual([]);
    expect(p.updated[0]!.nextRunAt).toBe(T0 + 10 * H);
  });

  it("without catch-up the old rule holds: every missed slot is skipped", () => {
    const p = planTick({ rows: [row], now: T0 + 9 * H + 120_000, nextAfter: hourly, catchUp: () => false });
    expect(p.claims).toEqual([]);
    expect(p.skips).toHaveLength(10);
  });

  it("the engine runs a catch-up routine once on wake with the missed count, and raises no skip tray", () => {
    const s = setup();
    s.store.create(s.botId, { name: "Inbox", prompt: "p", schedule: "0 * * * *", enabled: true, catchUp: true });
    s.engine.boot();
    s.engine.tick();
    s.clock.now = T0 + 5 * H + 10 * 60_000; // slept through 07:00–11:00
    s.clock.mono += 1_000; // the monotonic clock stood still while asleep
    s.engine.tick();
    expect(s.claims).toHaveLength(1);
    expect(s.claims[0]!.fire.scheduledFor).toBe(T0 + 5 * H);
    expect(s.claims[0]!.missed).toBe(5);
    expect(s.skipped).toEqual([]);
    s.engine.tick();
    expect(s.claims).toHaveLength(1);
  });
});

describe("quiet hours in the engine", () => {
  it("never schedules a run inside quiet hours", () => {
    const s = setup();
    const rec = s.store.create(s.botId, { name: "Hourly", prompt: "p", schedule: "0 * * * *", enabled: true, quietHours: "06:30-12:00" })!;
    s.engine.boot();
    expect(s.engine.nextRunAt(s.botId, rec.id)).toBe(T0 + 6 * H); // 12:00 UTC, not 07:00
  });

  it("changing quiet hours changes the definition hash (reindex)", () => {
    const base = { name: "a", prompt: "p", schedule: "0 * * * *", enabled: true };
    expect(defHash({ ...base, quietHours: "22:00-07:00" })).not.toBe(defHash(base));
    expect(defHash({ ...base, quietHours: undefined })).toBe(defHash(base));
  });
});
