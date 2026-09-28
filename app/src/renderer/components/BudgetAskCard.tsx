import { useState } from "react";
import { STR_COST } from "@synapse/shared";
import { openUsageFor } from "../usage/dashboard-store";

/**
 * cost-dashboard: the host's "this would pass a budget" question for the user's own message, shaped like
 * the chat's approval cards. Continue approves the budget for the rest of its period and resends.
 */
export function BudgetAskCard({ message, onContinue, onCancel, botId }: { message: string; onContinue(): Promise<void>; onCancel(): void; botId?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="group" aria-label={STR_COST.budgetAskTitle} className="budget-ask">
      <span className="budget-ask-title">{STR_COST.budgetAskTitle}</span>
      <span>{message}</span>
      <div className="budget-ask-actions">
        <button type="button" className="btn-outline small" onClick={() => openUsageFor(botId ?? null)}>{STR_COST.budgetOpenSettings}</button>
        <button type="button" className="btn-outline small" onClick={onCancel}>{STR_COST.budgetKeepPaused}</button>
        <button type="button" className="btn-primary" disabled={busy} aria-busy={busy || undefined}
          onClick={() => { setBusy(true); void onContinue().finally(() => setBusy(false)); }}>{STR_COST.budgetContinue}</button>
      </div>
    </div>
  );
}
