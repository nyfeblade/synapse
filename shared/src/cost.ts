/**
 * Cost dashboard and budgets (cost-dashboard branch). Every dollar figure here is API-EQUIVALENT: what
 * the same tokens would cost at Anthropic's published API prices, as the SDK reports it per run
 * (host/usage/usage-store.ts, per-run accounting fixed by bug 59). With the Anthropic API key (the only sign-in)
 * they are what the account is billed.
 */

export type UsageRange = "day" | "week" | "month";
export type BudgetPeriod = "day" | "month";
export type BudgetUnit = "usd" | "tokens";
/** What happens at 100%: an approval card first, or a hard pause until the period resets. */
export type BudgetAction = "ask" | "pause";

export interface BudgetLimit { period: BudgetPeriod; unit: BudgetUnit; limit: number }
/** One scope's budget: any mix of a daily and a monthly limit, a warning threshold, and the 100% action. */
export interface BudgetPolicy { limits: BudgetLimit[]; warnPct: number; onLimit: BudgetAction }
export interface BudgetsConfig { account: BudgetPolicy | null; bots: Record<string, BudgetPolicy> }

/** What the next piece of work is expected to cost. Absent fields are estimated from recent runs. */
export interface BudgetEstimate { usd?: number; tokens?: number }

export type BudgetScope = "account" | "bot" | "task";
export interface BudgetHit {
  scope: BudgetScope;
  botId: string | null;
  period: BudgetPeriod | "task";
  unit: BudgetUnit;
  limit: number;
  /** Spent in the period so far (in `unit`). */
  spent: number;
  /** The estimate for the next piece of work (in `unit`). */
  estimate: number;
  pct: number;
  /** When the period resets (ms); null for a task alert. */
  resetsAt: number | null;
  /** Stable id of this (scope, period, limit) state; approveBudget takes it. */
  key: string;
}
/** `ok`: go. `warn`: go, past the warning threshold. `ask`: get the user's OK first. `pause`: do not run. */
export type BudgetVerdict = "ok" | "warn" | "ask" | "pause";
export interface BudgetDecision { verdict: BudgetVerdict; hit: BudgetHit | null; message: string | null }

export interface BudgetStatusRow extends BudgetLimit { scope: "account" | "bot"; botId: string | null; name: string; spent: number; pct: number; resetsAt: number; onLimit: BudgetAction; warnPct: number }
export interface TaskAlertView { botId: string; name: string; limitUsd: number; spentUsd: number; since: number }
export interface BudgetsView { config: BudgetsConfig; status: BudgetStatusRow[]; taskAlerts: TaskAlertView[] }

export interface UsageTotals { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; tokens: number; usd: number; runs: number }
export interface UsagePoint { start: number; usd: number; tokens: number }
export interface UsageBotTotals extends UsageTotals { botId: string; name: string }
export type UsageTaskKind = "conversation" | "routine" | "background";
export interface UsageTaskRow { key: string; label: string; kind: UsageTaskKind; runs: number; usd: number; tokens: number }
export interface UsageRunLink { chatId: string; entryId: string }
export interface UsageTopRun { requestId: string; botId: string; name: string; label: string; startedAt: number; usd: number; tokens: number; link: UsageRunLink | null }
/** What the Mac key proxy reads off one Messages API answer's `usage` (recordMacUsage). */
export interface MacMeteredUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens?: number; webSearchRequests?: number }
/** Settings → Usage "API spend": dollars from usage.db today / this week / this month. */
export interface SpendFigures { today: number; week: number; month: number }
export interface SpendSummary extends SpendFigures { bots: (SpendFigures & { botId: string; name: string })[] }

/** "A typical hosted agent's overhead would have been about $Y": from the cost simulator, an estimate, never a measurement. */
export interface CostComparison {
  monthUsd: number;
  /** Low / mid / high: the simulator's hosted-agent variants over its modeled workloads, scaled to this month's dollars. */
  lowUsd: number; midUsd: number; highUsd: number;
  /** How many times our modeled cost the hosted-agent policy costs on the same workloads (mid). */
  ratioMid: number;
  basis: string;
}

export interface UsageDashboardView {
  range: UsageRange;
  botId: string | null;
  start: number;
  end: number;
  /** API spend today / this week / this month. */
  spend: SpendSummary;
  totals: UsageTotals;
  series: UsagePoint[];
  bots: UsageBotTotals[];
  tasks: UsageTaskRow[];
  top: UsageTopRun[];
  comparison: CostComparison | null;
  budgets: BudgetsView;
}

type None = Record<string, never>;
declare module "./gateway" {
  interface GatewayCommands {
    getUsageDashboard: { args: { range: UsageRange; botId?: string | null }; result: UsageDashboardView };
    getBudgets: { args: None; result: BudgetsView };
    /** `botId` null = the account-wide budget; `policy` null removes it. */
    setBudget: { args: { botId: string | null; policy: BudgetPolicy | null }; result: BudgetsView };
    /** The user's OK on an approval card: this budget state may continue for the rest of its period. */
    approveBudget: { args: { botId: string; key?: string }; result: BudgetsView };
    /** Remove a "tell me before you spend more than X" alert from the dashboard. */
    clearTaskAlert: { args: { botId: string }; result: BudgetsView };
    /** Once a key is saved: a monthly budget, pre-filled from the last 30 days. */
    getBudgetPrompt: { args: None; result: { show: boolean; suggestedUsd: number } };
    dismissBudgetPrompt: { args: None; result: None };
    /** The monthly budget prompt: merges a monthly $ limit into the account policy, keeping the rest of it. */
    setMonthlyBudget: { args: { usd: number }; result: BudgetsView };
    /** The Mac's claude, before each run: whether the host has a key, the budget's answer, and the Savings cache TTL. */
    macClaudeAuth: { args: { botId: string }; result: import("./mac-sandbox").MacClaudeAuth };
    /** The Mac key proxy's metered usage for one model call (priced on the host at list price). */
    /**
     * The Mac key proxy's metered usage for one model call (priced on the host at list price). `cacheWrite1hTokens` is the
     * part of cacheWriteTokens written with the 1-hour TTL (usage.cache_creation.ephemeral_1h_input_tokens, 2x input);
     * `webSearchRequests` is usage.server_tool_use.web_search_requests ($10 per 1,000).
     */
    recordMacUsage: { args: { botId: string; model: string; usage: MacMeteredUsage }; result: None };
  }
}

/** Budget copy (host cards, tray and composer errors). Kept here so host and app say the same thing. */
export const STR_COST = {
  /** Real dollars billed to the API key (list price), no longer "API-equivalent". */
  apiCost: "API cost",
  apiSpend: "API spend",
  today: "Today",
  thisWeek: "This week",
  thisMonth: "This month",
  monthlyBudget: "Monthly budget",
  notNow: "Not now",
  amountInvalid: "Enter an amount greater than 0.",
  macSpendRefused: "The spend budget is reached, so claude wasn't run on this Mac. Ask the user to raise it in Settings → Usage.",
  save: "Save",
  usageTitle: "Usage",
  budgetAskTitle: "Budget check",
  budgetContinue: "Continue",
  budgetKeepPaused: "Not now",
  budgetOpenSettings: "Budgets",
  // UI-controls pass (2026-09-29): thousands separators and never "$NaN" ("$1,234.50", not "$1234.50").
  money: (usd: number) => (!Number.isFinite(usd) ? "—" : usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
  amount: (unit: BudgetUnit, n: number) => (unit === "usd" ? STR_COST.money(n) : `${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : Math.round(n)} tokens`),
  periodWord: (p: BudgetPeriod | "task") => (p === "day" ? "daily" : p === "month" ? "monthly" : "task"),
  whose: (h: { scope: BudgetScope }, name: string) => (h.scope === "account" ? "Your account" : name),
  /** "Scout is at $4.90 of its $5.00 daily budget. This is estimated at about $0.18." */
  hitLine: (h: BudgetHit, name: string) => {
    const who = STR_COST.whose(h, name);
    const lim = h.scope === "task"
      ? `${who} has spent ${STR_COST.amount(h.unit, h.spent)} on this task; you asked to be told before it passes ${STR_COST.amount(h.unit, h.limit)}`
      : `${who} is at ${STR_COST.amount(h.unit, h.spent)} of its ${STR_COST.amount(h.unit, h.limit)} ${STR_COST.periodWord(h.period)} budget`;
    const est = h.estimate > 0 ? ` The next step is estimated at about ${STR_COST.amount(h.unit, h.estimate)}.` : "";
    return `${lim}.${est}`;
  },
  askQuestion: (h: BudgetHit, name: string) => `${STR_COST.hitLine(h, name)} Continue?`,
  pausedLine: (h: BudgetHit, name: string) => `${STR_COST.hitLine(h, name)} Paused until the budget resets; raise it in Settings → Usage to continue now.`,
  warnTitle: (h: BudgetHit, name: string) => `${STR_COST.whose(h, name)} has used ${Math.round(h.pct)}% of ${h.scope === "account" ? "the account's" : "its"} ${STR_COST.periodWord(h.period)} budget`,
  routineHeld: (routine: string) => `The scheduled run “${routine}” was held.`,
} as const;
