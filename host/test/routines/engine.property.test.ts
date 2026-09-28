import { describe, expect, it } from "vitest";
import { planTick } from "../../routines/engine";
import type { IndexRow } from "../../routines/scheduler-db";
import { nextRunAfter, parseSchedule } from "../../schedule/schedule";
import type { ParsedSchedule } from "../../schedule/types";

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("planTick property (ORIG-02 §02.9)", () => {
  it("10,000 random definitions: no slot twice, no disabled fires, every slot fires on a continuous clock", () => {
    const r = rng(42);
    const T0 = Date.UTC(2026, 8, 21, 0, 0, 0);
    const END = T0 + 2 * 3_600_000;
    const parsed = new Map<string, ParsedSchedule>();
    let rows: IndexRow[] = [];
    for (let i = 0; i < 10_000; i++) {
      const every = r() < 0.8;
      const expr = every ? `@every ${5 + Math.floor(r() * 115)}m` : `${Math.floor(r() * 60)} * * * *`;
      const p = parseSchedule(expr, { tz: "UTC", nowMs: T0 });
      const id = `r${i}`;
      parsed.set(id, p);
      rows.push({ botId: `b${i % 50}`, routineId: id, defHash: "h", enabled: r() > 0.1, kind: every ? "every" : "cron", tz: "UTC", nextRunAt: nextRunAfter(p, T0, "UTC", T0) });
    }
    const nextAfter = (row: IndexRow, from: number) => nextRunAfter(parsed.get(row.routineId)!, from, "UTC", T0);
    const expected = new Map<string, number[]>();
    for (const row of rows) {
      const slots: number[] = [];
      for (let s = row.nextRunAt; s !== null && s <= END - 31_000; s = nextAfter(row, s)) slots.push(s);
      expected.set(row.routineId, row.enabled ? slots : []);
    }
    const got = new Map<string, number[]>();
    let now = T0;
    while (now < END) {
      now += 1_000 + Math.floor(r() * 58_000); // the clock never stalls for more than 59 s
      const plan = planTick({ rows, now, nextAfter });
      expect(plan.skips).toEqual([]);
      for (const c of plan.claims) got.set(c.row.routineId, [...(got.get(c.row.routineId) ?? []), c.slot]);
      const upd = new Map(plan.updated.map((u) => [u.routineId, u]));
      rows = rows.map((row) => upd.get(row.routineId) ?? row);
    }
    for (const [id, slots] of expected) {
      const g = (got.get(id) ?? []).filter((s) => s <= END - 31_000);
      expect(new Set(got.get(id) ?? []).size).toBe((got.get(id) ?? []).length);
      expect(g).toEqual(slots);
    }
  }, 120_000);
});
