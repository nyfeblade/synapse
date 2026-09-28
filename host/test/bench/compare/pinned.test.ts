import { describe, expect, it } from "vitest";
import { calibration, runWorkload, WORKLOADS, type Row } from "../../../bench/compare/report";

/**
 * The small, deterministic version of `npm run bench:cost`, pinned. The replay is seeded and makes no
 * model calls, so these numbers move only when a policy constant, the workload or the engine does —
 * and then this test says so. Update a pin only with the reason in the commit.
 */
const pick = (rows: Row[], name: string) => {
  const r = rows.find((x) => x.policy === name)!;
  return [r.msgMed, r.w30d, r.compactions];
};
const results = WORKLOADS.map((w) => runWorkload(w, "small").rows);

describe("token-cost comparison, small scale (pinned)", () => {
  it("pins [in/msg median, weighted in/30d, compactions] for the headline policies", () => {
    const got = results.map((rows) => Object.fromEntries(
      ["HOSTED_AGENT low", "HOSTED_AGENT mid", "HOSTED_AGENT high", "SYNAPSE_TODAY", "SYNAPSE_PLANNED all levers"].map((n) => [n, pick(rows, n)]),
    ));
    expect(got).toEqual(PINS);
  });

  it("ranks the levers sensibly: every planned lever is no worse than today, all together best", () => {
    for (const rows of results) {
      const w = (n: string) => rows.find((r) => r.policy === n)!.w30d;
      for (const l of ["standalone", "trim", "cap"]) expect(w(`SYNAPSE_PLANNED ${l}`), l).toBeLessThanOrEqual(w("SYNAPSE_TODAY"));
      expect(w("SYNAPSE_PLANNED all levers")).toBeLessThan(w("SYNAPSE_PLANNED cap"));
      expect(w("HOSTED_AGENT low")).toBeLessThan(w("HOSTED_AGENT high"));
    }
  });

  it("pins the calibration against the box's usage.db", () => {
    const c = calibration();
    expect(c.errorPct).toEqual(CALIBRATION_ERROR);
    expect(Math.abs(c.errorPct.cacheReadMedian)).toBeLessThan(25);
    expect(Math.abs(c.errorPct.cacheReadP90)).toBeLessThan(25);
  });
});

/** Per workload (casual, tool-heavy, long-lived): [in/msg median, weighted in/30d, compactions]. */
const PINS = [
  { "HOSTED_AGENT low": [164363.5, 13656368, 0], "HOSTED_AGENT mid": [184363.5, 15294368, 0], "HOSTED_AGENT high": [204363.5, 16932368, 0], "SYNAPSE_TODAY": [120632.5, 11548140, 0], "SYNAPSE_PLANNED all levers": [105344.5, 10101131, 0] },
  { "HOSTED_AGENT low": [700091.5, 24827816, 3], "HOSTED_AGENT mid": [737190.5, 25934880, 4], "HOSTED_AGENT high": [809234.5, 27361960, 4], "SYNAPSE_TODAY": [1575792, 59035952, 0], "SYNAPSE_PLANNED all levers": [626044.5, 22747680, 2] },
  { "HOSTED_AGENT low": [261881, 5602695, 3], "HOSTED_AGENT mid": [234482.5, 5883893, 3], "HOSTED_AGENT high": [301679, 6197024, 3], "SYNAPSE_TODAY": [628398.5, 12115672, 0], "SYNAPSE_PLANNED all levers": [261647.5, 5720512, 2] },
];
/** Predicted vs real, % error (cache-read median/p90 are the fitted targets; see report.ts). */
const CALIBRATION_ERROR = { cacheReadMedian: 16, cacheReadP90: -6.8, outputMedian: -50.4, outputP90: -0.8 };
