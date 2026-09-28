import { useEffect, useRef, useState } from "react";
import { STR, STR5, STR_COST, modelLabel } from "@synapse/shared";
import { nativeCall } from "../../native";
import { BILLING_URLS, formatTokens, startUsageSync, useUsage } from "../../usage/store";
import { registerSectionBlock } from "./sections";
import { SavingsCard } from "./SavingsCard";
import { UsageDashboard } from "./UsageDashboard";

const open = (url: string) => void nativeCall("openExternal", { url });
/** Background calls are often fractions of a cent; "$0.00" would read as free. */
const usd = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);

export function UsageSection() {
  const { view, error, load, setBudget } = useUsage();
  const [mode, setMode] = useState<"none" | "fixed">(view?.budgetUsd ? "fixed" : "none");
  const [amount, setAmount] = useState(view?.budgetUsd ? String(view.budgetUsd) : "");
  const [invalid, setInvalid] = useState(false);
  const dirty = useRef(false);
  useEffect(() => startUsageSync(), []);
  // Fix round 1, finding 1: `view` starts null and is filled in asynchronously (load(), or a
  // later "usage" channel push), so mode/amount must re-sync to the current budgetUsd rather
  // than freezing at whatever the lazy useState initializer saw on first mount.
  useEffect(() => {
    setMode(view?.budgetUsd ? "fixed" : "none");
    setAmount(view?.budgetUsd ? String(view.budgetUsd) : "");
    setInvalid(false);
    dirty.current = false;
  }, [view?.budgetUsd]);
  // Hand-testing round, two defects in one field:
  //   * blur used to commit `Number(amount)` and fall back to `setBudget(null)`, so "abc", "0" or
  //     an empty box silently stored "no weekly budget" while the dropdown still read "Fixed";
  //   * blur was the only commit path, so closing Settings with Escape (which removes a focused
  //     input without ever firing blur) threw the typed amount away.
  // `commit` now validates, and runs on Enter, on blur and once more on unmount.
  const commit = () => {
    if (!dirty.current) return;
    const n = Number(amount.trim());
    if (!amount.trim() || !Number.isFinite(n) || n <= 0) { setInvalid(true); return; }
    dirty.current = false;
    setInvalid(false);
    if (n !== (view?.budgetUsd ?? null)) void setBudget(n);
  };
  const latestCommit = useRef(commit);
  useEffect(() => { latestCommit.current = commit; });
  useEffect(() => () => latestCommit.current(), []);
  if (!view) {
    // Pending and failed must not look the same: a bare heading over an empty pane was the single
    // most confusing thing in this modal when the box was down.
    return (
      <>
        <h3>{STR5.usageAndBilling}</h3>
        {error ? (
          <div className="settings-card">
            <span className="error" role="alert">{error}</span>
            <button type="button" className="btn-outline small" onClick={() => void load()}>{STR.retry}</button>
          </div>
        ) : <span className="muted">{STR.loading}</span>}
      </>
    );
  }
  return (
    <>
      <h3>{STR5.usageAndBilling}</h3>
      <div className="settings-card usage-card">
        {/* The API key is the only sign-in: no Claude plan; dollars are in the dashboard below, billing in the Console. */}
        <div className="settings-row">
          <span style={{ flexGrow: 1 }}>{STR_COST.apiSpend}</span>
          <button type="button" className="btn-outline small" onClick={() => open(BILLING_URLS.consoleBilling)}>{STR5.billing}</button>
        </div>
        <div className="divider" />
        <div className="settings-row">
          <span style={{ flexGrow: 1 }}>{STR5.weeklyBudget}</span>
          <select className="dropdown" aria-label={`Weekly budget: ${mode === "none" ? STR5.budgetNone : STR5.budgetFixed}`} value={mode}
            onChange={(e) => { const m = e.target.value as "none" | "fixed"; setMode(m); setInvalid(false); if (m === "none") { dirty.current = false; void setBudget(null); } }}>
            <option value="none">{STR5.budgetNone}</option>
            <option value="fixed">{STR5.budgetFixed}</option>
          </select>
        </div>
        {mode === "fixed" && (
          <>
            <div className="settings-row">
              <label htmlFor="budget-usd" style={{ flexGrow: 1 }}>{STR5.budgetAmount}</label>
              <input id="budget-usd" className="text-input narrow" inputMode="decimal" value={amount}
                aria-invalid={invalid || undefined} aria-describedby={invalid ? "budget-usd-error" : undefined}
                onChange={(e) => { setAmount(e.target.value); dirty.current = true; setInvalid(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
                onBlur={commit} />
            </div>
            {invalid && <span id="budget-usd-error" className="error" role="alert">{STR5.budgetInvalid}</span>}
          </>
        )}
      </div>

      <SavingsCard estimates={view.savings} />

      <h3>{STR5.thisWeekByBot}</h3>
      <div role="table" aria-label={STR5.thisWeekByBot} className="settings-card usage-table">
        <div role="row" className="usage-head">
          {[STR5.colBot, STR5.colModel, STR5.colTurns, STR5.colTokens, STR5.colCost].map((h) => <span key={h} role="columnheader">{h}</span>)}
        </div>
        {view.rows.map((r) => (
          <div role="row" key={r.botId} className="usage-row">
            <span role="cell">{r.name}</span>
            <span role="cell" className="muted-2">{modelLabel(r.model)}</span>
            <span role="cell">{r.turns}</span>
            <span role="cell">{formatTokens(r.tokens)}</span>
            <span role="cell">${r.costUsd.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {view.byPurpose && view.byPurpose.length > 0 && (
        <>
          <h3>{STR5.thisWeekByKind}</h3>
          <div role="table" aria-label={STR5.thisWeekByKind} className="settings-card usage-table by-kind">
            <div role="row" className="usage-head">
              {[STR5.colKind, STR5.colCalls, STR5.colTokens, STR5.colCost].map((h) => <span key={h} role="columnheader">{h}</span>)}
            </div>
            {view.byPurpose.map((p) => (
              <div role="row" key={p.group} className="usage-row">
                <span role="cell">{STR5.purposeLabels[p.group]}</span>
                <span role="cell">{p.calls}</span>
                <span role="cell">{formatTokens(p.tokens)}</span>
                <span role="cell">{usd(p.costUsd)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {view.costHistory && (
        <span className="muted usage-note">
          {STR5.costHistoryNote(new Date(view.costHistory.before).toLocaleDateString(undefined, { month: "short", day: "numeric" }), view.costHistory.estimated)}
        </span>
      )}

      <h3>{STR5.efficiencyThisWeek}</h3>
      <div className="usage-tiles">
        {STR5.tiles.map((t) => (
          <div key={t.key} className="usage-tile">
            <span className="tile-title">{t.title}</span>
            <span className="muted">{t.sub}</span>
            <span className="tile-value">{view.efficiency[t.key]}</span>
          </div>
        ))}
      </div>

      <UsageDashboard />
    </>
  );
}

registerSectionBlock("account", "usage", 10, UsageSection);
