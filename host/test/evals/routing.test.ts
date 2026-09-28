import { describe, expect, it } from "vitest";
import { offline, realPlan } from "../../evals/routing/run";

/** cost-diet-2 lever 1: the routing quality harness, offline half. No hard case may ever route; what routes is counted. */
describe("routing eval (offline)", () => {
  it("routes no hard case, and most quick chat", () => {
    const r = offline();
    process.stdout.write(`routing eval offline: ${JSON.stringify({ ...r, realPlan: realPlan() })}\n`);
    expect(r.falseSimple).toEqual([]);
    expect(r.precision).toBe(1);
    expect(r.recall).toBeGreaterThanOrEqual(0.9);
  });
});
