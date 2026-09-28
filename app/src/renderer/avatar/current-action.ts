import { STR, type BotSummary } from "@synapse/shared";

/**
 * Bug #55: hovering a Bot's avatar shows what it is doing right now. Built only from what the
 * host already sends in a BotSummary: `awaiting` (what it is waiting on the user for), `presence`
 * (the persona of the running tool) and `activity.detail` (the file, query or host the tool is on).
 * An idle Bot is doing nothing, so it has no action and no tooltip.
 */
export function currentActionLabel(bot: BotSummary): string | null {
  if (bot.awaiting) return bot.awaiting.reason;
  if (bot.presence === "idle") return bot.running ? STR.avatarAction.working : null;
  const word = STR.avatarAction[bot.presence];
  const detail = bot.activity?.detail?.trim();
  return detail ? `${word} · ${detail}` : word;
}
