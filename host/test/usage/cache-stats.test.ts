import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageStore } from "../../usage/usage-store";
import type { SettledTurn } from "../../runner/observers";

/**
 * The prompt cache is the highest-leverage number in this app's cost: a Bot's static prefix is ~30k
 * tokens, and whether those tokens are billed as a cache READ (0.1x) or a cache WRITE (1.25x) is a
 * 12x difference on the same content. The store has always written cacheRead and cacheWrite to the
 * runs table and nothing has ever read them back, so nobody could say what the hit rate was. This is
 * that read-back. (Baseline from 172 real assistant calls in the box's own session transcripts,
 * 2026-09-19: 91.1% read, 8.8% write, 0.02% uncached.)
 */
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachestats-"));
  return new UsageStore({
    file: path.join(dir, "u.db"), metricsFile: path.join(dir, "m.db"),
    bots: { has: () => true, summary: () => ({ profile: { name: "B" } }) } as never,
    settings: { timeZone: () => "UTC", extra: <T,>(_k: string, d: T) => d, setExtra: () => {} } as never,
    flags: () => ({}) as never, now: () => 1_000_000,
  });
};

const turn = (u: Partial<SettledTurn["result"]["usage"]>, id = Math.random().toString(36)): SettledTurn => ({
  requestId: id, botId: "a", source: "user", startedAt: 1_000_000, endedAt: 1_000_100, model: "claude-sonnet-5",
  result: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u }, finalText: "", toolCallCount: 0, model: "claude-sonnet-5" },
} as unknown as SettledTurn);

describe("cache accounting (the number the whole token budget turns on)", () => {
  it("reports zeroes, not NaN, before any turn has settled", () => {
    expect(store().cacheStats()).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0, hitRate: null, writeRate: null });
  });

  it("splits prompt tokens into read, write and uncached, and gives the hit rate", () => {
    const s = store();
    s.onSettled(turn({ inputTokens: 100, cacheReadTokens: 9_000, cacheWriteTokens: 900, outputTokens: 50 }, "r1"));
    s.onSettled(turn({ inputTokens: 100, cacheReadTokens: 9_000, cacheWriteTokens: 900, outputTokens: 50 }, "r2"));
    const c = s.cacheStats();
    expect(c.promptTokens, "output tokens are not prompt tokens").toBe(20_000);
    expect(c.cacheReadTokens).toBe(18_000);
    expect(c.cacheWriteTokens).toBe(1_800);
    expect(c.inputTokens).toBe(200);
    expect(c.hitRate).toBe(90);
    expect(c.writeRate).toBe(9);
  });

  it("counts helper calls too — they are real spend on the same account", () => {
    const s = store();
    s.recordHelper("a", "b2b-gate", "claude-haiku-4-5-20251001", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 10 });
    expect(s.cacheStats().promptTokens).toBe(100);
    expect(s.cacheStats().hitRate).toBe(80);
  });
});
