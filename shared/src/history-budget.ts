import { LIMITS } from "./limits";

/**
 * Token diet (2): how much conversation a Bot keeps before it summarizes. Every model call re-reads
 * the kept history, so this is the biggest per-call cost a long-lived Bot has (Chief of Staff:
 * 145–190k re-read on every call). The 1M window stays for big single inputs; these caps are about
 * what piles up.
 */
export const HISTORY_KEEPS = ["standard", "more", "full"] as const;
export type HistoryKeep = (typeof HISTORY_KEEPS)[number];
export const DEFAULT_HISTORY_KEEP: HistoryKeep = "standard";
export function isHistoryKeep(x: unknown): x is HistoryKeep {
  return typeof x === "string" && (HISTORY_KEEPS as readonly string[]).includes(x);
}

/** idleTokens: the host compacts once the Bot is idle at or above it. hardTokens: the CLI compacts
 *  mid-task at it; null = the CLI's own default for the window. */
export interface HistoryCaps { idleTokens: number; hardTokens: number | null }

export function historyCaps(keep: HistoryKeep | undefined, window: number): HistoryCaps {
  const k = keep ?? DEFAULT_HISTORY_KEEP;
  if (k === "full") return { idleTokens: Math.round(window * LIMITS.idleCompactRatio), hardTokens: null };
  const idle = k === "more" ? LIMITS.historyMoreIdleTokens : LIMITS.historyIdleTokens;
  const hard = k === "more" ? LIMITS.historyMoreHardTokens : LIMITS.historyHardTokens;
  return { idleTokens: Math.min(idle, Math.round(window * LIMITS.selfSummaryRatio)), hardTokens: hard < window ? hard : null };
}

/** The Advanced setting's own words: what each choice keeps, and what it costs next to Standard. */
export function historyKeepLabel(keep: HistoryKeep, window = 1_000_000): string {
  const idle = historyCaps(keep, window).idleTokens;
  const k = `${Math.round(idle / 1000)}k`;
  if (keep === "standard") return `Standard: up to ${k} tokens`;
  const x = (idle / historyCaps("standard", window).idleTokens).toFixed(1).replace(/\.0$/, "");
  return `${keep === "more" ? "More" : "Full window"}: up to ${k} tokens, about ${x}× the tokens per message`;
}
