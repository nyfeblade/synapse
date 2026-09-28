import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../../usage/usage-store";
import type { SettledTurn } from "../../runner/observers";

/**
 * saving-settings: the one extra line each Savings setting may show is a measured weekly figure — what the other choice
 * would have cost or saved over the last 7 days of this user's runs in usage.db. The fixture DB below is small enough to
 * price by hand (Sonnet 5, $2 per million input tokens; cache read 0.1x, 5-minute write 1.25x, 1-hour write 2x).
 */
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 100 * DAY;
const T0 = NOW - 6 * DAY;
const PRICE = 2 / 1e6;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fixture(rows: Row[]): UsageStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "savings-"));
  dirs.push(dir);
  const file = path.join(dir, "usage.db");
  const store = new UsageStore({
    file, metricsFile: path.join(dir, "m.db"),
    bots: { has: () => true, summary: () => ({ profile: { name: "B" } }) } as never,
    settings: { timeZone: () => "UTC", extra: <T,>(_k: string, d: T) => d, setExtra: () => {}, get: () => ({}) } as never,
    flags: () => ({}) as never, now: () => NOW,
  });
  const db = new DatabaseSync(file);
  const ins = db.prepare(`INSERT INTO runs (requestId, botId, source, routineId, model, startedAt, durationMs, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, numTurns, status, purpose, costBasis, voice, callLive, ctxStart, ctxPeak)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, 0, 1, 'ok', ?, 'exact', ?, ?, ?, ?)`);
  rows.forEach((r, i) => ins.run(`r${i}`, r.bot, r.source ?? "user", r.model ?? "claude-sonnet-5[1m]", r.at, r.dur ?? 10_000, r.input ?? 2, r.read ?? 0, r.write ?? 0,
    r.purpose ?? "turn", r.voice ?? null, r.live ?? null, r.ctx ?? null, r.peak ?? r.ctx ?? null));
  db.close();
  return store;
}
interface Row { bot: string; at: number; source?: string; purpose?: string; model?: string; dur?: number; input?: number; read?: number; write?: number; voice?: number | null; live?: number | null; ctx?: number | null; peak?: number | null }

const cents = (n: number) => Math.round(n * 100) / 100;

describe("the weekly estimates, from a fixture usage DB", () => {
  // Bot A: a chat, a 28-minute pause, then a call with a typed message in the middle, then a typed turn after it.
  const A: Row[] = [
    { bot: "a", at: T0, write: 100_000, ctx: 100_000, voice: 0, live: 0 },
    { bot: "a", at: T0 + 2 * MIN, read: 100_000, write: 1_000, ctx: 100_000, voice: 0, live: 0 },
    { bot: "a", at: T0 + 30 * MIN, read: 101_000, write: 1_000, ctx: 101_000, voice: 0, live: 0 }, // a 5–60 min gap: read today
    { bot: "a", at: T0 + 32 * MIN, source: "voice-delegate", write: 102_000, ctx: 102_000, voice: 1, live: 1 }, // effort → low
    { bot: "a", at: T0 + 33 * MIN, write: 103_000, ctx: 103_000, voice: 0, live: 1 }, // typed during the call → back
    { bot: "a", at: T0 + 34 * MIN, source: "voice-delegate", write: 104_000, ctx: 104_000, voice: 1, live: 1 }, // → low
    { bot: "a", at: T0 + 50 * MIN, write: 105_000, ctx: 105_000, voice: 0, live: 0 }, // after the call → back
  ];
  // Bot B: a chat that grows past the long-context line once.
  const B: Row[] = [
    { bot: "b", at: T0 + DAY, write: 50_000, ctx: 50_000, peak: 50_000, voice: 0, live: 0 },
    { bot: "b", at: T0 + DAY + MIN, read: 50_000, write: 1_000, ctx: 50_000, peak: 170_000, voice: 0, live: 0 },
  ];
  const noise: Row[] = [
    { bot: "a", at: NOW - 8 * DAY, write: 9_000_000, ctx: 9_000_000, voice: 1, live: 1 }, // older than the week
    { bot: "a", at: T0 + 40 * MIN, purpose: "review", source: "helper:review", model: "claude-haiku-4-5-20251001", write: 5_000_000 }, // a helper, not the Bot's conversation
  ];

  it("Keep conversations ready (5 minutes): the cheaper writes minus the re-writes after 5–60 minute gaps", () => {
    const s = fixture([...A, ...B, ...noise]).savings();
    const writes = (100_000 + 1_000 + 1_000 + 102_000 + 103_000 + 104_000 + 105_000 + 50_000 + 1_000) * (2 - 1.25) * PRICE;
    const rewrites = 101_000 * (1.25 - 0.1) * PRICE; // only the turn after the 28-minute pause read a warm cache
    expect(s.cacheTtl5m).toBe(cents(writes - rewrites));
  });

  it("Call replies: each effort switch re-writes the history; Fast keeps the in-call ones out, Match the Bot all of them", () => {
    const s = fixture([...A, ...B, ...noise]).savings();
    const sw = (ctx: number) => ctx * (2 - 0.1) * PRICE;
    const today = sw(102_000) + sw(103_000) + sw(104_000) + sw(105_000);
    const fast = sw(102_000) + sw(105_000); // into the call, and out of it
    expect(s.callFast).toBe(cents(today - fast));
    expect(s.callMatch).toBe(cents(today));
  });

  it("Long-context model (only when needed): no long-context premium on these models, so the figure is the one re-write per chat that escalates", () => {
    const s = fixture([...A, ...B, ...noise]).savings();
    expect(s.longContextWhenNeeded).toBe(cents(-(160_000 * (2 - 0.1) * PRICE)));
  });

  it("an empty week is zero everywhere, not NaN", () => {
    expect(fixture([]).savings()).toEqual({ days: 7, cacheTtl5m: 0, callFast: 0, callMatch: 0, longContextWhenNeeded: 0 });
  });
});

describe("rows written before the voice / call / context columns existed", () => {
  // voice = a voice-delegate run; a call is live from a voice run until the call's wrap-up; the context at the start of
  // a run is its prompt tokens split over the requests its ~2 uncached tokens per request imply.
  const C: Row[] = [
    { bot: "c", at: T0, read: 60_000, write: 1_000, input: 2 },
    { bot: "c", at: T0 + MIN, source: "voice-delegate", write: 62_000, input: 2 },
    { bot: "c", at: T0 + 2 * MIN, write: 63_000, input: 2 },
  ];
  const sw = (ctx: number) => ctx * (2 - 0.1) * PRICE;

  it("a typed turn right after a spoken one counts as during the call", () => {
    const s = fixture(C).savings();
    expect(s.callMatch).toBe(cents(sw(62_002) + sw(63_002)));
    expect(s.callFast).toBe(cents(sw(63_002)));
  });

  it("a run of many requests is never read as one huge context (no escalation guessed from its totals)", () => {
    // 1,068 uncached tokens: a new message, so how many requests shared the 400k read is unknown.
    const s = fixture([{ bot: "d", at: T0, read: 400_000, write: 20_000, input: 1_068 }]).savings();
    expect(s.longContextWhenNeeded).toBe(0);
    // ~2 uncached tokens per request: one request of 170k — that one did pass the line.
    const t = fixture([{ bot: "d", at: T0, read: 169_000, write: 998, input: 2 }]).savings();
    expect(t.longContextWhenNeeded).toBe(cents(-(160_000 * (2 - 0.1) * PRICE)));
  });

  it("…unless the call's wrap-up came in between", () => {
    const s = fixture([...C, { bot: "c", at: T0 + MIN + 30_000, purpose: "call-wrapup", source: "helper:call-wrapup", model: "claude-haiku-4-5-20251001", dur: 0 }]).savings();
    expect(s.callFast).toBe(0);
  });
});

describe("new rows carry what the estimates need", () => {
  it("records whether the turn was spoken, whether a call was live, and its first and largest context", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "savings-"));
    dirs.push(dir);
    const file = path.join(dir, "usage.db");
    const store = new UsageStore({
      file, metricsFile: path.join(dir, "m.db"),
      bots: { has: () => true, summary: () => ({ profile: { name: "B" } }) } as never,
      settings: { timeZone: () => "UTC", extra: <T,>(_k: string, d: T) => d, setExtra: () => {}, get: () => ({}) } as never,
      flags: () => ({}) as never, now: () => NOW,
    });
    store.onEvent("a", { kind: "context", tokens: 40_000 });
    store.onEvent("a", { kind: "context", tokens: 45_000 });
    store.onEvent("a", { kind: "context", tokens: 44_000 });
    store.onSettled({
      requestId: "q1", botId: "a", source: "voice-delegate", startedAt: NOW - MIN, endedAt: NOW, model: "claude-sonnet-5[1m]", voice: true, callLive: true,
      result: { usage: { inputTokens: 2, outputTokens: 5, cacheReadTokens: 40_000, cacheWriteTokens: 100 }, finalText: "", toolCallCount: 0, model: "claude-sonnet-5[1m]" },
    } as unknown as SettledTurn);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT voice, callLive, ctxStart, ctxPeak FROM runs WHERE requestId = 'q1'").get()).toEqual({ voice: 1, callLive: 1, ctxStart: 40_000, ctxPeak: 45_000 });
    db.close();
  });
});
