import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { HostSettingsStore } from "../../store/host-settings";
import { UsageStore } from "../../usage/usage-store";
import { CHIEF_OF_STAFF_ID, CHIEF_OF_STAFF_ROWS, LIVE_WEEKLY_RESET, type LegacyRow } from "./fixtures/chief-of-staff-rows";

/**
 * Rows written before the per-run fix hold the SDK's RUNNING total per session. The host repairs them on
 * start: per Bot, in order, a run's own cost is its running total minus the previous one; a total that
 * went down starts a new count and is marked estimated. Idempotent: a repaired row is never touched again.
 */
const NOW = 1789998100000; // just after the fixture's last row (2026-09-21)
let dir: string;
let file: string;
const bots = { has: (id: string) => [CHIEF_OF_STAFF_ID, "b"].includes(id), summary: (id: string) => ({ id, profile: { name: id === "b" ? "Scout" : "Chief of Staff" } }) } as never;

/** The exact schema every box shipped with before this fix. */
function legacyDb(rows: [string, ...LegacyRow][], weeklyReset: number | null = LIVE_WEEKLY_RESET): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE runs (requestId TEXT PRIMARY KEY, botId TEXT NOT NULL, source TEXT NOT NULL, routineId TEXT, model TEXT NOT NULL,
      startedAt INTEGER NOT NULL, durationMs INTEGER NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
      cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, costUsd REAL NOT NULL, numTurns INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE INDEX runs_started ON runs(startedAt);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  rows.forEach(([botId, at, source, status, model, dur, i, o, cr, cw, cost], n) => ins.run(`req_${n}`, botId, source, null, model, at, dur, i, o, cr, cw, cost, 1, status));
  if (weeklyReset) db.prepare("INSERT INTO kv VALUES ('weekly', ?)").run(JSON.stringify({ pct: 7, resetsAt: weeklyReset }));
  db.close();
}

const open = (now = NOW) => {
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  return new UsageStore({ file, metricsFile: path.join(dir, "runtime-metrics.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => now });
};
const raw = (sql: string) => { const db = new DatabaseSync(file); try { return db.prepare(sql).all() as Record<string, number | string | null>[]; } finally { db.close(); } };
const sum = (where = "1=1") => Number(raw(`SELECT COALESCE(SUM(costUsd),0) AS c FROM runs WHERE ${where}`)[0]!.c);
const cos = CHIEF_OF_STAFF_ROWS.map((r) => [CHIEF_OF_STAFF_ID, ...r] as [string, ...LegacyRow]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-repair-"));
  file = path.join(dir, "usage.db");
});

describe("repairing running totals already in usage.db", () => {
  it("Chief of Staff: $97.77 of summed running totals becomes the session's real $7.71; the week $51.10 → $3.74", () => {
    legacyDb(cos);
    const weekStart = LIVE_WEEKLY_RESET - 7 * 86_400_000;
    expect(sum()).toBeCloseTo(97.767, 3);
    expect(sum(`startedAt >= ${weekStart}`)).toBeCloseTo(51.104, 3);
    const s = open();
    // The plan's weekly reset this fixture carries is dropped (synapse-public: the week is the calendar week), so the
    // repaired week is summed over the calendar week; over the old plan week it is the $3.74 the fix found.
    expect(sum(`startedAt >= ${weekStart}`)).toBeCloseTo(3.7429, 4);
    expect(s.weekCostUsd()).toBeCloseTo(sum(`startedAt >= ${s.weekStart()}`), 4);
    expect(s.rows()[0]).toMatchObject({ name: "Chief of Staff" });
    s.close();
    expect(sum()).toBeCloseTo(7.7065, 4);
    const rows = raw("SELECT costUsd, rawCostUsd, costBasis, status FROM runs ORDER BY startedAt");
    expect(rows[0]).toMatchObject({ costBasis: "derived" });
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.1226, 4);
    expect(Number(rows[1]!.costUsd)).toBeCloseTo(0.0133, 4);
    expect(Number(rows[18]!.costUsd)).toBeCloseTo(0.0713, 4); // the aborted turn still billed its part
    expect(Number(rows[29]!.rawCostUsd)).toBeCloseTo(7.7065, 4); // the original running total is kept
    expect(rows.every((r) => r.costBasis === "derived")).toBe(true);
  });

  it("never double-applies: reopening, or rows recorded after the repair, stay as they are", () => {
    legacyDb(cos);
    open().close();
    const once = raw("SELECT requestId, costUsd FROM runs ORDER BY startedAt");
    const s = open(NOW + 60_000);
    s.recordHelper(CHIEF_OF_STAFF_ID, "extraction", "claude-haiku-4-5", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.004 });
    s.close();
    open(NOW + 120_000).close();
    expect(raw("SELECT requestId, costUsd FROM runs WHERE source NOT LIKE 'helper:%' ORDER BY startedAt")).toEqual(once);
    expect(Number(raw("SELECT costUsd FROM runs WHERE source = 'helper:extraction'")[0]!.costUsd)).toBeCloseTo(0.004, 6);
    expect(sum()).toBeCloseTo(7.7065 + 0.004, 4);
  });

  it("a running total that went down starts a new count (estimated); a zeroed crash result does not break the chain", () => {
    const t0 = NOW - 3_600_000;
    legacyDb([
      ["b", t0, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.5],
      ["b", t0 + 1, "user", "aborted", "claude-sonnet-5", 1, 0, 0, 0, 0, 0],
      ["b", t0 + 2, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.8],
      ["b", t0 + 3, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.1],
      ["b", t0 + 4, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.3],
      ["b", t0 + 5, "helper:coding", "ok", "claude-sonnet-5", 0, 1, 1, 1, 1, 0.07],
    ], null);
    open().close();
    const rows = raw("SELECT costUsd, costBasis FROM runs ORDER BY startedAt");
    expect(rows.map((r) => Math.round(Number(r.costUsd) * 1000) / 1000)).toEqual([0.5, 0, 0.3, 0.1, 0.2, 0.07]);
    expect(rows.map((r) => r.costBasis)).toEqual(["derived", "derived", "derived", "estimated", "derived", "derived"]);
  });

  it("the Usage view says plainly that this week's older figures were rebuilt, and how many are estimates", () => {
    const t0 = NOW - 3_600_000;
    legacyDb([["b", t0, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.5], ["b", t0 + 1, "user", "ok", "claude-sonnet-5", 1, 1, 1, 1, 1, 0.2]]);
    const s = open();
    expect(s.costHistory()).toMatchObject({ repaired: 2, estimated: 1 });
    s.close();
    const fresh = path.join(dir, "fresh.db");
    file = fresh;
    const f = open();
    expect(f.costHistory()).toBeNull();
    f.close();
  });
});
