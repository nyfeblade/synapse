import { describe, expect, it } from "vitest";
import { claimsDone, scoreRun, summarize, weightedInput, type ScoredRun } from "../../../bench/coding/score";
import type { AgentRun } from "../../../bench/coding/types";

const run = (o: Partial<AgentRun> = {}): AgentRun => ({
  taskId: "T01", runner: "cli", model: "m", finalDir: "/x", finalText: "Fixed it. All tests pass.",
  usage: { fresh: 10, cacheRead: 1000, cacheWrite: 200, output: 50 }, costUsd: null, calls: 4,
  wallMs: 1000, timedOut: false, interventions: [], notes: [], ...o,
});
const verdict = (pass: boolean) => ({ taskId: "T01", pass, checks: [{ name: "hidden tests", pass }] });

describe("weightedInput", () => {
  it("weighs fresh 1.0, cache write 1.25, cache read 0.1, and leaves output out", () => {
    expect(weightedInput({ fresh: 100, cacheWrite: 100, cacheRead: 100, output: 999 })).toBeCloseTo(100 + 125 + 10, 9);
    expect(weightedInput({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 })).toBe(0);
    expect(weightedInput({ fresh: 4, cacheWrite: 20_000, cacheRead: 400_000, output: 3_000 })).toBeCloseTo(4 + 25_000 + 40_000, 9);
  });
});

describe("claimsDone", () => {
  it.each([
    ["Fixed the off-by-one in daysBetween. All 58 tests pass.", true],
    ["Done — the refactor is complete and behaviour is unchanged.", true],
    ["I implemented importInvoices and added tests.", true],
    ["I couldn't get the tests to pass; the failure seems to be in vitest.", false],
    ["I was unable to find the cause.", false],
    ["The fix is not done yet: two tests still fail.", false],
    ["", false],
    ["Here is what I found in the code.", false],
    // Bug 170: describing the OLD code's limits is not the agent giving up (T01, 2026-09-23).
    ["Fixed parseCsv. The old approach couldn't handle newlines inside quotes. All 54 tests pass.", true],
    ["Rewrote the loader; the previous version failed to close the file. Tests pass.", true],
    ["We couldn't reproduce it, so nothing changed.", false],
    ["Tests still fail after my change.", false],
  ])("%s -> %s", (text, want) => expect(claimsDone(text)).toBe(want));
});

describe("scoreRun", () => {
  it("success comes from the verdict only, never from the claim", () => {
    const s = scoreRun(run({ finalText: "Everything is fixed." }), verdict(false));
    expect(s.success).toBe(false);
    expect(s.claimedDone).toBe(true);
    expect(s.falseDone).toBe(true);
  });
  it("a passing run is never a false done, and an honest failure is not either", () => {
    expect(scoreRun(run(), verdict(true)).falseDone).toBe(false);
    expect(scoreRun(run({ finalText: "I could not fix it." }), verdict(false)).falseDone).toBe(false);
  });
  it("carries the weighted input", () => {
    expect(scoreRun(run(), verdict(true)).weighted).toBeCloseTo(10 + 250 + 100, 9);
    expect(scoreRun(run({ usage: null }), verdict(true)).weighted).toBeNull();
  });
});

describe("summarize", () => {
  it("totals per runner, success rate, false-done rate over failures, and flags unknown usage", () => {
    const rows: ScoredRun[] = [
      scoreRun(run({ taskId: "T01", wallMs: 1000, calls: 4 }), verdict(true)),
      scoreRun(run({ taskId: "T02", wallMs: 3000, calls: 6, interventions: [{ kind: "question", detail: "?", action: "declined" }] }), verdict(false)),
      scoreRun(run({ taskId: "T03", finalText: "I could not do it", usage: null, calls: null }), verdict(false)),
      scoreRun(run({ runner: "synapse", taskId: "T01" }), verdict(true)),
    ];
    const [cli, syn] = summarize(rows);
    expect(cli!.runner).toBe("cli");
    expect(cli!.tasks).toBe(3);
    expect(cli!.successes).toBe(1);
    expect(cli!.successRate).toBeCloseTo(1 / 3, 9);
    expect(cli!.usage).toEqual({ fresh: 20, cacheRead: 2000, cacheWrite: 400, output: 100 });
    expect(cli!.weighted).toBeCloseTo(2 * 360, 9);
    expect(cli!.calls).toBe(10);
    expect(cli!.wallMs).toBe(5000);
    expect(cli!.interventions).toBe(1);
    expect(cli!.failures).toBe(2);
    expect(cli!.falseDone).toBe(1);
    expect(cli!.falseDoneRate).toBeCloseTo(0.5, 9);
    expect(cli!.unknownUsage).toBe(1);
    expect(syn!.runner).toBe("synapse");
    expect(syn!.successRate).toBe(1);
    expect(syn!.falseDoneRate).toBe(0);
  });
});
