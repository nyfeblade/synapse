import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { HostSettingsStore } from "../../store/host-settings";
import { Budgets } from "../../usage/budgets";
import { UsageDashboard } from "../../usage/dashboard";
import { UsageStore } from "../../usage/usage-store";

/**
 * The dashboard's budget: every query under 50 ms on five years of usage.db. The synthetic file is a
 * heavy user: 12 Bots, ~1,000 runs a day (turns, routines and background helpers) for 5 years, about
 * 1.8M rows, written by SQL in one statement so the setup stays a couple of seconds.
 */
const TZ = "America/New_York";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 3, 0, 0); // Sep 30 23:00 New York: the worst case, a full month and a full week
const YEARS = 5;
const PER_DAY = 1000;
const BOTS = 12;
const ROWS = YEARS * 365 * PER_DAY;

let dir: string;
let store: UsageStore;
let dash: UsageDashboard;
let budgets: Budgets;
const botIds = Array.from({ length: BOTS }, (_, i) => `bot${i}`);
const bots = { has: (id: string) => botIds.includes(id), summary: (id: string) => ({ id, profile: { name: id } }), ids: () => botIds } as never;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-perf-"));
  const file = path.join(dir, "usage.db");
  // The pre-dashboard schema (as live usage.db files have it), filled, then opened by the new store: the
  // migration has to add its columns and indexes to an existing five-year file, not an empty one.
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE runs (requestId TEXT PRIMARY KEY, botId TEXT NOT NULL, source TEXT NOT NULL, routineId TEXT, model TEXT NOT NULL,
      startedAt INTEGER NOT NULL, durationMs INTEGER NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
      cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, costUsd REAL NOT NULL, numTurns INTEGER NOT NULL, status TEXT NOT NULL,
      purpose TEXT, costBasis TEXT, rawCostUsd REAL);
    CREATE INDEX runs_started ON runs(startedAt);`);
  const start = NOW - YEARS * 365 * DAY;
  const step = (YEARS * 365 * DAY) / ROWS;
  raw.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS - 1})
    INSERT INTO runs SELECT 'r' || i, 'bot' || (i % ${BOTS}), CASE i % 5 WHEN 0 THEN 'routine' WHEN 1 THEN 'helper:extraction' ELSE 'user' END,
      CASE i % 5 WHEN 0 THEN 'rt' || (i % 37) ELSE NULL END, 'claude-sonnet-5', ${start} + CAST(i * ${step} AS INTEGER), 1000,
      (i % 50), 200 + (i % 700), 20000 + (i % 9000), (i % 3000), 0.001 * (1 + (i * 7919) % 400), 1, 'ok',
      CASE i % 5 WHEN 1 THEN 'extraction' ELSE 'turn' END, 'exact', NULL FROM n`);
  raw.close();
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: TZ });
  store = new UsageStore({ file, metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => NOW });
  dash = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => NOW });
  budgets = new Budgets({ usage: store, query: dash, settings, bots, now: () => NOW, tz: () => TZ, trays: { add: (t) => t as never } });
  budgets.setPolicy(null, { limits: [{ period: "month", unit: "usd", limit: 1e9 }, { period: "day", unit: "tokens", limit: 1e12 }], warnPct: 80, onLimit: "ask" });
  budgets.setPolicy("bot3", { limits: [{ period: "day", unit: "usd", limit: 1e9 }, { period: "month", unit: "usd", limit: 1e9 }], warnPct: 80, onLimit: "pause" });
}, 120_000);

afterAll(() => {
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Best of 5 after a warm-up: the budget is about the query plan, not a noisy CI neighbour. */
function timed(fn: () => unknown): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe("dashboard on a five-year usage.db", () => {
  it("has the synthetic history", () => {
    expect(dash.view("month", null).totals.runs).toBeGreaterThan(29_000);
  });

  for (const range of ["day", "week", "month"] as const) {
    it(`answers the ${range} view in under 50 ms, all Bots and one Bot`, () => {
      expect(timed(() => dash.view(range, null))).toBeLessThan(50);
      expect(timed(() => dash.view(range, "bot3"))).toBeLessThan(50);
    });
  }

  it("records a run and checks a budget (every limit, account and Bot) in under 5 ms", () => {
    const u = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 };
    expect(timed(() => { store.recordHelper("bot3", "turn", "claude-sonnet-5", u); return budgets.check("bot3", { usd: 0.1 }); })).toBeLessThan(5);
  });

  it("the first check after a start (nothing cached, a full month of rows to sum) stays under the 50 ms budget", () => {
    const cold = () => {
      const q = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => NOW });
      return new Budgets({ usage: store, query: q, settings: new HostSettingsStore(path.join(dir, "settings.json")), bots, now: () => NOW, tz: () => TZ, trays: { add: (t) => t as never } }).check("bot3", { usd: 0.1 });
    };
    expect(timed(cold)).toBeLessThan(50);
  });

  it("keeps running totals exact as runs are recorded (the cache is a sum, not a guess)", () => {
    const monthStart = Date.UTC(2026, 8, 1, 4);
    const before = dash.spent(null, monthStart, "usd");
    store.recordHelper("bot5", "turn", "claude-sonnet-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.25 });
    const fresh = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => NOW });
    expect(dash.spent(null, monthStart, "usd")).toBeCloseTo(before + 1.25, 6);
    expect(dash.spent(null, monthStart, "usd")).toBeCloseTo(fresh.spent(null, monthStart, "usd"), 6);
  });

  it("estimates a routine's next run from its history in under 5 ms", () => {
    expect(timed(() => budgets.estimate("bot3", "rt5"))).toBeLessThan(5);
  });
});
