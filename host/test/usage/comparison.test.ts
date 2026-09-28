import { describe, expect, it } from "vitest";
import { hostedAgent, synapseShipped } from "../../bench/compare/params";
import { WORKLOADS } from "../../bench/compare/report";
import { simulate } from "../../bench/compare/simulate";
import { buildConversation } from "../../bench/compare/workload";
import { comparisonRatios, costComparison, HELPER_PRICE_RATIO, OUTPUT_PRICE_RATIO } from "../../usage/comparison";
import { REFERENCE_NAME } from "../../../scripts/public-scan";

describe("cost comparison card (an estimate from the cost simulator)", () => {
  it("is nothing to show before any spend", () => {
    expect(costComparison(0)).toBeNull();
  });

  it("scales this month's dollars by the simulator's hosted-agent / Synapse ratio, low ≤ mid ≤ high", () => {
    const c = costComparison(10)!;
    const r = comparisonRatios();
    expect(c.monthUsd).toBe(10);
    expect(c.lowUsd).toBeCloseTo(10 * r.low, 2);
    expect(c.midUsd).toBeCloseTo(10 * r.mid, 2);
    expect(c.highUsd).toBeCloseTo(10 * r.high, 2);
    expect(c.lowUsd).toBeLessThanOrEqual(c.midUsd);
    expect(c.midUsd).toBeLessThanOrEqual(c.highUsd);
    expect(c.basis).toMatch(/estimate/i);
    expect(c.basis).toMatch(/modeled/i);
    expect(c.basis).not.toMatch(REFERENCE_NAME); // user-visible copy never names a competitor
  });

  it("the mid ratio is the simulator's own number: the hosted agent mid vs what ships, same workloads, same prices, helper calls included", () => {
    // Recomputed here by hand from the simulator so the card can never drift from it.
    const cost = (p: ReturnType<typeof hostedAgent>) => WORKLOADS.reduce((s, w) => {
      const r = simulate(buildConversation(w, "small"), p);
      return s + r.messages.reduce((a, m) => a + m.weighted + OUTPUT_PRICE_RATIO * m.outEq + HELPER_PRICE_RATIO * (m.helper.input + OUTPUT_PRICE_RATIO * m.helper.output), 0);
    }, 0);
    const shipped = synapseShipped({ noBash: true, upFront: true, memBatch: 3, cap: 150_000 });
    expect(comparisonRatios().mid).toBeCloseTo(cost(hostedAgent("mid")) / cost(shipped), 6);
  });
});
