import { ENGINEERING_MODE_EXTRA_TOKENS } from "@synapse/shared";
import { SYNAPSE_PREFIX_LAZY } from "../compare/params";
import { weightedInput } from "./score";
import { sessionsFor, taskById, type Difficulty } from "./suite";
import { addUsage, ZERO_USAGE, type RunnerName, type Usage } from "./types";

/**
 * Pre-run cost estimate, in tokens (no dollar prices: plan runs are not billed per token). Tags as
 * in host/bench/compare/params.ts: [measured] read off a real run, [documented] in code or docs,
 * [inferred] our estimate, run low/mid/high. A real pilot replaces all of this with measured rows.
 */

export interface CallProfile {
  /** Tokens every call carries before the conversation: system prompt + tool schemas. */
  prefix: number;
  /** Conversation growth per model call: the tool call, its result, the model's text [inferred]. */
  growthPerCall: number;
  outputPerCall: number;
  /** Calls beyond the coding work (the Bot's SendMessage reply). */
  extraCalls: number;
  /** Per-user-message hook text (reminders, envelopes). */
  perMessageExtra: number;
}

export const PROFILES: Record<RunnerName, CallProfile> = {
  synapse: {
    // Fresh Bot, lazy tools: system 6,083 + tools 11,450 + MCP 7,463 + skills 1,556 = 26,552 per call
    // [measured: host/test/perf/prompt-budget.test.ts, 2026-09-21], + engineering mode's
    // ENGINEERING_MODE_EXTRA_TOKENS [measured, same test].
    prefix: SYNAPSE_PREFIX_LAZY.system + SYNAPSE_PREFIX_LAZY.tools + ENGINEERING_MODE_EXTRA_TOKENS,
    growthPerCall: 1_200,
    outputPerCall: 350,
    // Replies go through SendMessage: one more call per task [inferred].
    extraCalls: 1,
    // ~400 tokens of hook text per user message (compare/params.ts perMessageOverhead, calibrated on usage.db) [measured].
    perMessageExtra: 400,
  },
  cli: {
    // Claude Code's system tools 11,450 [measured, same CLI build] + its preset system prompt without
    // our Bot append, ~4,500 [inferred]; no MCP servers (--strict-mcp-config), no user skills.
    prefix: 11_450 + 4_500,
    growthPerCall: 1_200,
    outputPerCall: 350,
    extraCalls: 0,
    perMessageExtra: 0,
  },
};

/** Model calls per task by difficulty, mid case [inferred]; low x0.6, high x1.8. */
export const CALLS: Record<Difficulty, number> = { easy: 10, medium: 20, hard: 35 };
export const LEVELS = { low: { calls: 0.6, growth: 0.7 }, mid: { calls: 1, growth: 1 }, high: { calls: 1.8, growth: 1.6 } } as const;
export type Level = keyof typeof LEVELS;

/**
 * Claude Code puts a cache breakpoint on the last message, so (within the 5-minute TTL) call 1
 * writes its whole prompt and every later call reads the previous prompt and writes only what grew.
 * Fresh input is ~0 (usage.db median inputTokens 4 per run) [measured].
 */
export function taskUsage(calls: number, p: CallProfile): Usage {
  const first = p.prefix + p.perMessageExtra;
  let read = 0, write = 0;
  for (let i = 0; i < calls; i++) {
    if (i === 0) write += first;
    else { read += first + p.growthPerCall * (i - 1); write += p.growthPerCall; }
  }
  return { fresh: 0, cacheRead: read, cacheWrite: write, output: calls * p.outputPerCall };
}

export interface RunnerEstimate { runner: RunnerName; calls: number; usage: Usage; weighted: number }
export interface Estimate { level: Level; tasks: number; runners: RunnerEstimate[]; usage: Usage; weighted: number }

export function estimate(taskIds: string[], runners: RunnerName[], level: Level): Estimate {
  const ids = sessionsFor(taskIds).flat().map((t) => t.id);
  const L = LEVELS[level];
  const per = runners.map((runner) => {
    const base = PROFILES[runner];
    const p = { ...base, growthPerCall: base.growthPerCall * L.growth };
    let usage = ZERO_USAGE, calls = 0;
    for (const id of ids) {
      const n = Math.round(CALLS[taskById(id).difficulty] * L.calls) + p.extraCalls;
      calls += n;
      usage = addUsage(usage, taskUsage(n, p));
    }
    return { runner, calls, usage, weighted: weightedInput(usage) };
  });
  const usage = per.reduce((a, r) => addUsage(a, r.usage), ZERO_USAGE);
  return { level, tasks: ids.length, runners: per, usage, weighted: per.reduce((a, r) => a + r.weighted, 0) };
}

const M = (n: number) => `${(n / 1e6).toFixed(2)}M`;

export function renderEstimate(taskIds: string[], runners: RunnerName[]): string {
  const rows = (["low", "mid", "high"] as Level[]).map((l) => estimate(taskIds, runners, l));
  const lines = [`Estimate for ${rows[0]!.tasks} tasks x ${runners.join("+")} (tokens; weighted = fresh + 1.25 write + 0.1 read):`, ""];
  lines.push("| Level | Runner | Calls | Cache read | Cache write | Output | Weighted input |", "|---|---|---|---|---|---|---|");
  for (const e of rows) {
    for (const r of e.runners) lines.push(`| ${e.level} | ${r.runner} | ${r.calls} | ${M(r.usage.cacheRead)} | ${M(r.usage.cacheWrite)} | ${M(r.usage.output)} | ${M(r.weighted)} |`);
    lines.push(`| ${e.level} | **total** | ${e.runners.reduce((a, r) => a + r.calls, 0)} | ${M(e.usage.cacheRead)} | ${M(e.usage.cacheWrite)} | ${M(e.usage.output)} | **${M(e.weighted)}** |`);
  }
  return lines.join("\n");
}
