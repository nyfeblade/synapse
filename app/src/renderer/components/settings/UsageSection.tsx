import { useEffect } from "react";
import { STR, STR5, STRL, STR_COST, modelLabel } from "@synapse/shared";
import { nativeCall } from "../../native";
import { useUi } from "../../store";
import { BILLING_URLS, formatTokens, startUsageSync, useUsage } from "../../usage/store";
import { startSpendMeterSync, useSpendMeter } from "../../usage/meter-store";
import { Segmented } from "../Segmented";
import { registerSectionBlock, registerSettingsSection, SectionBlocks } from "./sections";
import { SavingsCard } from "./SavingsCard";
import { UsageDashboard } from "./UsageDashboard";

const open = (url: string) => void nativeCall("openExternal", { url });
/** Background calls are often fractions of a cent; "$0.00" would read as free. */
const usd = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);
const METER_MODES = [
  { value: "today", label: STR_COST.meterToday },
  { value: "month", label: STR_COST.meterMonth },
  { value: "off", label: STR_COST.meterOff },
] as const;

/** 5.7: the header's spend meter: today, this month, or hidden. */
function MeterRow() {
  const view = useSpendMeter((s) => s.view);
  const setMode = useSpendMeter((s) => s.setMode);
  useEffect(() => startSpendMeterSync(), []);
  if (!view) return null;
  return (
    <div className="settings-row">
      <span style={{ flexGrow: 1 }}>{STR_COST.meterSetting}</span>
      <Segmented label={STR_COST.meterSetting} value={view.mode} options={METER_MODES} onChange={(m) => void setMode(m)} />
    </div>
  );
}

export function UsageSection() {
  const { view, error, load } = useUsage();
  // New-user walk, finding 8: the efficiency counters are internal plumbing; they wait behind Show advanced controls.
  const advanced = useUi((s) => s.settings?.advancedEnabled ?? false);
  useEffect(() => startUsageSync(), []);
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
        <MeterRow />
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

      {advanced && (
        <>
          <h3>{STR5.efficiencyThisWeek}</h3>
          <div className="usage-tiles">
            {STR5.tiles.map((t) => (
              <div key={t.key} className="usage-tile">
                <span className="tile-title">{t.title}</span>
                <span className="tile-value">{view.efficiency[t.key]}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <UsageDashboard />
    </>
  );
}

/** New-user walk, finding 15: Settings → Usage, its own section (spend, the monthly budget, savings, the dashboard). */
function UsagePage() {
  return (
    <section aria-label={STRL.usage}>
      <h2>{STRL.usage}</h2>
      <SectionBlocks section="usage" />
    </section>
  );
}
registerSettingsSection("usage", STRL.usage, UsagePage);
registerSectionBlock("usage", "spend", 10, UsageSection);
