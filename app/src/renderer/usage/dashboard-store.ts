import { create } from "zustand";
import type { BudgetPolicy, BudgetsView, UsageDashboardView, UsageRange } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { useUi } from "../store";

interface DashboardState {
  range: UsageRange;
  /** null = every Bot. Set by a Bot's header button before Settings → Usage opens. */
  botId: string | null;
  view: UsageDashboardView | null;
  error: string | null;
  load(): Promise<void>;
  setRange(r: UsageRange): void;
  setBot(botId: string | null): void;
  setBudget(botId: string | null, policy: BudgetPolicy | null): Promise<void>;
  clearTaskAlert(botId: string): Promise<void>;
}

/** An older host answers with something else (or nothing); the dashboard then shows an error, not a crash. */
function isDashboard(v: unknown): v is UsageDashboardView {
  const x = v as UsageDashboardView | null;
  return !!x && Array.isArray(x.series) && !!x.totals && Array.isArray(x.top) && !!x.budgets;
}

let seq = 0;
export const useDashboard = create<DashboardState>((set, get) => {
  const withBudgets = (b: BudgetsView) => set((s) => (s.view ? { view: { ...s.view, budgets: b } } : {}));
  return {
    range: "week",
    botId: null,
    view: null,
    error: null,
    load: async () => {
      const mine = ++seq;
      const { range, botId } = get();
      try {
        // In place: the section shows its own error and a retry, so the sidebar banner stays out of it.
        const v = await callQuiet("getUsageDashboard", { range, botId });
        if (mine !== seq) return; // a newer range / Bot pick already asked
        if (!isDashboard(v)) { set({ error: "This host has no usage dashboard yet. Update the box to see it." }); return; }
        set({ view: v, error: null });
      } catch (e) {
        if (mine === seq) set({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    setRange: (range) => { set({ range }); void get().load(); },
    setBot: (botId) => { set({ botId }); void get().load(); },
    setBudget: async (botId, policy) => {
      withBudgets(await call("setBudget", { botId, policy }));
      void get().load();
    },
    clearTaskAlert: async (botId) => {
      withBudgets(await call("clearTaskAlert", { botId }));
    },
  };
});

/** A Bot's header button: Settings → Usage, filtered to that Bot. */
export function openUsageFor(botId: string | null): void {
  useDashboard.setState({ botId });
  useUi.getState().openSettings("usage");
  void useDashboard.getState().load();
}
