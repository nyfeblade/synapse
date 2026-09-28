import type { BotSummary } from "@synapse/shared";

// Living Bots (bug 226), step 2: a work pose for what the Bot is doing right now, read from the
// presence stream the header's live chip and current-action.ts already use (`running`, `activity`,
// `presence`, `awaiting`), plus two short-lived events the renderer sees on the transcript stream
// (a tool that failed, a memory saved; living-events.ts). Pure: no clock, no DOM, zero tokens.

/** One readable pose per state. `work` is the generic working pose (a tool with no better match). */
export type LivingAct =
  | "idle" | "think" | "read" | "write" | "browse" | "run" | "work"
  | "needs-you" | "stuck" | "remember" | "rest";
export const LIVING_ACTS: readonly LivingAct[] = ["idle", "think", "read", "write", "browse", "run", "work", "needs-you", "stuck", "remember", "rest"];

/** How long a failed tool shows as stuck, and a memory save as remembering. */
export const STUCK_MS = 2400;
export const REMEMBER_MS = 2200;
/** An idle Bot with nothing new for this long rests (eyes closed, slow breaths); hover wakes it. */
export const REST_AFTER_MS = 2 * 60 * 60_000;

const READ = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "BashOutput", "mcp__bot__ExternalRead", "mcp__bot__SearchHistory", "mcp__bot__CheckSubagent"]);
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "TodoWrite", "mcp__bot__SendMessage", "mcp__bot__ReactToMessage"]);
const RUN = new Set(["Bash", "KillShell", "KillBash", "mcp__bot__Shell", "mcp__bot__ExternalShell", "mcp__bot__AwaitShell", "mcp__bot__AwaitExternalShell", "mcp__bot__CopyToBox", "mcp__bot__CopyFromBox", "mcp__bot__InstallPlugin"]);
const BROWSE = new Set(["mcp__bot__Browser", "mcp__bot__Screenshot", "mcp__bot__Look", "mcp__bot__MacApp", "mcp__bot__Mac"]);
const THINK = new Set(["Task", "Agent", "mcp__bot__Task", "mcp__bot__CodingAgent", "mcp__bot__MessageSubagent", "mcp__bot__SendToAgent", "mcp__bot__UpdateAgent", "mcp__bot__CreateAgent"]);
const REMEMBER = new Set(["mcp__bot__update_state"]);

/**
 * A tool name → its pose. Exact names first (the host's own tools and the CLI's), then MCP tools by
 * server (a browser or computer server browses, a memory server remembers) and by the verb in the
 * tool's own name; anything else is the generic `work` pose.
 */
export function toolAct(name: string | null | undefined): LivingAct {
  if (!name) return "work";
  if (READ.has(name)) return "read";
  if (WRITE.has(name)) return "write";
  if (RUN.has(name)) return "run";
  if (BROWSE.has(name)) return "browse";
  if (THINK.has(name)) return "think";
  if (REMEMBER.has(name)) return "remember";
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const tool = rest.join("__").toLowerCase();
    if (/browser|computer|playwright|puppeteer|chrome/i.test(server)) return "browse";
    if (/memory|remember/i.test(server)) return "remember";
    if (/(^|_)(browse|navigate|click|screenshot|snapshot)/.test(tool)) return "browse";
    if (/(^|_)(read|get|list|ls|search|find|fetch|query|look|view|show)/.test(tool)) return "read";
    if (/(^|_)(write|create|draft|edit|update|send|post|reply|append|set|compose|delete|rm)/.test(tool)) return "write";
    if (/(^|_)(run|exec|shell|build|test|deploy)/.test(tool)) return "run";
  }
  return "work";
}

/** The two short-lived events per Bot (epoch ms), from living-events.ts. */
export interface Transient { stuckAt?: number; rememberAt?: number }

type PoseBot = Pick<BotSummary, "running" | "presence" | "activity" | "awaiting" | "updatedAt" | "lastBotMessageAt">;

/** When an idle Bot starts resting: its newest sign of life plus REST_AFTER_MS. */
export function restAt(bot: Pick<BotSummary, "updatedAt" | "lastBotMessageAt">): number {
  return Math.max(bot.updatedAt || 0, bot.lastBotMessageAt || 0) + REST_AFTER_MS;
}

/**
 * The pose, in priority order: waiting on the user, a tool that just failed, a memory just saved,
 * the running tool (or thinking), then idle, which becomes rest after a long quiet.
 */
export function livingAct(bot: PoseBot, now: number, t: Transient = {}): LivingAct {
  if (bot.awaiting) return "needs-you";
  if (t.stuckAt !== undefined && now - t.stuckAt >= 0 && now - t.stuckAt < STUCK_MS) return "stuck";
  if (t.rememberAt !== undefined && now - t.rememberAt >= 0 && now - t.rememberAt < REMEMBER_MS) return "remember";
  if (bot.running) {
    if (bot.activity?.tool) return toolAct(bot.activity.tool);
    if (bot.activity?.thinking) return "think";
    switch (bot.presence) {
      case "thinking": case "loading": case "orbit": case "sending": return "think";
      case "searching": return "read";
      default: return "work";
    }
  }
  return now >= restAt(bot) ? "rest" : "idle";
}

/**
 * One lead at a time: the Bot doing the most important thing moves boldly; everyone else plays its
 * pose small. Waiting on the user leads (the longest wait first), then the open Bot while it works,
 * then the Bot that changed most recently among those working. null: nobody is doing anything.
 */
export function leadBot(bots: Record<string, Pick<BotSummary, "id" | "running" | "awaiting" | "updatedAt">>, activeId: string | null): string | null {
  let wait: { id: string; since: number } | null = null, run: { id: string; at: number } | null = null;
  for (const b of Object.values(bots)) {
    if (b.awaiting && (!wait || b.awaiting.since < wait.since)) wait = { id: b.id, since: b.awaiting.since };
    if (b.running && (!run || b.updatedAt > run.at)) run = { id: b.id, at: b.updatedAt };
  }
  if (wait) return wait.id;
  if (activeId && bots[activeId]?.running) return activeId;
  return run?.id ?? null;
}
