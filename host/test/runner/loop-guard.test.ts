import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../../brain/types";
import { errorSignature, LOOP_LIMITS, LoopGuard, type LoopTrip } from "../../runner/loop-guard";

/** A guard on a hand-driven clock, and a helper that runs one tool call through it. */
function rig() {
  let t = 1_000_000;
  const g = new LoopGuard(() => t);
  let n = 0;
  const call = (name: string, input: Record<string, unknown>, output: string, isError = false, afterMs = 500): LoopTrip | null => {
    t += afterMs;
    const id = `t${++n}`;
    g.event("b", { kind: "tool_start", toolUseId: id, name, input, messageId: `m${n}` });
    return g.event("b", { kind: "tool_end", toolUseId: id, name, isError, output });
  };
  const spend = (usd: number) => g.event("b", { kind: "spend", turnUsd: usd } as TurnEvent);
  return { g, call, spend, advance: (ms: number) => { t += ms; } };
}

describe("loop guard: true positives", () => {
  it("the same tool failing the same way N times in a row stops the Bot, with what the loop cost", () => {
    const { g, call, spend } = rig();
    g.turnStart("b", "user");
    const trips: (LoopTrip | null)[] = [];
    for (let i = 0; i < LOOP_LIMITS.sameErrorMax; i++) {
      spend(0.02 * (i + 1));
      trips.push(call("Bash", { command: "npm install" }, `npm ERR! code ENOTFOUND (attempt ${i + 1}, 0x${(i + 7).toString(16)}abcdef12)`, true));
    }
    expect(trips.slice(0, -1).every((x) => x === null)).toBe(true);
    const trip = trips.at(-1)!;
    expect(trip).toMatchObject({ kind: "same-error", step: "npm install", tries: LOOP_LIMITS.sameErrorMax });
    expect(trip.spentUsd).toBeCloseTo(0.08 - 0.02, 6);
  });

  it("similar errors (different numbers, ids, quoted values) count as the same failure", () => {
    expect(errorSignature("Error: connect ECONNREFUSED 127.0.0.1:5432 after 31ms")).toBe(errorSignature("Error: connect ECONNREFUSED 127.0.0.1:5433 after 7ms"));
    expect(errorSignature("file 'a.ts' not found")).toBe(errorSignature("file 'b.ts' not found"));
    expect(errorSignature("permission denied")).not.toBe(errorSignature("no such file"));
  });

  it("reading files in between doesn't hide the loop (reads aren't progress)", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    let trip: LoopTrip | null = null;
    for (let i = 0; i < LOOP_LIMITS.sameErrorMax && !trip; i++) {
      trip = call("Bash", { command: "make build" }, "make: *** [all] Error 2", true);
      if (!trip) call("Read", { file_path: `/src/f${i}.c` }, `contents ${i}`);
    }
    expect(trip?.kind).toBe("same-error");
  });

  it("the same command retried with no change returns the same result N times: stopped", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const trips = Array.from({ length: LOOP_LIMITS.sameCallMax }, () => call("Bash", { command: "git status" }, "nothing to commit, working tree clean"));
    expect(trips.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(trips.at(-1)).toMatchObject({ kind: "same-call", step: "git status", tries: LOOP_LIMITS.sameCallMax });
  });

  it("automatic turns that do work and fail, N in a row, stop the Bot", () => {
    const { g, call } = rig();
    let trip: LoopTrip | null = null;
    for (let i = 0; i < LOOP_LIMITS.noProgressTurnsMax; i++) {
      g.turnStart("b", "shell-done");
      call("Bash", { command: `deploy --try ${i}` }, "deploy failed: 503", true);
      trip = g.turnEnd("b", { error: false, aborted: false, toolCalls: 1, sentTexts: [], costUsd: 0.05 });
      if (i < LOOP_LIMITS.noProgressTurnsMax - 1) expect(trip).toBeNull();
    }
    expect(trip).toMatchObject({ kind: "no-progress", tries: LOOP_LIMITS.noProgressTurnsMax, spentUsd: 0.15 });
  });

  it("automatic turns that repeat the previous turn exactly (same calls, same results, same message) stop the Bot", () => {
    const { g, call } = rig();
    let trip: LoopTrip | null = null;
    // The first turn sets the pattern; each identical one after it is a turn with no progress.
    for (let i = 0; i <= LOOP_LIMITS.noProgressTurnsMax; i++) {
      g.turnStart("b", "reply-nudge");
      call("Bash", { command: "ls" }, "a b c");
      trip = g.turnEnd("b", { error: false, aborted: false, toolCalls: 2, sentTexts: ["Still checking."] });
    }
    expect(trip?.kind).toBe("no-progress");
  });
});

describe("loop guard: true negatives", () => {
  it("a flaky network retried with backoff (sleeps between tries) is not a loop", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const out: (LoopTrip | null)[] = [];
    for (const wait of [1, 2, 4, 8, 16]) {
      out.push(call("Bash", { command: "curl -sf https://api.example.com/health" }, "curl: (6) Could not resolve host: api.example.com", true));
      out.push(call("Bash", { command: `sleep ${wait}` }, ""));
    }
    out.push(call("Bash", { command: "curl -sf https://api.example.com/health" }, "ok"));
    expect(out.every((x) => x === null)).toBe(true);
  });

  it("a backoff by growing gaps alone (no sleep call) is not a loop either", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const gaps = [1_000, 2_000, 4_000, 8_000, 16_000];
    const out = gaps.map((ms) => call("WebFetch", { url: "https://status.example.com" }, "fetch failed: ETIMEDOUT", true, ms));
    expect(out.every((x) => x === null)).toBe(true);
  });

  it("even a backoff stops at its own, higher limit", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    let trip: LoopTrip | null = null;
    let tries = 0;
    while (!trip && tries < 50) {
      tries++;
      trip = call("Bash", { command: "curl -sf https://down.example.com" }, "curl: (7) Failed to connect", true);
      call("Bash", { command: "sleep 5" }, "");
    }
    expect(trip?.kind).toBe("same-error");
    expect(tries).toBe(LOOP_LIMITS.backoffErrorMax);
  });

  it("a test re-run after an edit is progress, even when the test fails the same way", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const out: (LoopTrip | null)[] = [];
    for (let i = 0; i < 12; i++) {
      out.push(call("Bash", { command: "npm test" }, "FAIL src/sum.test.ts ✕ adds (3 ms) Expected: 3 Received: 4", true));
      out.push(call("Edit", { file_path: "/src/sum.ts", old_string: `a + b + ${i}`, new_string: `a + b + ${i + 1}` }, "The file /src/sum.ts has been updated."));
    }
    expect(out.every((x) => x === null)).toBe(true);
  });

  it("polling a long job with a sleep before each check is not a loop", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const out: (LoopTrip | null)[] = [];
    for (let i = 0; i < 30; i++) {
      out.push(call("Bash", { command: "sleep 30" }, ""));
      out.push(call("Bash", { command: "gh run view 123 --json status" }, '{"status":"in_progress"}'));
    }
    // ...and the same poll with the sleep inside the command, or just a long gap between checks.
    for (let i = 0; i < 20; i++) out.push(call("Bash", { command: "sleep 20 && kubectl rollout status deploy/api" }, "Waiting for rollout to finish: 1 of 3 updated"));
    for (let i = 0; i < 20; i++) out.push(call("mcp__bot__AwaitShell", { id: "s1" }, "still running", false, 25_000));
    expect(out.every((x) => x === null)).toBe(true);
  });

  it("scheduled turns that repeat by design, and the user's own turns, never count as no-progress turns", () => {
    const { g, call } = rig();
    for (let i = 0; i < 10; i++) {
      g.turnStart("b", "routine");
      call("Read", { file_path: "/inbox.json" }, "[]");
      expect(g.turnEnd("b", { error: false, aborted: false, toolCalls: 1, sentTexts: [] })).toBeNull();
      g.turnStart("b", "user");
      call("Bash", { command: "false" }, "exit 1", true);
      expect(g.turnEnd("b", { error: true, aborted: false, toolCalls: 1, sentTexts: [] })).toBeNull();
    }
  });

  it("a turn that failed before doing anything (an API outage) spends nothing and doesn't count", () => {
    const { g } = rig();
    for (let i = 0; i < 10; i++) {
      g.turnStart("b", "ack-redrive");
      expect(g.turnEnd("b", { error: true, aborted: false, toolCalls: 0, sentTexts: [] })).toBeNull();
    }
  });

  it("the runner's own refusals (a steering hold) are not the Bot failing", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const out = Array.from({ length: 10 }, () => call("Bash", { command: "rm -rf build" }, "Not run: the user just sent you a message (in the note with this result). Read it first.", true));
    expect(out.every((x) => x === null)).toBe(true);
  });

  it("reset (Continue) starts every count over", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    for (let i = 0; i < LOOP_LIMITS.sameErrorMax - 1; i++) call("Bash", { command: "x" }, "boom", true);
    g.reset("b");
    expect(call("Bash", { command: "x" }, "boom", true)).toBeNull();
  });
});

describe("loop guard: a tight loop paced by the model's own call time", () => {
  it("still trips at the plain limit when each retry takes the same few seconds (no backoff)", () => {
    const { g, call } = rig();
    g.turnStart("b", "user");
    const out = Array.from({ length: LOOP_LIMITS.sameErrorMax }, () => call("Bash", { command: "pytest -x" }, "E   ModuleNotFoundError: No module named 'foo'", true, 4_000));
    expect(out.at(-1)?.kind).toBe("same-error");
  });
});
