import type { BotSettings } from "@synapse/shared";
import { STANDARD_BOT_BUILTIN_TOOLS } from "../brain/tool-policy";

/**
 * S1 of "Synapse coding better than the CLI": the LEAN ENGINEERING PROFILE (decisions.md 2026-09-21).
 * Everything here applies only while a Bot's engineering mode is ON; a standard Bot never reads it.
 * Target: an engineering Bot's per-call floor within ~2k tokens of the vanilla CLI's (pinned in
 * host/test/perf/prompt-budget.test.ts, measured by context-budget.probe.test.ts).
 */
export const isLean = (s: Pick<BotSettings, "engineeringMode">): boolean => !!s.engineeringMode;

/**
 * The Bot tools whose schemas load up front in engineering mode: replying, the coding agent, the
 * history search, and update_state (the Bot's own status/profile/memory/follow-up writes). Every other
 * mcp__bot__ tool drops alwaysLoad and waits behind the CLI's ToolSearch, like a connector's.
 */
export const ENGINEERING_UP_FRONT_TOOLS: readonly string[] = Object.freeze(["SendMessage", "CodingAgent", "SearchHistory", "update_state"]);

/**
 * The CLI's built-in skills (Claude Code 2.1.277, the probe's skills row) that are not about writing
 * code. In engineering mode they are listed by name only (skillOverrides "name-only"): the Skill tool
 * still finds and runs them, only their descriptions stop riding every call. The coding ones
 * (code-review, simplify, security-review, init, run) and every skill the Bot or user installed keep
 * their descriptions: an unlisted name is "on".
 */
export const NON_CODING_BUILTIN_SKILLS: readonly string[] = Object.freeze([
  "dataviz", "update-config", "keybindings-help", "fewer-permission-prompts", "loop", "schedule", "claude-api", "workflow-authoring",
]);

export type SkillListing = "on" | "name-only" | "user-invocable-only" | "off";

export function engineeringSkillOverrides(): Record<string, SkillListing> {
  return Object.fromEntries(NON_CODING_BUILTIN_SKILLS.map((n) => [n, "name-only" as const]));
}

/**
 * cost-diet-2 lever 3: THE EVERYDAY PROFILE's up-front bot tools (engineering mode OFF). Picked from
 * evidence, not taste: the tool_use counts of every live Bot session on the box (4 Bots, 51 typed user
 * turns, 2026-09-21; decisions.md). Rule: up front if used on >= 5% of user turns by >= 2 Bots, or if a
 * missed load costs quality rather than a ToolSearch call. SendMessage (84%, 4 Bots), GetMcpServerStatus
 * (33%, 2), SendToAgent (8%, 3), AuthenticateMcpServer (8%, 2), RestartMcpServers (8%, 2) by frequency;
 * Shell because it inherits built-in Bash's share (6%, 2 Bots) once lever 2 removes Bash; SearchHistory
 * because the recall benchmark's 0.219 -> 1.000 rests on the Bot searching unprompted. Capability-gated
 * names a Bot lacks are simply absent. Every other bot tool waits behind ToolSearch, names still listed.
 */
export const EVERYDAY_UP_FRONT_TOOLS: readonly string[] = Object.freeze([
  "SendMessage", "Shell", "SearchHistory", "SendToAgent", "GetMcpServerStatus", "AuthenticateMcpServer", "RestartMcpServers",
]);

export interface ProfileSpawnFields {
  upFrontBotTools?: string[];
  skillOverrides?: Record<string, SkillListing>;
  /** Absent = BOT_BUILTIN_TOOLS (engineering keeps Bash). */
  builtinTools?: string[];
}

/** The spawn-config fields each profile sets: lean engineering (mode ON) or everyday (mode OFF). */
export function leanSpawnFields(s: Pick<BotSettings, "engineeringMode">): ProfileSpawnFields {
  if (!isLean(s)) return { upFrontBotTools: [...EVERYDAY_UP_FRONT_TOOLS], builtinTools: [...STANDARD_BOT_BUILTIN_TOOLS] };
  return { upFrontBotTools: [...ENGINEERING_UP_FRONT_TOOLS], skillOverrides: engineeringSkillOverrides() };
}

/**
 * PINNED MEASUREMENT (2026-09-21, host/test/perf/context-budget.probe.test.ts "measures an engineering-mode
 * Bot against the CLI floor", Claude Code 2.1.277 = the SDK's bundled CLI, the CLI's own /context accounting,
 * no model call). Per-call tokens before a word of conversation. "CLI floor" = the vanilla CLI: its own
 * default tools and preset prompt, no setting sources, no MCP, in an empty git repo. Engineering Bot = a
 * fresh Bot, engineering mode ON, from services.spawnConfig. Both on the same model (counts differ by model).
 * Re-run the probe and update these when the prompt, the tool surface or the CLI version changes.
 */
export const LEAN_PROFILE_MEASURED = Object.freeze({
  date: "2026-09-21",
  cli: "2.1.277",
  /** The Bots' default model. */
  sonnet: {
    cliFloor: { systemPrompt: 2_156, systemTools: 11_557, skills: 2_074, mcpTools: 0, total: 15_787 },
    before: { systemPrompt: 4_928, systemTools: 5_219, skills: 2_074, mcpTools: 7_810, total: 20_031 },
    after: { systemPrompt: 4_928, systemTools: 6_732, skills: 561, mcpTools: 2_022, total: 14_243 },
  },
  /** The model the earlier probe runs used (the 26.6k figure). */
  haiku: {
    cliFloor: { systemPrompt: 7_033, systemTools: 20_254, skills: 1_556, mcpTools: 0, total: 28_843 },
    before: { systemPrompt: 6_248, systemTools: 11_450, skills: 1_556, mcpTools: 7_810, total: 27_064 },
    after: { systemPrompt: 6_248, systemTools: 12_583, skills: 423, mcpTools: 2_022, total: 21_276 },
  },
});

export interface MeasuredRow { systemPrompt: number; systemTools: number; skills: number; mcpTools: number; total: number }
/**
 * PINNED MEASUREMENT for the everyday profile (cost-diet-2 levers 2 + 3): context-budget.probe.test.ts
 * "measures an everyday Bot before and after" (CLI 2.1.277, the CLI's own /context, no model call). A
 * fresh standard Bot from services.spawnConfig; before = every bot tool up front + Bash.
 */
export const EVERYDAY_PROFILE_MEASURED = Object.freeze({
  date: "2026-09-21",
  cli: "2.1.277",
  models: {
    /** The Bots' default model. Bash is 1,484 here (System tools 3,203 -> 1,719); 33 bot tools, 26 deferred (5,738). */
    sonnet: {
      before: { systemPrompt: 4_902, systemTools: 3_203, skills: 2_074, mcpTools: 7_849, total: 18_028 },
      after: { systemPrompt: 4_902, systemTools: 1_719, skills: 2_074, mcpTools: 2_111, total: 10_806 },
    },
    /** Haiku 4.5 (the routed model, lever 1): Bash is 5,932 here, the 5,806 of builtin-tools.probe. */
    haiku: {
      before: { systemPrompt: 3_677, systemTools: 9_228, skills: 1_556, mcpTools: 7_849, total: 22_310 },
      after: { systemPrompt: 3_677, systemTools: 3_296, skills: 1_556, mcpTools: 2_111, total: 10_640 },
    },
  } as Record<string, { before: MeasuredRow; after: MeasuredRow }>,
  /** Up-front bot schemas, chars (wireBytes in prompt-budget.test.ts): measured 4,022 on a fresh Bot, plus headroom. */
  upFrontCharsCeiling: 4_400,
});

/** The S1 target: an engineering Bot's per-call floor at most this far above the CLI floor. */
export const LEAN_TARGET_OVER_CLI_TOKENS = 2_000;

/** A quiet gap this long starts a new task, so its first turn carries the clock again. */
export const ENGINEERING_TASK_IDLE_MS = 30 * 60_000;

/**
 * Engineering mode sends the clock on the first turn of a task only. A task starts on the first
 * engineering turn (the mode just turned on, or the host restarted), on a new session (compaction,
 * rollover, reset), or after ENGINEERING_TASK_IDLE_MS of quiet. Standard turns always carry it
 * (bug #50) and forget this Bot's state, so switching the mode back on starts a task.
 */
export class TaskClock {
  private last = new Map<string, { at: number; session: string | null }>();

  /** Called once per engineering turn as it is dispatched; true = this turn opens a task. */
  opensTask(botId: string, now: number, session: string | null): boolean {
    const p = this.last.get(botId);
    this.last.set(botId, { at: now, session });
    if (!p) return true;
    if (p.session !== null && p.session !== session) return true;
    return now - p.at >= ENGINEERING_TASK_IDLE_MS;
  }

  forget(botId: string): void {
    this.last.delete(botId);
  }
}

/**
 * Engineering mode's memory: turns are extracted in the same batches as everyday turns (cost-diet-2
 * lever 4: one helper call per EXTRACTION_BATCH memorable exchanges), and the episode is written once
 * when the session compacts instead of every LIMITS.episodeEveryTurns turns. The memory engine asks
 * this gate per Bot. (The S1 gap, facts stated in an engineering turn never saved, is closed.)
 */
export function leanMemoryGate(bots: { has(id: string): boolean; summary(id: string): { settings: BotSettings } }): (botId: string) => boolean {
  return (botId) => bots.has(botId) && isLean(bots.summary(botId).settings);
}
