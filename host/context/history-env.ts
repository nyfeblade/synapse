import { LIMITS, contextWindow, historyCaps, type HistoryKeep } from "@synapse/shared";

/**
 * Token diet (2), the hard cap: the CLI's own auto-compact, which runs mid-turn when the context
 * reaches it. CLI 2.1.277 compacts at CLAUDE_CODE_AUTO_COMPACT_WINDOW minus ~33k (fake-API probe,
 * LIMITS.autoCompactBufferTokens), so the window is the cap plus that buffer. The idle cap is the
 * host's (Compactor). Switches that would turn compaction off never come in from a Bot's secrets.
 */
export function applyHistoryEnv(env: Record<string, string>, keep: HistoryKeep | undefined, model: string): void {
  delete env.DISABLE_AUTO_COMPACT;
  delete env.DISABLE_COMPACT;
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const { hardTokens } = historyCaps(keep, contextWindow(model));
  if (hardTokens !== null) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(hardTokens + LIMITS.autoCompactBufferTokens);
}
