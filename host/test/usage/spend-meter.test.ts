import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpendMeterView } from "@synapse/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { ZERO_USAGE, type TurnResult } from "../../brain/types";
import type { SettledTurn } from "../../runner/observers";
import { HostSettingsStore } from "../../store/host-settings";
import { Budgets } from "../../usage/budgets";
import { UsageDashboard } from "../../usage/dashboard";
import { dayStartMs, monthStartMs } from "../../usage/periods";
import { METER_MIN_INTERVAL_MS, SpendMeter } from "../../usage/spend-meter";
import { UsageStore } from "../../usage/usage-store";

const TZ = "America/New_York";
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const bots = { has: (id: string) => id === "a", summary: () => ({ profile: { name: "Planner" } }), ids: () => ["a"] } as never;

let dir: string;
let store: UsageStore;
let budgets: Budgets;
let meter: SpendMeter;
let published: SpendMeterView[];
let publishedAt: number[];
let now = NOW;

const settled = (usd: number, requestId: string): SettledTurn => ({
  botId: "a", requestId, lane: "user", source: "user", hidden: false, startedAt: now - 1000, endedAt: now, model: "claude-sonnet-5", userText: "hi", sentTexts: [],
  result: { sentMessageCount: 1, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false, usage: { ...ZERO_USAGE, costUsd: usd }, finalText: "", toolCallCount: 0, model: "claude-sonnet-5" } satisfies TurnResult,
});
/** What Settings → Usage reads, straight from usage.db. */
const dbSum = (since: number) => (store.database().prepare("SELECT COALESCE(SUM(costUsd), 0) AS c FROM runs WHERE startedAt >= ?").get(since) as { c: number }).c;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  now = NOW;
  published = [];
  publishedAt = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-meter-"));
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: TZ });
  store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => now });
  const dashboard = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => now });
  budgets = new Budgets({ usage: store, query: dashboard, settings, bots, now: () => now, tz: () => TZ, trays: { add: (t) => t as never }, onChange: () => meter.schedule() });
  meter = new SpendMeter({
    spent: (b, s, u) => dashboard.spent(b, s, u), budgets: () => budgets.config(), onSpend: (fn) => store.onSpend(fn),
    // The meter reads the fake timers' clock (Date.now), so its throttle and the timers agree.
    settings, publish: (v) => { published.push(v); publishedAt.push(Date.now()); }, now: () => Date.now(), tz: () => TZ,
  });
});

afterEach(() => {
  meter.stop();
  store.close();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the header's spend meter", () => {
  it("matches usage.db (today and this month) at rest, and moves with a running turn", () => {
    store.onSettled(settled(1.25, "r1"));
    store.recordHelper("a", "dreaming", "claude-haiku-4-5", { ...ZERO_USAGE, costUsd: 0.1 });
    const v = meter.view();
    expect(v.todayUsd).toBeCloseTo(dbSum(dayStartMs(now, TZ)), 2);
    expect(v.monthUsd).toBeCloseTo(dbSum(monthStartMs(now, TZ)), 2);
    expect(v.todayUsd).toBe(1.35);
    // A running turn adds its spend so far...
    meter.onEvent("a", { kind: "spend", turnUsd: 0.42 });
    expect(meter.view()).toMatchObject({ todayUsd: 1.77, turns: { a: 0.42 } });
    // ...and when it settles, its recorded row replaces it: the meter equals usage.db again, not the estimate.
    store.onSettled(settled(0.45, "r2"));
    meter.onSettled(settled(0.45, "r2"));
    const after = meter.view();
    expect(after.turns).toEqual({});
    expect(after.todayUsd).toBeCloseTo(dbSum(dayStartMs(now, TZ)), 2);
    expect(after.todayUsd).toBe(1.8);
  });

  it("turns the warning colour only near the monthly budget", () => {
    store.onSettled(settled(10, "r1"));
    expect(meter.view()).toMatchObject({ budgetUsd: null, budgetPct: null, warn: false });
    budgets.setAccountMonthlyUsd(100);
    expect(meter.view()).toMatchObject({ budgetUsd: 100, budgetPct: 10, warn: false });
    store.onSettled(settled(70, "r2"));
    expect(meter.view()).toMatchObject({ budgetPct: 80, warn: true });
  });

  it("never storms: a turn's many spend events publish at most a few times a second, and only on a shown change", () => {
    // 2,000 spend events over 10 seconds (one every 5 ms), rising a tenth of a cent each.
    for (let i = 1; i <= 2000; i++) {
      meter.onEvent("a", { kind: "spend", turnUsd: i * 0.001 });
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(1000);
    // Never two publishes closer than the interval (at most four a second), against 2,000 events.
    const gaps = publishedAt.slice(1).map((t, i) => t - publishedAt[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(METER_MIN_INTERVAL_MS);
    expect(published.length).toBeLessThanOrEqual(10_000 / METER_MIN_INTERVAL_MS + 2);
    expect(published.at(-1)!.turns.a).toBe(2);
    // Sub-cent moves that don't change a shown figure publish nothing.
    const before = published.length;
    meter.onEvent("a", { kind: "spend", turnUsd: 2.0004 });
    vi.advanceTimersByTime(1000);
    expect(published.length).toBe(before);
  });

  it("uses no timer while nothing moves (no polling)", () => {
    vi.advanceTimersByTime(60_000);
    expect(published).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be hidden, and the choice is kept", () => {
    expect(meter.view().mode).toBe("today");
    expect(meter.setMode("off").mode).toBe("off");
    expect(meter.view().mode).toBe("off");
    expect(() => meter.setMode("weekly" as never)).toThrow();
  });
});
