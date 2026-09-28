import type { UsageView } from "@synapse/shared";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { UsageLadder } from "./ladder";
import type { UsageStore } from "./usage-store";

export function usageView(ctx: ModuleContext, usage: UsageStore, ladder: UsageLadder): UsageView {
  const budget = usage.budgetUsd();
  return {
    source: ctx.flags().usageSource, budgetUsd: budget,
    budgetPct: budget ? Math.round((usage.weekCostUsd() / budget) * 1000) / 10 : null, level: ladder.level(), limitedUntil: ladder.limitedUntil(),
    weekStart: usage.weekStart(), rows: usage.rows(), efficiency: usage.efficiency(), ...(usage.cacheStats ? { cache: usage.cacheStats() } : {}),
    ...(usage.purposes ? { byPurpose: usage.purposes() } : {}), ...(usage.costHistory ? { costHistory: usage.costHistory() } : {}),
    ...(usage.savings ? { savings: usage.savings() } : {}),
  };
}

export function createUsageModule(ctx: ModuleContext, o: { usage: UsageStore; ladder: UsageLadder }): HostModule {
  const publish = () => ctx.hub.publish({ channel: "usage", payload: usageView(ctx, o.usage, o.ladder) });
  return {
    name: "usage",
    observers: [o.usage, o.ladder, { onSettled: () => publish() }],
    handlers: {
      getUsage: () => usageView(ctx, o.usage, o.ladder),
      setWeeklyBudget: (a) => {
        o.usage.setBudgetUsd(typeof a.usd === "number" && Number.isFinite(a.usd) ? a.usd : null);
        o.ladder.evaluate();
        publish();
        return usageView(ctx, o.usage, o.ladder);
      },
    },
    wrapHandlers: (base) => ({
      dismissTray: async (a) => {
        const tray = ctx.trays.get(a.trayId);
        // Only this module's budget tray; Phase 4's spend-guard trays use the same action name.
        if (a.action === "resume-routines" && tray?.dedupeKey?.startsWith("budget:")) {
          o.ladder.resumeRoutines();
          ctx.trays.dismiss(a.trayId);
          publish();
          return {};
        }
        // A plain dismissal of one of the ladder's own trays has to stick, or the next settled turn re-raises it.
        if (!a.action) o.ladder.noteTrayDismissed(tray?.dedupeKey);
        return base.dismissTray!(a);
      },
    }),
  };
}
