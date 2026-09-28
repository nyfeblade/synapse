import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { TurnResult, TurnUsage } from "../../brain/types";
import type { SettledTurn } from "../../runner/observers";
import { HostSettingsStore } from "../../store/host-settings";
import { UsageDashboard } from "../../usage/dashboard";
import { dayStartMs, monthStartMs } from "../../usage/periods";
import { UsageStore } from "../../usage/usage-store";

const TZ = "America/New_York";
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0); // Thu 2026-09-17 11:00 New York
const usage = (u: Partial<TurnUsage>): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u });
const result = (u: Partial<TurnUsage>): TurnResult => ({
  sentMessageCount: 1, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false,
  usage: usage(u), finalText: "", toolCallCount: 0, model: "claude-sonnet-5",
});
const turn = (botId: string, requestId: string, u: Partial<TurnUsage>, startedAt: number, source: SettledTurn["source"] = "user"): SettledTurn => ({
  botId, requestId, lane: "user", source, hidden: false, startedAt, endedAt: startedAt + 1000, model: "claude-sonnet-5", userText: "x", sentTexts: [], result: result(u),
});

let now = NOW;
let store: UsageStore;
let dash: UsageDashboard;
const bots = {
  has: (id: string) => ["a", "b"].includes(id),
  summary: (id: string) => ({ id, profile: { name: id === "a" ? "Planner" : "Scout" } }),
} as never;

beforeEach(() => {
  now = NOW;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: TZ });
  store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => now });
  dash = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => now });
});

describe("usage dashboard: per Bot, per day / week / month", () => {
  beforeEach(() => {
    store.onSettled(turn("a", "a1", { inputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 200, outputTokens: 50, costUsd: 0.4 }, NOW - HOUR));
    store.onSettled(turn("b", "b1", { inputTokens: 5, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 20, costUsd: 0.1 }, NOW - 2 * HOUR));
    store.onSettled(turn("a", "a2", { inputTokens: 1, cacheReadTokens: 10, outputTokens: 1, costUsd: 1.5 }, NOW - 2 * 24 * HOUR)); // Tue, same week
    store.onSettled(turn("a", "a3", { inputTokens: 1, outputTokens: 1, costUsd: 3 }, Date.UTC(2026, 8, 2, 15))); // Sep 2, same month
    store.onSettled(turn("a", "old", { inputTokens: 1, outputTokens: 1, costUsd: 99 }, Date.UTC(2026, 7, 20, 15))); // August
    store.recordHelper("a", "extraction", "claude-haiku-4-5", usage({ inputTokens: 100, outputTokens: 10, costUsd: 0.01 }));
  });

  it("splits tokens into input, cache read, cache write and output with API-equivalent dollars", () => {
    const v = dash.view("day", null);
    expect(v.start).toBe(dayStartMs(NOW, TZ));
    expect(v.totals).toEqual({ inputTokens: 115, cacheReadTokens: 1500, cacheWriteTokens: 300, outputTokens: 80, tokens: 1995, usd: 0.51, runs: 3 });
    const a = v.bots.find((b) => b.botId === "a")!;
    expect(a).toMatchObject({ name: "Planner", inputTokens: 110, cacheReadTokens: 1000, cacheWriteTokens: 200, outputTokens: 60, usd: 0.41, runs: 2 });
  });

  it("widens to the week and the calendar month, and filters to one Bot", () => {
    expect(dash.view("week", null).totals.usd).toBeCloseTo(2.01);
    const m = dash.view("month", null);
    expect(m.start).toBe(monthStartMs(NOW, TZ));
    expect(m.totals.usd).toBeCloseTo(5.01);
    expect(dash.view("month", "b").totals).toMatchObject({ usd: 0.1, runs: 1 });
  });

  it("buckets the chart by local hour (day) or local day (week, month), and the buckets add up", () => {
    const d = dash.view("day", null);
    expect(d.series).toHaveLength(24);
    expect(d.series[10]!.usd).toBeCloseTo(0.4); // a1 at 10:00 New York
    expect(d.series[11]!.usd).toBeCloseTo(0.01); // the helper call, recorded at 11:00
    const m = dash.view("month", null);
    expect(m.series).toHaveLength(30);
    expect(m.series[1]!.start).toBe(dayStartMs(Date.UTC(2026, 8, 2, 15), TZ));
    expect(m.series.reduce((s, p) => s + p.usd, 0)).toBeCloseTo(m.totals.usd);
    expect(m.series.reduce((s, p) => s + p.tokens, 0)).toBe(m.totals.tokens);
  });
});

describe("usage dashboard: per task and most expensive runs", () => {
  it("groups by schedule / trigger name, conversations and background work", () => {
    store.noteTask("r1", { routineId: "rt_1", label: "Morning brief" });
    store.onSettled(turn("a", "r1", { outputTokens: 10, costUsd: 0.3 }, NOW - HOUR, "routine"));
    store.noteTask("r2", { routineId: "rt_1", label: "Morning brief" });
    store.onSettled(turn("a", "r2", { outputTokens: 10, costUsd: 0.2 }, NOW - 2 * HOUR, "routine"));
    store.onSettled(turn("a", "u1", { outputTokens: 10, costUsd: 0.05 }, NOW - HOUR));
    store.recordHelper("a", "coding", "claude-sonnet-5", usage({ outputTokens: 10, costUsd: 0.7 }));
    const tasks = dash.view("day", null).tasks;
    expect(tasks.map((t) => [t.label, t.kind, t.runs, t.usd])).toEqual([
      ["Coding agents", "background", 1, 0.7],
      ["Morning brief", "routine", 2, 0.5],
      ["Conversations", "conversation", 1, 0.05],
    ]);
  });

  it("lists the most expensive runs, linked to the chat message they produced", () => {
    store.noteLink("big", "a", "a_s7_1");
    store.noteLink("big", "a", "a_s7_2"); // the first visible message wins
    store.noteTask("big", { routineId: "rt_9", label: "Inbox sweep" });
    store.onSettled(turn("a", "big", { outputTokens: 900, costUsd: 2.5 }, NOW - HOUR, "routine"));
    store.onSettled(turn("b", "mid", { outputTokens: 90, costUsd: 0.5 }, NOW - HOUR));
    store.onSettled(turn("b", "small", { outputTokens: 9, costUsd: 0.01 }, NOW - HOUR));
    const top = dash.view("day", null).top;
    expect(top.map((r) => r.requestId)).toEqual(["big", "mid", "small"]);
    expect(top[0]).toMatchObject({ botId: "a", name: "Planner", label: "Inbox sweep", usd: 2.5, link: { chatId: "a", entryId: "a_s7_1" } });
    expect(top[1]!.link).toBeNull();
    expect(top[1]!.label).toBe("Conversation");
  });
});


describe("spend listeners", () => {
  it("hears every recorded run once, and stops when unsubscribed", () => {
    const heard: { botId: string; usd: number; tokens: number }[] = [];
    const off = store.onSpend((s) => heard.push({ botId: s.botId, usd: s.usd, tokens: s.tokens }));
    store.onSettled(turn("a", "x1", { inputTokens: 5, outputTokens: 5, costUsd: 0.2 }, NOW));
    store.onSettled(turn("a", "x1", { inputTokens: 5, outputTokens: 5, costUsd: 0.2 }, NOW)); // duplicate requestId: not a second spend
    store.recordHelper("b", "dreaming", "claude-haiku-4-5", usage({ outputTokens: 3, costUsd: 0.01 }));
    off();
    store.onSettled(turn("a", "x2", { costUsd: 1 }, NOW));
    expect(heard).toEqual([{ botId: "a", usd: 0.2, tokens: 10 }, { botId: "b", usd: 0.01, tokens: 3 }]);
  });
});
describe("API spend: today, this week, this month, for the account and per Bot", () => {
  it("sums each calendar period from usage.db and lists only Bots that spent", () => {
    store.onSettled(turn("a", "t1", { costUsd: 0.4 }, NOW - HOUR)); // today
    store.onSettled(turn("b", "t2", { costUsd: 0.1 }, NOW - 2 * HOUR)); // today
    store.onSettled(turn("a", "w1", { costUsd: 1.5 }, NOW - 2 * 24 * HOUR)); // Tue, this week
    store.onSettled(turn("a", "m1", { costUsd: 3 }, Date.UTC(2026, 8, 2, 15))); // this month
    store.onSettled(turn("a", "old", { costUsd: 99 }, Date.UTC(2026, 7, 20, 15))); // August
    const s = dash.spendSummary();
    expect(s).toMatchObject({ today: 0.5, week: 2, month: 5 });
    expect(s.bots).toEqual([
      { botId: "a", name: "Planner", today: 0.4, week: 1.9, month: 4.9 },
      { botId: "b", name: "Scout", today: 0.1, week: 0.1, month: 0.1 },
    ]);
    now = Date.UTC(2026, 9, 1, 15); // October: nothing this month yet
    expect(dash.spendSummary()).toMatchObject({ today: 0, week: 0, month: 0, bots: [] });
  });
});
