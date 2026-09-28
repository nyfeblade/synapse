import type { ComputerPerception } from "@synapse/shared";

/** Live perception is shelved by the user (decisions.md 2026-09-21, pilot Live 0/4 vs Screenshots 2/4). The Live code
 *  stays dormant; this is the one switch, and nothing sets it. */
export const LIVE_PERCEPTION_ENABLED = false;

/** The effective "Computer perception". While Live is shelved every Bot runs Screenshots: a stored "live" (the Bot's own
 *  or the account's, from before the shelving) is kept on disk but read as Screenshots. */
export function perceptionMode(bot: { computerPerception?: ComputerPerception }, account: ComputerPerception | undefined): ComputerPerception {
  const chosen = bot.computerPerception ?? account ?? "screenshots";
  return chosen === "live" && !LIVE_PERCEPTION_ENABLED ? "screenshots" : chosen;
}

export const LIVE_SHELVED_MESSAGE = "Live computer perception is shelved; every Bot uses Screenshots.";

/** For Auto-review cards: a per-Bot resolver from element id to its last-seen label ("button \"Save\""). */
const labelers = new Map<string, (id: string) => string | null>();
export function registerLabeler(botId: string, fn: ((id: string) => string | null) | null): void {
  if (fn) labelers.set(botId, fn); else labelers.delete(botId);
}
export function elementLabel(botId: string | undefined, id: string): string | null {
  return botId ? (labelers.get(botId)?.(id) ?? null) : null;
}
