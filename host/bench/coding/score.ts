import { addUsage, ZERO_USAGE, type AgentRun, type RunnerName, type Usage } from "./types";
import type { Verdict } from "./verify";

/** Relative input weights (the brief's; same as host/bench/compare/params.ts). Output is its own column. */
export const WEIGHTS = { fresh: 1.0, cacheWrite: 1.25, cacheRead: 0.1 } as const;

export function weightedInput(u: Usage): number {
  return u.fresh * WEIGHTS.fresh + u.cacheWrite * WEIGHTS.cacheWrite + u.cacheRead * WEIGHTS.cacheRead;
}

// Bug 170: "couldn't / unable to / failed to" count only when the agent says them of ITSELF. A
// final message that explains what the OLD code couldn't do ("the old approach couldn't handle
// newlines") is a claim of a fix, and reading it as giving up hid a real false done (T01).
const GAVE_UP_SELF = /\b(I|we)( really| just| still)? (couldn'?t|could not|can'?t|cannot|was unable to|were unable to|wasn'?t able|weren'?t able|was not able|were not able|failed to|am unable to)\b/i;
const GAVE_UP = /\b(unable to (fix|find|reproduce|resolve|get)|not (yet )?(fixed|resolved|done|complete|working)|still fail(s|ing)?|gave up|blocked|need (your|more) (input|information|guidance))\b/i;
const CLAIM = /\b(fixed|done|implemented|complete[d]?|resolved|added|refactored|renamed|wrote|written|created|answered|all (\d+ )?tests pass|tests (now )?pass|passing)\b/i;

/**
 * Did the agent's final message claim the task was done? A deterministic keyword rule: any
 * give-up phrase wins; otherwise any completion word counts as a claim. It only feeds the
 * "false done" column (claimed done, hidden verification failed); it never decides success.
 */
export function claimsDone(text: string): boolean {
  if (!text.trim()) return false;
  if (GAVE_UP_SELF.test(text) || GAVE_UP.test(text)) return false;
  return CLAIM.test(text);
}

export interface ScoredRun extends Omit<AgentRun, "finalDir"> {
  success: boolean;
  checks: Verdict["checks"];
  weighted: number | null;
  claimedDone: boolean;
  falseDone: boolean;
}

export function scoreRun(run: AgentRun, verdict: Verdict): ScoredRun {
  const { finalDir: _dir, ...rest } = run;
  const claimedDone = claimsDone(run.finalText);
  return {
    ...rest,
    // A run stopped at its budget fails whatever state it left: the budget is part of the task (bug-log 88).
    success: verdict.pass && !run.budgetExceeded,
    checks: verdict.checks,
    weighted: run.usage ? weightedInput(run.usage) : null,
    claimedDone,
    falseDone: !(verdict.pass && !run.budgetExceeded) && claimedDone,
  };
}

export interface RunnerSummary {
  runner: RunnerName;
  tasks: number;
  successes: number;
  successRate: number;
  /** Sum over runs with known usage. */
  usage: Usage;
  weighted: number;
  calls: number;
  wallMs: number;
  interventions: number;
  failures: number;
  falseDone: number;
  /** falseDone / failures (0 when nothing failed). */
  falseDoneRate: number;
  timedOut: number;
  /** Runs whose usage could not be read: their tokens are missing from the totals. */
  unknownUsage: number;
  leakSuspect: number;
}

export function summarize(rows: ScoredRun[]): RunnerSummary[] {
  const runners = [...new Set(rows.map((r) => r.runner))].sort() as RunnerName[];
  return runners.map((runner) => {
    const rs = rows.filter((r) => r.runner === runner);
    const known = rs.filter((r) => r.usage);
    const usage = known.reduce((a, r) => addUsage(a, r.usage!), ZERO_USAGE);
    const successes = rs.filter((r) => r.success).length;
    const failures = rs.length - successes;
    const falseDone = rs.filter((r) => r.falseDone).length;
    return {
      runner,
      tasks: rs.length,
      successes,
      successRate: rs.length ? successes / rs.length : 0,
      usage,
      weighted: weightedInput(usage),
      calls: rs.reduce((a, r) => a + (r.calls ?? 0), 0),
      wallMs: rs.reduce((a, r) => a + r.wallMs, 0),
      interventions: rs.reduce((a, r) => a + r.interventions.length, 0),
      failures,
      falseDone,
      falseDoneRate: failures ? falseDone / failures : 0,
      timedOut: rs.filter((r) => r.timedOut).length,
      unknownUsage: rs.length - known.length,
      leakSuspect: rs.filter((r) => r.leakSuspect).length,
    };
  });
}
