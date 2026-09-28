import { describe, expect, it } from "vitest";
import { calibration, formatDiet2, formatTable, REAL_USER_RUNS, runDiet2, runWorkload, WORKLOADS } from "../../../bench/compare/report";
import type { Scale } from "../../../bench/compare/workload";

/**
 * The measurement run, outside npm test: `npm run bench:cost` (full) or `BENCH_COST=small npm run
 * bench:cost`. Prints one table per workload, a verdict line each, and the calibration against the
 * box's usage.db. Deterministic: no model calls, no clock, seeded draws.
 */
const scale = process.env.BENCH_COST as Scale | undefined;

describe.skipIf(!scale)("token-cost comparison run", () => {
  it(`replays every workload through every policy at scale ${scale}`, () => {
    const out: string[] = [
      "Tokens are INPUT tokens on the main model (fresh + cache write + cache read) unless marked. wtd = cost-weighted",
      "input: fresh 1.0, cache write 1.25 (5 min) / 2.0 (1 h), cache read 0.1. out = output tokens. helper = Haiku 4.5 /",
      "gemini-2.5-flash tokens (in + out), a different, cheaper model: never blended. task = one session (~5 messages).",
    ];
    for (const spec of WORKLOADS) {
      const { conv, rows } = runWorkload(spec, scale!);
      out.push("", formatTable(spec.name, conv, rows));
    }
    for (const spec of WORKLOADS) {
      const { conv, rows } = runDiet2(spec, scale!);
      out.push("", formatDiet2(spec.name, conv, rows));
    }
    const c = calibration();
    out.push(
      "", "## Calibration: SYNAPSE_TODAY vs the box's usage.db (user runs, last 2 days)",
      `real      n=${REAL_USER_RUNS.n}  cache read med ${REAL_USER_RUNS.cacheRead.median} p90 ${REAL_USER_RUNS.cacheRead.p90}  output med ${REAL_USER_RUNS.output.median} p90 ${REAL_USER_RUNS.output.p90}`,
      `predicted n=${c.predicted.n}  cache read med ${c.predicted.cacheRead.median} p90 ${c.predicted.cacheRead.p90}  output med ${c.predicted.output.median} p90 ${c.predicted.output.p90}`,
      `error %   cache read med ${c.errorPct.cacheReadMedian}  p90 ${c.errorPct.cacheReadP90}  output med ${c.errorPct.outputMedian}  p90 ${c.errorPct.outputP90}`,
    );
    process.stdout.write(`${out.join("\n")}\n`);
    expect(Math.abs(c.errorPct.cacheReadMedian)).toBeLessThan(25);
    expect(Math.abs(c.errorPct.cacheReadP90)).toBeLessThan(25);
  }, 600_000);
});
