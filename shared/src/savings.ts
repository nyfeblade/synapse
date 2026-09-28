/**
 * saving-settings (Settings → Usage → Savings): Synapse's cost-saving choices as the user's own settings. Every default is
 * the behaviour that shipped before the settings existed, so nothing changes unless the user picks.
 */

/** "Keep conversations ready": the prompt-cache TTL of a Bot's own conversation (host/brain/cache-env.ts). */
export const PROMPT_CACHE_TTLS = ["1h", "5m"] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];

/**
 * "Call replies": which turns run at low effort while a call is live.
 * default: spoken turns only (the effort switches back for every typed / hidden turn, and each switch re-writes the
 *   history cache); fast: every turn while the call is live, typed ones too; match: the Bot's own effort on calls too.
 */
export const CALL_REPLIES = ["default", "fast", "match"] as const;
export type CallReplies = (typeof CALL_REPLIES)[number];

/** "Long-context model": on = Sonnet / Opus 5.x always spawn with [1m]; when-needed = standard context until the chat grows past the line. */
export const LONG_CONTEXT_MODES = ["on", "when-needed"] as const;
export type LongContextMode = (typeof LONG_CONTEXT_MODES)[number];

export interface SavingsSettings { promptCacheTtl: PromptCacheTtl; callReplies: CallReplies; longContext: LongContextMode }
export const DEFAULT_SAVINGS: SavingsSettings = { promptCacheTtl: "1h", callReplies: "default", longContext: "on" };

const isOneOf = <T extends string>(list: readonly T[]) => (x: unknown): x is T => typeof x === "string" && (list as readonly string[]).includes(x);
export const isPromptCacheTtl = isOneOf(PROMPT_CACHE_TTLS);
export const isCallReplies = isOneOf(CALL_REPLIES);
export const isLongContextMode = isOneOf(LONG_CONTEXT_MODES);

/**
 * "Only when needed" escalates a chat to [1m] once its context reaches this. The brief said about 180k, but the CLI
 * auto-compacts a 200k-window model at its window minus a ~33k buffer (≈167k; LIMITS.autoCompactBufferTokens,
 * CLI 2.1.277's resolveAutoCompactWindow clamps CLAUDE_CODE_AUTO_COMPACT_WINDOW to the model window). Escalating at 180k
 * would never happen: the chat would be summarized first, which is a quality change. 160k leaves room for the CLI's
 * check, and the brain also escalates mid-turn at the next tool call (ClaudeBrain.escalatingWiring).
 */
export const LONG_CONTEXT_ESCALATE_TOKENS = 160_000;

/** Whether a turn runs at the voice's low effort under the user's "Call replies" choice. */
export function voiceLowEffort(mode: CallReplies, t: { voiceCall: boolean; callLive: boolean }): boolean {
  if (mode === "match") return false;
  if (mode === "fast") return t.voiceCall || t.callLive;
  return t.voiceCall;
}

/** The measured figures (USD per week, API dollars, from the last 7 days of usage.db): what each non-default
 *  choice would have saved (negative: cost more) against today's behaviour. */
export interface SavingsEstimates { days: number; cacheTtl5m: number; callFast: number; callMatch: number; longContextWhenNeeded: number }

/** "≈ $8/week less", "≈ $0/week", "≈ $2/week more": whole dollars; the sign says which way. */
export function savingShort(usd: number): string {
  const n = Math.round(Math.abs(usd));
  if (n === 0) return "≈ $0/week";
  return `≈ $${n}/week ${usd > 0 ? "less" : "more"}`;
}
export const savingPhrase = (usd: number): string => `${savingShort(usd)} at your usage`;
/** One line for a setting: each non-default choice with its figure, "at your usage" once. */
export const savingsLine = (parts: [label: string, usd: number][]): string => `${parts.map(([l, u]) => `${l} ${savingShort(u)}`).join(" · ")} at your usage`;
