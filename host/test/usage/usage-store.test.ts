import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { TurnResult } from "../../brain/types";
import type { SettledTurn } from "../../runner/observers";
import { HostSettingsStore } from "../../store/host-settings";
import { UsageStore } from "../../usage/usage-store";
import { normalizeWindow, weekStartMs } from "../../usage/week";

const NOW = Date.UTC(2026, 8, 17, 15, 0, 0); // Thu 2026-09-17 11:00 America/New_York
const result = (u: Partial<TurnResult["usage"]>): TurnResult => ({
  sentMessageCount: 1, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u }, finalText: "", toolCallCount: 2, model: "claude-sonnet-5",
});
const turn = (botId: string, requestId: string, u: Partial<TurnResult["usage"]>, startedAt = NOW): SettledTurn => ({
  botId, requestId, lane: "user", source: "user", hidden: false, startedAt, endedAt: startedAt + 1000, model: "claude-sonnet-5", userText: "x", sentTexts: ["y"], result: result(u),
});

let dir: string;
let store: UsageStore;
const bots = {
  has: (id: string) => ["a", "b"].includes(id),
  summary: (id: string) => ({ id, profile: { name: id === "a" ? "Planner" : "Scout", model: id === "a" ? "claude-opus-5" : undefined } }),
} as never;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "runtime-metrics.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => NOW });
});

describe("week window", () => {
  it("is Monday 00:00 local without a reset time", () => {
    expect(new Date(weekStartMs(NOW, "America/New_York", null)).toISOString()).toBe("2026-09-14T04:00:00.000Z");
  });
  it("aligns to the weekly reset when known", () => {
    const reset = Date.UTC(2026, 8, 20, 9, 0, 0);
    expect(weekStartMs(NOW, "America/New_York", reset)).toBe(reset - 7 * 86_400_000);
  });
  it("normalizes fractions and seconds", () => {
    expect(normalizeWindow({ utilization: 0.62, resetsAt: 1_790_000_000 })).toEqual({ pct: 62, resetsAt: 1_790_000_000_000 });
    expect(normalizeWindow({ utilization: 62, resetsAt: 1_790_000_000_000 })).toEqual({ pct: 62, resetsAt: 1_790_000_000_000 });
  });
});

describe("UsageStore (USE-02, USE-06)", () => {
  it("records runs, sorts Bots by tokens and sums API-equivalent cost", () => {
    store.onSettled(turn("a", "r1", { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.5 }));
    store.onSettled(turn("b", "r2", { inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 }));
    store.onSettled(turn("b", "r3", { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }));
    store.onSettled(turn("a", "old", { inputTokens: 999_999 }, NOW - 10 * 86_400_000));
    expect(store.rows()).toEqual([
      { botId: "b", name: "Scout", model: "claude-sonnet-5", turns: 2, tokens: 6002, costUsd: 0.3 },
      { botId: "a", name: "Planner", model: "claude-opus-5", turns: 1, tokens: 1600, costUsd: 0.5 },
    ]);
    expect(store.weekCostUsd()).toBeCloseTo(0.8);
  });

  it("is idempotent per requestId and counts helper calls for the Bot they served", () => {
    store.onSettled(turn("a", "r1", { inputTokens: 10 }));
    store.onSettled(turn("a", "r1", { inputTokens: 10 }));
    store.recordHelper("a", "dreaming", "claude-haiku-4-5-20251001", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    expect(store.rows()[0]).toMatchObject({ turns: 1, tokens: 20 });
  });

  it("reads efficiency tiles from runtime-metrics.db and shows zeros without it", () => {
    expect(store.efficiency()).toEqual({ dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 });
    const db = new DatabaseSync(path.join(dir, "runtime-metrics.db"));
    db.exec("CREATE TABLE efficiency_week (weekStart INTEGER, botId TEXT, dropped INTEGER, inboxDelivered INTEGER, resultsBatched INTEGER, coalescedTurns INTEGER, loopsEnded INTEGER)");
    const ws = store.weekStart();
    db.prepare("INSERT INTO efficiency_week VALUES (?,?,?,?,?,?,?)").run(ws, "a", 3, 2, 1, 1, 1);
    db.close();
    expect(store.efficiency()).toEqual({ dropped: 3, wakesAvoided: 3, burstsCoalesced: 1, loopsEnded: 1 });
  });
});

describe("ladder state (dismissed trays, Resume)", () => {
  it("defaults to empty and survives a restart of the host", () => {
    expect(store.ladderState()).toEqual({ dismissed: {}, resumedWeek: null });
    store.setLadderState({ dismissed: { "usage80:42": 1 }, resumedWeek: 42 });
    store.close();
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    const reopened = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "runtime-metrics.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => NOW });
    expect(reopened.ladderState()).toEqual({ dismissed: { "usage80:42": 1 }, resumedWeek: 42 });
    reopened.close();
  });
});
