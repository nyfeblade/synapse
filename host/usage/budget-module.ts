import { STR_COST, type BudgetPolicy, type UsageDashboardView, type UsageRange } from "@synapse/shared";
import { credentialsReady } from "../auth/auth-env";
import type { TurnEvent } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { TurnSlot } from "../runner/turn-slot";
import type { Budgets } from "./budgets";
import { comparisonRatios, costComparison } from "./comparison";
import type { UsageDashboard } from "./dashboard";
import { monthStartMs } from "./periods";
import { parseSpendPhrase } from "./spend-phrase";
import { listCostUsd } from "./list-price";
import type { UsageStore } from "./usage-store";

const RANGES: readonly UsageRange[] = ["day", "week", "month"];

/** The last 30 days' spend rounded up to the next $5 (at least $5): a starting monthly budget the user can change. */
export function suggestMonthlyBudget(last30Usd: number): number {
  return Math.max(5, Math.ceil((Number.isFinite(last30Usd) ? last30Usd : 0) / 5) * 5);
}

/**
 * New-user walk, finding 7: one budget, the account's monthly $ limit. A weekly (soft) budget saved by an older build
 * becomes that limit (x52/12, to the cent) unless one is already set, and is then cleared.
 */
export function migrateWeeklyBudget(usage: Pick<UsageStore, "budgetUsd" | "setBudgetUsd">, budgets: Pick<Budgets, "config" | "setAccountMonthlyUsd">): void {
  const weekly = usage.budgetUsd();
  if (!weekly) return;
  const has = !!budgets.config().account?.limits.some((l) => l.period === "month" && l.unit === "usd");
  if (!has) budgets.setAccountMonthlyUsd(Math.round(((weekly * 52) / 12) * 100) / 100);
  usage.setBudgetUsd(null);
}

/** The one-message hint the Bot gets when the user's own words set or clear a task alert. */
export const spendHint = {
  set: (usd: number) => `Synapse set a spend alert from the user's words: the user will be asked before this task passes ${STR_COST.money(usd)}, and the alert ends when they say continue. Acknowledge it; no tool is needed.`,
  clear: "Synapse cleared this task's spend alert at the user's request.",
};

/**
 * The cost dashboard and budgets as a host module: the dashboard and budget commands, the budget gate on the
 * user's own messages, "tell me before you spend more than X" read from chat, and the bookkeeping that labels runs (routine / trigger name) and
 * links them to the chat message they produced.
 */
export function createBudgetModule(ctx: ModuleContext, o: { usage: UsageStore; budgets: Budgets; dashboard: UsageDashboard }): HostModule {
  let offVisible: (() => void) | null = null;
  const tz = () => ctx.settings.timeZone();

  const dashboard = (range: UsageRange, botId: string | null): UsageDashboardView => {
    const slice = o.dashboard.view(range, botId);
    return {
      // Dollars (API spend: today / week / month); there is no Claude plan (synapse-public).
      ...slice, spend: o.dashboard.spendSummary(),
      comparison: costComparison(o.dashboard.spent(null, monthStartMs(ctx.now(), tz()), "usd")),
      budgets: o.budgets.view(),
    };
  };

  const labelRun = {
    onEvent: (botId: string, e: TurnEvent) => {
      if (e.kind !== "dispatched") return;
      const slot = ctx.slot(botId) as TurnSlot | null;
      const w = slot?.context?.wake;
      if (slot && w?.kind === "routine") o.usage.noteTask(slot.requestId, { routineId: w.routineId, label: w.routineName });
    },
  };

  return {
    name: "budgets",
    observers: [labelRun],
    start: () => {
      migrateWeeklyBudget(o.usage, o.budgets);
      // The simulator runs once (~70 ms) and is memoized; do it off the first dashboard open.
      setTimeout(() => comparisonRatios(), 0).unref?.();
      offVisible = ctx.bots.onBeforeVisibleAppend((chatId, entry) => {
        if (entry.kind === "send-message" && entry.requestId && !entry.requestId.startsWith("host_")) o.usage.noteLink(entry.requestId, chatId, entry.id);
      });
    },
    stop: () => { offVisible?.(); offVisible = null; },
    handlers: {
      getUsageDashboard: (a) => {
        const range = RANGES.includes(a.range) ? a.range : "week";
        const botId = typeof a.botId === "string" && ctx.bots.has(a.botId) ? a.botId : null;
        return dashboard(range, botId);
      },
      getBudgets: () => o.budgets.view(),
      setBudget: (a) => {
        const botId = a.botId ?? null;
        if (botId !== null && !ctx.bots.has(botId)) throw new GatewayError("NOT_FOUND", "That Bot no longer exists.");
        o.budgets.setPolicy(botId, (a.policy ?? null) as BudgetPolicy | null);
        return o.budgets.view();
      },
      approveBudget: (a) => {
        if (!ctx.bots.has(a.botId)) throw new GatewayError("NOT_FOUND", "That Bot no longer exists.");
        o.budgets.approve(a.botId, typeof a.key === "string" ? a.key : undefined);
        return o.budgets.view();
      },
      // Security review minor 4: a spend cap by default. Once a key is saved the app asks once for a monthly budget,
      // pre-filled from the last 30 days rounded up; Save or Not now ends the prompt. At the budget the account policy
      // asks before new work; near it the ladder slows.
      getBudgetPrompt: () => {
        const has = !!o.budgets.config().account?.limits.some((l) => l.period === "month" && l.unit === "usd");
        const last30 = o.dashboard.spent(null, ctx.now() - 30 * 86_400_000, "usd");
        const show = credentialsReady() && !has && !ctx.settings.extra("budgetPromptDone", false);
        return { show, suggestedUsd: suggestMonthlyBudget(last30) };
      },
      dismissBudgetPrompt: () => { ctx.settings.setExtra("budgetPromptDone", true); return {}; },
      // Review fix: the monthly budget prompt merges its limit into the account policy instead of replacing it.
      setMonthlyBudget: (a) => {
        const usd = Number(a?.usd);
        if (!Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) throw new GatewayError("BAD_ARGS", STR_COST.amountInvalid);
        o.budgets.setAccountMonthlyUsd(Math.round(usd * 100) / 100);
        return o.budgets.view();
      },
      // Review fix (HIGH): the Bots' claude on the Mac asks here before each run. The coordinator gets whether the host
      // has a key (a stale Mac copy can't keep spending) and the budget's answer for this Bot. Spending never happens
      // without asking: anything but ok or warn is a no, with the budget's own message.
      macClaudeAuth: (a) => {
        const keySaved = credentialsReady();
        const botId = typeof a?.botId === "string" && ctx.bots.has(a.botId) ? a.botId : "host";
        const d = o.budgets.check(botId);
        const ok = d.verdict === "ok" || d.verdict === "warn";
        return { keySaved, spend: { ok, message: ok ? null : d.message ?? STR_COST.macSpendRefused }, promptCacheTtl: ctx.settings.savings().promptCacheTtl };
      },
      // Review fix (HIGH): what the Mac key proxy metered from the Messages API's usage, priced at list price, into
      // usage.db, so the spend view, the ladder and the monthly budget count it.
      recordMacUsage: (a) => {
        const u = a?.usage as unknown as Record<string, unknown> | undefined;
        const n = (k: string): number => {
          const v = u?.[k];
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 50_000_000) throw new GatewayError("BAD_ARGS", "Bad usage.");
          return Math.floor(v);
        };
        const opt = (k: string): number => (u?.[k] === undefined ? 0 : n(k));
        const usage = { inputTokens: n("inputTokens"), outputTokens: n("outputTokens"), cacheReadTokens: n("cacheReadTokens"), cacheWriteTokens: n("cacheWriteTokens") };
        // Review round 2 (P5): the 1-hour cache writes (part of cacheWriteTokens) and web searches, priced at their own rates.
        const extra = { cacheWrite1hTokens: Math.min(opt("cacheWrite1hTokens"), usage.cacheWriteTokens), webSearchRequests: opt("webSearchRequests") };
        const model = typeof a?.model === "string" && /^[\w.\[\]-]{1,80}$/.test(a.model) ? a.model : "unknown"; // priced at the highest known rate
        const botId = typeof a?.botId === "string" && ctx.bots.has(a.botId) ? a.botId : "host";
        o.usage.recordHelper(botId, "mac-claude", model, { ...usage, costUsd: listCostUsd(model, { ...usage, ...extra }) });
        return {};
      },
      clearTaskAlert: (a) => {
        o.budgets.setTaskAlert(a.botId, null);
        return o.budgets.view();
      },
    },
    wrapHandlers: (base) => ({
      // The user's own messages: a spent budget asks first (the composer shows an approval card and resends
      // on Continue) or, in pause mode, refuses with how to continue. A group's members spend on their own
      // turns; the group id itself only carries the account-wide budget.
      sendPrompt: async (a) => {
        const d = o.budgets.check(a.id);
        if (d.verdict === "pause") throw new GatewayError("BUDGET_PAUSED", d.message ?? "Paused by a budget.");
        // A live voice call cannot press Continue mid-sentence: it only stops for a pause.
        if (d.verdict === "ask" && !a.voice?.call) throw new GatewayError("BUDGET_ASK", d.message ?? "This would pass a budget. Continue?");
        // "Tell me before you spend more than $X": set after the check, so the message that sets it is not asked about it.
        const said = typeof a.text === "string" ? parseSpendPhrase(a.text) : null;
        if (!said) return base.sendPrompt!(a);
        o.budgets.setTaskAlert(a.id, said.kind === "set" ? said.usd : null);
        const prior = (a as typeof a & { hints?: string[] }).hints ?? [];
        return base.sendPrompt!({ ...a, hints: [...prior, said.kind === "set" ? spendHint.set(said.usd) : spendHint.clear] } as typeof a);
      },
    }),
  };
}
