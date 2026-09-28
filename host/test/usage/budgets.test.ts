import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BudgetPolicy, WidgetSpec } from "@synapse/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { TurnUsage } from "../../brain/types";
import { HostSettingsStore } from "../../store/host-settings";
import { Budgets } from "../../usage/budgets";
import { UsageDashboard } from "../../usage/dashboard";
import { nextDayStartMs, nextMonthStartMs } from "../../usage/periods";
import { UsageStore } from "../../usage/usage-store";

const TZ = "America/New_York";
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0); // Thu 2026-09-17 11:00 New York
const u = (x: Partial<TurnUsage>): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...x });

let now = NOW;
let dir: string;
let store: UsageStore;
let budgets: Budgets;
let trays: { title: string; dedupeKey?: string; botId: string | null }[];
let posted: { botId: string; spec: WidgetSpec; answer(v: string): void }[];
const bots = {
  has: (id: string) => ["a", "b"].includes(id),
  summary: (id: string) => ({ id, profile: { name: id === "a" ? "Planner" : "Scout" } }),
  ids: () => ["a", "b"],
} as never;

function make(): Budgets {
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: TZ });
  store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => now });
  const query = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => now });
  return new Budgets({
    usage: store, query, settings, bots, now: () => now, tz: () => TZ,
    trays: { add: (t) => { const e = trays.find((x) => x.dedupeKey && x.dedupeKey === t.dedupeKey); if (e) return e as never; trays.push(t); return t as never; } },
    post: (botId, spec, answer) => { posted.push({ botId, spec, answer }); },
  });
}
const spend = (botId: string, usd: number, tokens = 0) => store.recordHelper(botId, "turn", "claude-sonnet-5", u({ outputTokens: tokens, costUsd: usd }));
const daily = (limit: number, o: Partial<BudgetPolicy> = {}): BudgetPolicy => ({ limits: [{ period: "day", unit: "usd", limit }], warnPct: 80, onLimit: "ask", ...o });

beforeEach(() => {
  now = NOW;
  trays = [];
  posted = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "budgets-"));
  budgets = make();
});

describe("budgets.check(botId, estimate)", () => {
  it("is ok with no budgets, and under a budget", () => {
    spend("a", 100);
    expect(budgets.check("a", { usd: 1 }).verdict).toBe("ok");
    budgets.setPolicy("a", daily(5));
    expect(budgets.check("a", { usd: 0 }).verdict).toBe("ask"); // already at $100 of $5
    budgets.setPolicy("a", daily(500));
    expect(budgets.check("a", { usd: 1 }).verdict).toBe("ok");
  });

  it("warns at the threshold, then asks or pauses at 100%", () => {
    budgets.setPolicy("a", daily(5));
    spend("a", 4.1);
    expect(budgets.check("a", { usd: 0.1 })).toMatchObject({ verdict: "warn", hit: { scope: "bot", period: "day", spent: 4.1, limit: 5 } });
    spend("a", 1);
    const d = budgets.check("a", { usd: 0.1 });
    expect(d.verdict).toBe("ask");
    expect(d.message).toContain("Planner is at $5.10 of its $5.00 daily budget.");
    budgets.setPolicy("a", daily(5, { onLimit: "pause" }));
    expect(budgets.check("a", { usd: 0.1 }).verdict).toBe("pause");
    expect(budgets.check("b", { usd: 0.1 }).verdict).toBe("ok"); // another Bot's budget is its own
  });

  it("asks first, with the estimate, when a task would take it past the limit (even in pause mode)", () => {
    budgets.setPolicy("a", daily(5, { onLimit: "pause" }));
    spend("a", 3);
    const d = budgets.check("a", { usd: 2.5 });
    expect(d).toMatchObject({ verdict: "ask", hit: { spent: 3, estimate: 2.5, limit: 5 } });
    expect(d.message).toContain("estimated at about $2.50");
  });

  it("estimates from the Bot's recent runs when the caller has no estimate", () => {
    budgets.setPolicy("a", daily(5));
    for (let i = 0; i < 4; i++) spend("a", 1.2);
    expect(budgets.estimate("a").usd).toBeCloseTo(1.2);
    expect(budgets.check("a")).toMatchObject({ verdict: "ask", hit: { estimate: 1.2 } }); // 4.8 + 1.2 > 5
  });

  it("applies the account-wide budget across every Bot and host-level calls, monthly and in tokens", () => {
    budgets.setPolicy(null, { limits: [{ period: "month", unit: "tokens", limit: 1000 }], warnPct: 90, onLimit: "pause" });
    spend("a", 0, 600);
    store.record({ botId: null, purpose: "token-check", model: "claude-haiku-4-5", usage: u({ outputTokens: 300 }) } as never);
    expect(budgets.check("b", { tokens: 50 })).toMatchObject({ verdict: "warn", hit: { scope: "account", unit: "tokens", spent: 900 } });
    spend("b", 0, 200);
    const d = budgets.check("b", { tokens: 0 });
    expect(d).toMatchObject({ verdict: "pause", hit: { scope: "account", period: "month", spent: 1100, resetsAt: nextMonthStartMs(NOW, TZ) } });
  });

  it("an approval lets that budget continue for the rest of its period, and a new period starts clean", () => {
    budgets.setPolicy("a", daily(5));
    spend("a", 6);
    expect(budgets.check("a", { usd: 0.1 }).verdict).toBe("ask");
    budgets.approve("a");
    expect(budgets.check("a", { usd: 0.1 }).verdict).toBe("ok");
    now = nextDayStartMs(NOW, TZ) + HOUR;
    spend("a", 6);
    expect(budgets.check("a", { usd: 0.1 }).verdict).toBe("ask"); // yesterday's OK does not carry over
  });

  it("an approval survives a host restart", () => {
    budgets.setPolicy("a", daily(5));
    spend("a", 6);
    budgets.approve("a");
    store.close();
    budgets = make();
    expect(budgets.check("a", { usd: 0.1 }).verdict).toBe("ok");
  });

  it("raises one warning tray per budget period", () => {
    budgets.setPolicy("a", daily(5));
    spend("a", 4.2);
    spend("a", 0.1);
    expect(trays.map((t) => t.title)).toEqual(["Planner has used 84% of its daily budget"]);
  });
});

describe("onSpend", () => {
  it("tells subscribers about every recorded run", () => {
    const seen: number[] = [];
    const off = budgets.onSpend((s) => seen.push(s.usd));
    spend("a", 0.25);
    off();
    spend("a", 0.5);
    expect(seen).toEqual([0.25]);
  });
});

describe("tell me before you spend more than X (per task)", () => {
  it("asks once the task's spend would pass the alert, and the user's OK clears it", () => {
    spend("a", 10); // before the alert: not this task
    now += 1000;
    budgets.setTaskAlert("a", 1);
    spend("a", 0.6);
    expect(budgets.check("a", { usd: 0.2 }).verdict).toBe("ok");
    const d = budgets.check("a", { usd: 0.5 });
    expect(d).toMatchObject({ verdict: "ask", hit: { scope: "task", spent: 0.6, limit: 1 } });
    expect(d.message).toContain("you asked to be told before it passes $1.00");
    budgets.approve("a");
    expect(budgets.check("a", { usd: 0.5 }).verdict).toBe("ok");
    expect(budgets.view().taskAlerts).toEqual([]);
  });

  it("tells the user in the chat, once, when a run takes the task past the alert", () => {
    budgets.setTaskAlert("a", 1);
    spend("a", 0.7);
    expect(posted).toHaveLength(0);
    spend("a", 0.5);
    spend("a", 0.5);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.spec.question).toContain("Planner has spent $1.20 on this task; you asked to be told before it passes $1.00");
    posted[0]!.answer(posted[0]!.spec.options[0]!.value);
    expect(budgets.taskAlert("a")).toBeNull();
  });

  it("shows the alert with its spend so far", () => {
    budgets.setTaskAlert("a", 2);
    spend("a", 0.5);
    expect(budgets.view().taskAlerts).toEqual([{ botId: "a", name: "Planner", limitUsd: 2, spentUsd: 0.5, since: NOW }]);
    budgets.setTaskAlert("a", null);
    expect(budgets.view().taskAlerts).toEqual([]);
  });
});

describe("scheduled and triggered runs", () => {
  it("pause mode holds routine fires until the period resets", () => {
    budgets.setPolicy("a", daily(5, { onLimit: "pause" }));
    spend("a", 5);
    expect(budgets.routinePausedUntil("a", "rt_1", "Morning brief")).toBe(nextDayStartMs(NOW, TZ));
    expect(budgets.routinePausedUntil("b", "rt_2", "Other")).toBeNull();
  });

  it("ask mode holds the fire and posts one approval card; Continue lets the next fires run", () => {
    budgets.setPolicy("a", daily(5));
    spend("a", 5);
    expect(budgets.routinePausedUntil("a", "rt_1", "Morning brief")).toBe(Number.POSITIVE_INFINITY);
    expect(budgets.routinePausedUntil("a", "rt_1", "Morning brief")).toBe(Number.POSITIVE_INFINITY);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.spec.hostKind).toBe("budget-ask");
    expect(posted[0]!.spec.question).toContain("The scheduled run “Morning brief” was held.");
    posted[0]!.answer(posted[0]!.spec.options[0]!.value);
    expect(budgets.routinePausedUntil("a", "rt_1", "Morning brief")).toBeNull();
  });

  it("uses the routine's own recent runs as its estimate", () => {
    budgets.setPolicy("a", daily(5));
    for (const id of ["r1", "r2"]) {
      store.noteTask(id, { routineId: "rt_big", label: "Big job" });
      store.onSettled({ botId: "a", requestId: id, lane: "background", source: "routine", hidden: true, startedAt: now, endedAt: now + 1, model: "m", userText: null, sentTexts: [],
        result: { sentMessageCount: 0, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false, usage: u({ costUsd: 2 }), finalText: "", toolCallCount: 0, model: "m" } });
    }
    expect(budgets.estimate("a", "rt_big").usd).toBeCloseTo(2);
    expect(budgets.routinePausedUntil("a", "rt_big", "Big job")).toBe(Number.POSITIVE_INFINITY); // 4 + 2 > 5
  });
});
