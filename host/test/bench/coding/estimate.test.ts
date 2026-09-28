import { describe, expect, it } from "vitest";
import { estimate, PROFILES, taskUsage } from "../../../bench/coding/estimate";
import { PILOT, TASKS } from "../../../bench/coding/suite";

describe("cost estimate", () => {
  it("models Claude Code's explicit caching: the first call writes the prefix, each later call reads the previous prompt and writes its growth", () => {
    const p = { prefix: 1000, growthPerCall: 100, outputPerCall: 10, extraCalls: 0, perMessageExtra: 0 };
    // prompts: 1000, 1100, 1200 -> input 3300; writes 1000 + 100 + 100; reads 1000 + 1100
    expect(taskUsage(3, p)).toEqual({ fresh: 0, cacheWrite: 1200, cacheRead: 2100, output: 30 });
    expect(taskUsage(1, p)).toEqual({ fresh: 0, cacheWrite: 1000, cacheRead: 0, output: 10 });
  });

  it("gives the Bot its measured bigger prefix and its extra reply call", () => {
    expect(PROFILES.synapse.prefix).toBeGreaterThan(PROFILES.cli.prefix);
    expect(PROFILES.synapse.prefix).toBe(26_552 + 2_700); // +100: the ENGINEERING MODE cd/progress lines (2026-09-21)
    const e = estimate(["T01"], ["cli", "synapse"], "mid");
    const [cli, syn] = e.runners;
    expect(syn!.calls).toBe(cli!.calls + 1);
    expect(syn!.weighted).toBeGreaterThan(cli!.weighted);
  });

  it("scales: low < mid < high, pilot < full suite, and totals add up", () => {
    const lo = estimate(PILOT, ["cli", "synapse"], "low").weighted;
    const mid = estimate(PILOT, ["cli", "synapse"], "mid").weighted;
    const hi = estimate(PILOT, ["cli", "synapse"], "high").weighted;
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
    const full = estimate(TASKS.map((t) => t.id), ["cli", "synapse"], "mid");
    expect(full.weighted).toBeGreaterThan(mid);
    expect(full.weighted).toBeCloseTo(full.runners.reduce((a, r) => a + r.weighted, 0), 6);
    expect(full.tasks).toBe(TASKS.length);
  });
});
