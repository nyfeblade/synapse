import { SYNAPSE_PREFIX_LAZY } from "../compare/params";
import { taskUsage } from "../coding/estimate";
import { weightedInput } from "../coding/score";
import { addUsage, ZERO_USAGE, type Usage } from "../coding/types";
import { tokensOf, type Mode } from "./metrics";
import { taskById, type Difficulty } from "./tasks";

/**
 * Pre-run token estimate for the real computer-use bench (no dollar prices). Tags: [measured] read
 * off this repo's own measurements, [lab] an earlier bake-off (scripted policy, so only the
 * observation-size ratio is used, never its success numbers), [brief] docs/lab/computer-use-brief.md,
 * [inferred] our guess. The real run replaces all of it with measured rows.
 */

/** Tokens a single observation adds to the child's history. Screenshots: one WebP at ~1.4k input tokens
 *  [brief] + ~50 tokens of text. Live: the lab's 84% saving on observation tokens [lab]. */
export const OBS: Record<Mode, number> = { screenshots: 1_450, live: Math.round(1_450 * (1 - 0.84)) };

export const PROFILE = {
  /** Parent Bot per call: system 6,083 + tools 20,469 = 26,552 [measured: prompt-budget.test.ts, 2026-09-21]. */
  parentPrefix: SYNAPSE_PREFIX_LAZY.system + SYNAPSE_PREFIX_LAZY.tools,
  /** Launch the Task, wake on its report, reply (+1 spare) [inferred]. */
  parentCalls: 4,
  parentGrowth: 800,
  parentOutput: 250,
  /**
   * computerUse child per call, before its history: Claude Code preset ~3,636 [measured, prompt-budget.test.ts
   * header] + computer-use prompt ~350 [inferred] + Read 1,182 + fixed row 627 [measured, builtin-tools probe]
   * + Shell/AwaitShell ~900 [inferred] + the computer tools: Computer 2,876 chars ~1,438 vs Look/Act/Screenshot 1,169 chars
   * ~585 [measured: prompt-budget.test.ts "computerUse child", ~2.0 chars/token].
   */
  childPrefix: { screenshots: 3_636 + 350 + 1_182 + 627 + 900 + 1_438, live: 3_636 + 350 + 1_182 + 627 + 900 + 585 } as Record<Mode, number>,
  /** The model's tool call + a line of text per step [inferred]. */
  childActionTokens: 180,
  childOutput: 180,
  /** Child model calls per task, the same for both modes (acting by id does not obviously cut steps) [inferred]. */
  childCalls: { easy: 8, medium: 14, hard: 22 } as Record<Difficulty, number>,
  /** Live sends pictures only when it asks (Screenshot / fallback crops) [inferred]; Screenshots sends one per call. */
  liveImages: { easy: 0, medium: 1, hard: 2 } as Record<Difficulty, number>,
};
export const LEVELS = { mid: 1, high: 1.8 } as const;
export type Level = keyof typeof LEVELS;

export interface ModeEstimate { mode: Mode; calls: number; images: number; usage: Usage; weighted: number; tokens: number }
export interface CuEstimate { level: Level; tasks: number; modes: ModeEstimate[]; usage: Usage; weighted: number; tokens: number }

export function estimateCu(taskIds: string[], modes: Mode[], level: Level = "mid"): CuEstimate {
  const f = LEVELS[level];
  const per = modes.map((mode): ModeEstimate => {
    let usage = ZERO_USAGE, calls = 0, images = 0;
    for (const id of taskIds) {
      const d = taskById(id).difficulty;
      const n = Math.round(PROFILE.childCalls[d] * f);
      const child = taskUsage(n, { prefix: PROFILE.childPrefix[mode], growthPerCall: OBS[mode] + PROFILE.childActionTokens, outputPerCall: PROFILE.childOutput, extraCalls: 0, perMessageExtra: 0 });
      const parent = taskUsage(PROFILE.parentCalls, { prefix: PROFILE.parentPrefix, growthPerCall: PROFILE.parentGrowth, outputPerCall: PROFILE.parentOutput, extraCalls: 0, perMessageExtra: 400 });
      usage = addUsage(usage, addUsage(child, parent));
      calls += n + PROFILE.parentCalls;
      images += mode === "screenshots" ? n : Math.round(PROFILE.liveImages[d] * f);
    }
    return { mode, calls, images, usage, weighted: weightedInput(usage), tokens: tokensOf(usage) };
  });
  const usage = per.reduce((a, m) => addUsage(a, m.usage), ZERO_USAGE);
  return { level, tasks: taskIds.length, modes: per, usage, weighted: per.reduce((a, m) => a + m.weighted, 0), tokens: per.reduce((a, m) => a + m.tokens, 0) };
}

const M = (n: number) => `${(n / 1e6).toFixed(2)}M`;

export function renderCuEstimate(taskIds: string[], modes: Mode[]): string {
  const L = [`Estimate for ${taskIds.length} tasks x ${modes.join(" + ")} (tokens; weighted input = fresh + 1.25 x cache write + 0.1 x cache read):`, "",
    "| Level | Mode | Calls | Images | Cache read | Cache write | Output | Weighted input | All tokens |", "|---|---|---|---|---|---|---|---|---|"];
  for (const level of Object.keys(LEVELS) as Level[]) {
    const e = estimateCu(taskIds, modes, level);
    for (const m of e.modes) L.push(`| ${level} | ${m.mode} | ${m.calls} | ${m.images} | ${M(m.usage.cacheRead)} | ${M(m.usage.cacheWrite)} | ${M(m.usage.output)} | ${M(m.weighted)} | ${M(m.tokens)} |`);
    L.push(`| ${level} | **total** | ${e.modes.reduce((a, m) => a + m.calls, 0)} | ${e.modes.reduce((a, m) => a + m.images, 0)} | ${M(e.usage.cacheRead)} | ${M(e.usage.cacheWrite)} | ${M(e.usage.output)} | **${M(e.weighted)}** | **${M(e.tokens)}** |`);
  }
  L.push("", "Assumptions: Screenshots observation 1,450 tokens/step (brief: ~1.4k per image); Live observation = 16% of that (lab: -84%, scripted policy, so only the ratio is used);",
    `parent Bot ${PROFILE.parentPrefix} tokens/call x ${PROFILE.parentCalls} calls per task (measured prefix); child prefix ${PROFILE.childPrefix.screenshots} / ${PROFILE.childPrefix.live};`,
    "child calls per task easy 8 / medium 14 / hard 22 in both modes (inferred); prompt caching as in the coding bench (call 1 writes, later calls read). High = 1.8x calls.");
  return L.join("\n");
}
