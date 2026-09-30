import type { RunTrace } from "./trace";

/** Token counts for one run. `fresh` is uncached input. */
export interface Usage { fresh: number; cacheRead: number; cacheWrite: number; output: number }

export const ZERO_USAGE: Usage = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
export const addUsage = (a: Usage, b: Usage): Usage => ({
  fresh: a.fresh + b.fresh, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output,
});

/** cli: headless Claude Code; synapse: a Bot on the box; provider-loop: Synapse's own coding engine on a provider model. */
export type RunnerName = "cli" | "synapse" | "provider-loop";

/**
 * Anything the agent put in front of the (absent) human. Fixed policy, same for both runners:
 * questions and approvals are DECLINED, cards with no decline are SKIPPED (left unanswered), and a
 * Bot left waiting on the user with no way to decline is INTERRUPTED (its run ends there).
 */
export interface Intervention {
  kind: "question" | "approval" | "permission-denied" | "card" | "form" | "awaiting";
  detail: string;
  action: "declined" | "skipped" | "interrupted";
}

/** What a runner returns for one task. */
export interface AgentRun {
  taskId: string;
  runner: RunnerName;
  model: string;
  /** A local directory holding the repo exactly as the agent left it. */
  finalDir: string;
  /** The agent's final message(s) to the user, used only for the false-done check. */
  finalText: string;
  /** null when the runner could not read usage (e.g. killed before its result). */
  usage: Usage | null;
  /** Reported by the SDK; plan runs are not billed per token, so this is informational. */
  costUsd: number | null;
  /** Model calls: the SDK's num_turns, the same field for both runners. */
  calls: number | null;
  wallMs: number;
  timedOut: boolean;
  error?: string;
  interventions: Intervention[];
  sessionId?: string;
  /** The agent's tool inputs mentioned harness-private paths (hidden tests, reference solutions). */
  leakSuspect?: boolean;
  /** The run passed its per-task weighted-token budget and was stopped: it fails whatever state it left. */
  budgetExceeded?: boolean;
  /** Per-call trace (bug-log 75), from the CLI's stream or the Bot's session file; absent when unreadable. */
  trace?: RunTrace;
  notes: string[];
}
