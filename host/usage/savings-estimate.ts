import { LIMITS, LONG_CONTEXT_ESCALATE_TOKENS, hasLongContextArm, type SavingsEstimates } from "@synapse/shared";

/**
 * saving-settings: the measured weekly figure each Savings choice shows (Settings → Usage → Savings), computed from the
 * last 7 days of the user's own runs in usage.db. API dollars (list price), like the rest of the Usage view. Each figure is
 * what the non-default choice would have saved (negative: cost more) against today's behaviour, on the same runs:
 *
 * - Keep conversations ready, 5 minutes: every cache write at 1.25x instead of 2x input, minus a re-write (1.25x instead
 *   of a 0.1x read) of the context a turn read after a 5–60 minute gap, which a 5-minute cache would have lost.
 * - Call replies: each effort switch on a warm process re-writes the history (2x instead of 0.1x). Today a switch happens
 *   at every spoken ↔ typed / hidden change; Fast on the whole call only at a call's start and end; Match the Bot never.
 * - Long-context model, only when needed: these models have no long-context premium (1M at standard pricing, claude-api
 *   models.md), and a chat past the line escalates to [1m] anyway, so the only difference is the one history re-write
 *   when a chat escalates (the model name changes).
 *
 * Rows written before usage.db recorded voice / callLive / ctxStart / ctxPeak (2026-09-25) are estimated: a voice turn
 * is a voice-delegate run; a call is live from a spoken turn or the voice's own call (voice-front, greetings) until its
 * wrap-up or 10 minutes of quiet; a run's context is its prompt tokens split over the requests its uncached input
 * implies (~2 tokens per request when nothing new came in).
 */
export interface SavingsRun {
  botId: string; source: string; purpose: string; model: string; startedAt: number; durationMs: number;
  inputTokens: number; cacheRead: number; cacheWrite: number;
  voice: number | null; callLive: number | null; ctxStart: number | null; ctxPeak: number | null;
}

const MIN = 60_000;
export const SAVINGS_WINDOW_DAYS = 7;
/** Runs just before the window still decide a gap or a switch for the window's first ones. */
export const SAVINGS_LOOKBACK_MS = 60 * MIN;
/** Prompt-token price multipliers [documented: claude-api prompt caching]. */
const MULT = { read: 0.1, write5m: 1.25, write1h: 2 } as const;
const TTL_5M = 5 * MIN;
const TTL_1H = 60 * MIN;
/** Historic rows: how long after the voice's last run a call counts as still live, absent a wrap-up. */
const CALL_QUIET_MS = 10 * MIN;
/** Historic rows: a run's context can't exceed where the CLI compacts a Standard-history Bot. */
const CONTEXT_CAP = LIMITS.historyHardTokens + LIMITS.autoCompactBufferTokens;

/** Input $ per million tokens, list price [documented: claude-api models.md]. Output isn't used: none of these choices changes it. */
export function inputUsdPerMTok(model: string): number {
  const m = model.replace(/\[1m\]$/, "");
  if (m.startsWith("claude-haiku")) return 1;
  if (m === "claude-sonnet-5") return 2;
  if (m === "claude-opus-5-5") return 4;
  if (m.startsWith("claude-opus")) return 5;
  if (m.startsWith("claude-fable")) return 10;
  return 2;
}
const price = (r: SavingsRun) => inputUsdPerMTok(r.model) / 1e6;

const isTurn = (r: SavingsRun) => r.purpose === "turn" && r.botId !== "host";
const isConversation = (r: SavingsRun) => (r.purpose === "turn" || r.purpose === "compaction") && r.botId !== "host";
const calledModel = (r: SavingsRun) => r.inputTokens + r.cacheRead + r.cacheWrite > 0;

/** The context a run started from (its first model call's prompt). */
function ctxStart(r: SavingsRun): number {
  if (r.ctxStart !== null && r.ctxStart !== undefined) return r.ctxStart;
  const requests = r.inputTokens <= 64 ? Math.max(1, Math.round(r.inputTokens / 2)) : 1;
  return Math.min(CONTEXT_CAP, (r.cacheRead + r.cacheWrite + r.inputTokens) / requests);
}
/** The largest context a run reached. A historic row only tells when its uncached input is the ~2 tokens per request of
 *  a run with nothing new in it (the request count is then known); otherwise it is unknown (null), never guessed high:
 *  a run of many requests would otherwise read as one huge one. */
function ctxPeak(r: SavingsRun): number | null {
  if (r.ctxPeak !== null && r.ctxPeak !== undefined) return r.ctxPeak;
  return r.inputTokens <= 64 ? ctxStart(r) : null;
}

function groupBy(rows: SavingsRun[], key: (r: SavingsRun) => string): SavingsRun[][] {
  const m = new Map<string, SavingsRun[]>();
  for (const r of rows) { const k = key(r); const g = m.get(k); if (g) g.push(r); else m.set(k, [r]); }
  return [...m.values()].map((g) => g.sort((a, b) => a.startedAt - b.startedAt));
}

/** Historic rows: whether a call was live for this Bot when the run started. */
function callLiveFn(rows: SavingsRun[]): (r: SavingsRun) => boolean {
  const byBot = groupBy(rows, (r) => r.botId);
  const marks = new Map<string, { at: number; end: boolean }[]>();
  for (const g of byBot) {
    marks.set(g[0]!.botId, g.flatMap((r): { at: number; end: boolean }[] => {
      if (r.purpose === "call-wrapup") return [{ at: r.startedAt, end: true }];
      if (r.source === "voice-delegate" || r.voice === 1 || r.purpose === "voice-front" || r.purpose === "call-greetings") return [{ at: r.startedAt, end: false }];
      return [];
    }));
  }
  return (r) => {
    if (r.callLive !== null && r.callLive !== undefined) return r.callLive === 1;
    let last: { at: number; end: boolean } | null = null;
    for (const m of marks.get(r.botId) ?? []) { if (m.at > r.startedAt) break; last = m; }
    return !!last && !last.end && r.startedAt - last.at <= CALL_QUIET_MS;
  };
}
const isVoice = (r: SavingsRun) => (r.voice !== null && r.voice !== undefined ? r.voice === 1 : r.source === "voice-delegate");

const cents = (n: number) => Math.round(n * 100) / 100 + 0;

export function estimateSavings(all: SavingsRun[], o: { since: number }): SavingsEstimates {
  const inWindow = (r: SavingsRun) => r.startedAt >= o.since;

  // Keep conversations ready: 5 minutes.
  let writes = 0;
  let rewrites = 0;
  for (const g of groupBy(all.filter((r) => isConversation(r) && calledModel(r)), (r) => `${r.botId}\u0000${r.model}`)) {
    g.forEach((r, i) => {
      if (!inWindow(r)) return;
      writes += r.cacheWrite * (MULT.write1h - MULT.write5m) * price(r);
      const prev = g[i - 1];
      if (!prev) return;
      const gap = r.startedAt - (prev.startedAt + prev.durationMs);
      if (gap >= TTL_5M && gap < TTL_1H) rewrites += Math.min(ctxStart(r), r.cacheRead) * (MULT.write5m - MULT.read) * price(r);
    });
  }

  // Call replies: the history re-writes each policy's effort switches cost.
  const live = callLiveFn(all);
  const policies = {
    default: (r: SavingsRun) => isVoice(r),
    fast: (r: SavingsRun) => isVoice(r) || live(r),
  };
  const switchCost = (low: (r: SavingsRun) => boolean) => {
    let usd = 0;
    for (const g of groupBy(all.filter((r) => isTurn(r) && calledModel(r)), (r) => r.botId)) {
      g.forEach((r, i) => {
        const prev = g[i - 1];
        if (!inWindow(r) || !prev || prev.model !== r.model) return;
        if (r.startedAt - (prev.startedAt + prev.durationMs) >= TTL_1H) return; // cold anyway: nothing to re-write
        if (low(prev) !== low(r)) usd += ctxStart(r) * (MULT.write1h - MULT.read) * price(r);
      });
    }
    return usd;
  };
  const today = switchCost(policies.default);

  // Long-context model: one re-write per chat that escalates (no long-context premium to save).
  let escalations = 0;
  for (const g of groupBy(all.filter((r) => isConversation(r) && hasLongContextArm(r.model.replace(/\[1m\]$/, ""))), (r) => r.botId)) {
    const first = g.find((r) => inWindow(r) && (ctxPeak(r) ?? 0) >= LONG_CONTEXT_ESCALATE_TOKENS);
    if (first) escalations += LONG_CONTEXT_ESCALATE_TOKENS * (MULT.write1h - MULT.read) * price(first);
  }

  return {
    days: SAVINGS_WINDOW_DAYS,
    cacheTtl5m: cents(writes - rewrites),
    callFast: cents(today - switchCost(policies.fast)),
    callMatch: cents(today),
    longContextWhenNeeded: cents(-escalations),
  };
}
