import { describe, expect, it } from "vitest";
import { runRealEval } from "../../evals/routing/real-sdk";

/**
 * The ONE approved real routing eval ("Save usage"). Skipped unless EVAL_REAL=1; it spends the user's plan
 * (~460k input tokens estimated, capped at 600k). Run: `EVAL_REAL=1 npm run eval:routing`.
 */
describe.skipIf(process.env.EVAL_REAL !== "1")("routing eval (REAL)", () => {
  it("answers each routed prompt on both paths, judges them blind, and writes the report", async () => {
    const { result } = await runRealEval();
    expect(result.cases.length).toBe(40);
  }, 90 * 60_000);
});
