import type { CodingAgents } from "../coding/coding-agents";
import type { FollowupStore } from "../followups/store";
import type { LocalAsks } from "../local/asks";
import type { LocalBridge } from "../local/bridge";

/**
 * P5 review I12: Phase 5's part of the canonical delete order — cancel the Bot's coding agents, expire its
 * local-computer asks (and grants), kill its running Mac execs, and drop its follow-ups, dreaming and card state.
 */
export async function removeBotPhase5(botId: string, d: {
  agents: Pick<CodingAgents, "removeBot">; asks: Pick<LocalAsks, "forgetBot">; bridge: Pick<LocalBridge, "cancelBot" | "revokeGrants">;
  followups: Pick<FollowupStore, "dropBot">; dreamer: { forgetBot(botId: string): void }; cardIds: Map<string, { botId: string; entryId: string }>;
}): Promise<void> {
  d.agents.removeBot(botId);
  d.asks.forgetBot(botId);
  d.bridge.cancelBot(botId);
  d.bridge.revokeGrants(botId); // ruling (b): the Mac drops this Bot's per-Bot Always grants
  d.followups.dropBot(botId);
  d.dreamer.forgetBot(botId);
  for (const [k, v] of d.cardIds) if (v.botId === botId) d.cardIds.delete(k);
}
