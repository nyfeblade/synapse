import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { HostSettingsStore } from "../../store/host-settings";
import { UsageLadder } from "../../usage/ladder";
import { UsageStore } from "../../usage/usage-store";
import { usageView } from "../../usage/module";

/**
 * synapse-public: Bots reach Claude with the Anthropic API key only, so there is no Claude plan: no plan windows
 * (rate_limit_event's five_hour / seven_day), no plan %, no plan name. What an old subscription install left behind is
 * dropped once, and the usage ladder follows the dollar budgets only.
 */
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0); // Thu 2026-09-17 11:00 America/New_York
const bots = { has: () => true, summary: (id: string) => ({ id, profile: { name: id } }) } as never;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-plan-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const open = (settings: HostSettingsStore, file = "usage.db") =>
  new UsageStore({ file: path.join(dir, file), metricsFile: path.join(dir, "runtime-metrics.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => NOW });

describe("no Claude plan data", () => {
  it("a rate_limit event records nothing; the store has no plan, plan windows or weekly plan %", () => {
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    settings.update({ userTimeZone: "America/New_York" });
    const s = open(settings);
    s.onEvent("a", { kind: "rate_limit", windows: { seven_day: { utilization: 0.86, resetsAt: 1_790_542_800 } } } as never);
    for (const m of ["plan", "setPlan", "windows", "weekly"]) expect((s as unknown as Record<string, unknown>)[m], m).toBeUndefined();
    expect(new Date(s.weekStart()).toISOString()).toBe("2026-09-14T04:00:00.000Z"); // the calendar week, Monday 00:00 local
    s.close();
  });

  it("migration: an old subscription's plan data (86% of the week, the plan name, the reset time) is dropped once", () => {
    const f = path.join(dir, "old.db");
    const db = new DatabaseSync(f);
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO kv VALUES (?, ?)").run("weekly", JSON.stringify({ pct: 86, resetsAt: 1_790_542_800_000 }));
    db.prepare("INSERT INTO kv VALUES (?, ?)").run("windows", JSON.stringify({ seven_day: { id: "seven_day", pct: 86, resetsAt: 1 } }));
    db.close();
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    settings.update({ userTimeZone: "America/New_York" });
    settings.setExtra("claudePlan", "max");
    settings.setExtra("weeklyResetAt", "2026-09-28T19:00:00.000Z");
    const s = open(settings, "old.db");
    expect(settings.extra("claudePlan", "gone")).toBeNull();
    expect(settings.extra("weeklyResetAt", "gone")).toBeNull();
    expect(new Date(s.weekStart()).toISOString()).toBe("2026-09-14T04:00:00.000Z");
    s.close();
    const check = new DatabaseSync(f);
    expect(check.prepare("SELECT key FROM kv WHERE key IN ('weekly', 'windows')").all()).toEqual([]);
    check.close();
  });

  it("the Usage view carries no plan fields", () => {
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    const s = open(settings);
    const trays = { add: () => {}, dismiss: () => {}, list: () => [], get: () => undefined } as never;
    const ladder = new UsageLadder({ usage: s, trays, now: () => NOW });
    const v = usageView({ flags: () => DEFAULT_FLAGS } as never, s, ladder);
    for (const k of ["authMode", "plan", "weeklyPct", "resetsAt"]) expect(v, k).not.toHaveProperty(k);
    s.close();
  });

  it("the ladder follows the monthly dollar budget only (no plan window, no weekly budget)", () => {
    const usage = { budgetUsd: () => 10, weekCostUsd: () => 9, ladderState: () => ({ dismissed: {}, resumedWeek: null }), setLadderState: () => {}, weekStart: () => 0 } as never;
    const trays = { add: () => {}, dismiss: () => {}, list: () => [], get: () => undefined } as never;
    const l = new UsageLadder({ usage, trays, now: () => NOW, monthBudgetPct: () => 20 });
    expect(l.usagePct()).toBe(20);
  });
});
