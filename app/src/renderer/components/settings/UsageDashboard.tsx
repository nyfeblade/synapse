import { useEffect, useMemo, useRef, useState } from "react";
import { STR, STR_COST, type BudgetAction, type BudgetLimit, type BudgetPolicy, type BudgetsView, type BudgetUnit, type SpendSummary, type UsageDashboardView, type UsageRange } from "@synapse/shared";
import { useUi } from "../../store";
import { barLayout, bucketLabel } from "../../usage/chart";
import { useDashboard } from "../../usage/dashboard-store";
import { formatTokens, useUsage } from "../../usage/store";
import { MoneyInput, formatMoney, parseMoney } from "../MoneyInput";

const money = STR_COST.money;
const RANGES: { id: UsageRange; label: string }[] = [{ id: "day", label: "Day" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }];
const TOKEN_PARTS = [
  { key: "inputTokens", label: "Input", cls: "in" },
  { key: "cacheReadTokens", label: "Cache read", cls: "read" },
  { key: "cacheWriteTokens", label: "Cache write", cls: "write" },
  { key: "outputTokens", label: "Output", cls: "out" },
] as const;
const CHART_W = 560;
const CHART_H = 120;

/**
 * Settings → Usage: per Bot, per day / week / month, tokens by kind and dollars at API list price (what the key is billed), per task,
 * the most expensive runs (each opens its chat message), the
 * hosted-agent comparison (an estimate) and budgets. Plain SVG; the only motion is the bars settling on the
 * glide spring when the data changes.
 */
/** A stored limit as its field shows it: dollars as "1,234.50", tokens as a plain whole number. */
const limitText = (l: BudgetLimit): string => (l.unit === "usd" ? formatMoney(l.limit) : String(Math.round(l.limit)));
/** A typed limit, or null when it is not a number: dollars through parseMoney, tokens as a whole number ("12,000" allowed). */
function parseLimit(unit: BudgetUnit, text: string): number | null {
  if (unit === "usd") return parseMoney(text);
  const t = text.trim().replace(/,/g, "");
  return /^\d+$/.test(t) ? Number(t) : null;
}
/** The advanced grid's limit field: a MoneyInput while the unit is $, a whole-number field while it is tokens. */
function LimitInput({ id, unit, value, onChange, invalid }: { id: string; unit: BudgetUnit; value: string; onChange(v: string): void; invalid: boolean }) {
  const described = invalid ? "budget-error" : undefined;
  return unit === "usd"
    ? <MoneyInput id={id} className="narrow" placeholder="None" value={value} onChange={onChange} invalid={invalid} aria-describedby={described} />
    : <input id={id} className="text-input narrow" inputMode="numeric" placeholder="None" value={value} onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined} aria-describedby={described} />;
}

export function UsageDashboard() {
  const { range, botId, view, error, load, setRange, setBot } = useDashboard();
  const bots = useUi((s) => s.bots);
  const pushed = useUsage((s) => s.view);
  const first = useRef(true);
  useEffect(() => { void load(); }, [load]);
  // A settled turn re-publishes the Usage view; refresh the dashboard behind it, at most once a second.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(), 1000);
    return () => clearTimeout(t);
  }, [pushed, load]);
  const botList = useMemo(() => Object.values(bots).map((b) => ({ id: b.id, name: b.profile.name })).sort((a, b) => a.name.localeCompare(b.name)), [bots]);

  return (
    <section className="dash" aria-label="Usage dashboard">
      <div className="dash-head">
        <h3>Spend over time</h3>
        <div role="radiogroup" aria-label="Range" className="segmented">
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={range === r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <select className="dropdown" aria-label="Bot" value={botId ?? ""} onChange={(e) => setBot(e.target.value || null)}>
          <option value="">All Bots</option>
          {botList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      {error && (
        <div className="settings-card">
          <span className="error" role="status">{error}</span>
          <button type="button" className="btn-outline small" onClick={() => void load()}>{STR.retry}</button>
        </div>
      )}
      {!view && !error && <span className="muted">{STR.loading}</span>}
      {view && <DashboardBody view={view} />}
    </section>
  );
}

function DashboardBody({ view }: { view: UsageDashboardView }) {
  const t = view.totals;
  const hourly = view.range === "day";
  const layout = barLayout(view.series.map((p) => p.usd), CHART_W, CHART_H);
  const scopeName = view.botId ? view.bots[0]?.name ?? useUi.getState().bots[view.botId]?.profile.name ?? "This Bot" : "All Bots";
  const open = (chatId: string, entryId: string) => {
    useUi.getState().closeSettings();
    void useUi.getState().jumpTo(chatId, entryId);
  };
  return (
    <>
      {view.spend && <SpendCard spend={view.spend} />}
      <div className="settings-card dash-kpis">
        <div className="dash-kpi">
          <span className="dash-kpi-value">{money(t.usd)}</span>
          <span className="muted">{STR_COST.apiCost}</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{formatTokens(t.tokens)}</span>
          <span className="muted">tokens · {t.runs} {t.runs === 1 ? "run" : "runs"}</span>
        </div>
        <div className="dash-split" aria-label="Tokens by kind">
          <div className="dash-split-bar" aria-hidden="true">
            {TOKEN_PARTS.map((p) => <span key={p.key} className={`seg ${p.cls}`} style={{ flexGrow: t[p.key] }} />)}
          </div>
          <ul className="dash-legend">
            {TOKEN_PARTS.map((p) => (
              <li key={p.key}><i className={`dot ${p.cls}`} /><span>{p.label}</span><span className="muted">{formatTokens(t[p.key])}</span></li>
            ))}
          </ul>
        </div>
      </div>

      <div className="settings-card dash-chart">
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 18}`} role="img" aria-label={`Spend per ${hourly ? "hour" : "day"}, ${money(t.usd)} total`} preserveAspectRatio="none">
          <line x1="0" x2={CHART_W} y1={CHART_H + 0.5} y2={CHART_H + 0.5} className="axis" />
          <line x1="0" x2={CHART_W} y1="0.5" y2="0.5" className="grid" />
          {layout.bars.map((b, i) => (
            <rect key={view.series[i]!.start} x={b.x} y={0} width={b.w} height={CHART_H} rx={Math.min(3, b.w / 2)} className="bar"
              style={{ transform: `scaleY(${b.h / CHART_H})` }}>
              <title>{`${bucketLabel(view.series[i]!.start, hourly)}: ${money(view.series[i]!.usd)}, ${formatTokens(view.series[i]!.tokens)} tokens`}</title>
            </rect>
          ))}
        </svg>
        <div className="dash-axis muted">
          <span>{bucketLabel(view.series[0]?.start ?? view.start, hourly)}</span>
          <span>max {money(layout.max)}</span>
          <span>{bucketLabel(view.series[view.series.length - 1]?.start ?? view.end, hourly)}</span>
        </div>
      </div>

      {view.range === "month" && view.comparison && (
        <div className="settings-card dash-compare">
          <p>{`This month: ${money(view.comparison.monthUsd)}. A typical hosted agent's overhead would have been about ${money(view.comparison.midUsd)} (${money(view.comparison.lowUsd)}–${money(view.comparison.highUsd)}).`}</p>
          <p className="muted dash-compare-basis">{view.comparison.basis}</p>
        </div>
      )}

      {!view.botId && view.bots.length > 0 && (
        <Table label="By Bot" head={["Bot", "Runs", "Tokens", "Cost"]} rows={view.bots.map((b) => ({ key: b.botId, cells: [b.name, String(b.runs), formatTokens(b.tokens), money(b.usd)] }))} />
      )}
      {view.tasks.length > 0 && (
        <Table label="By task" head={["Task", "Runs", "Tokens", "Cost"]} rows={view.tasks.map((x) => ({ key: x.key, cells: [x.label, String(x.runs), formatTokens(x.tokens), money(x.usd)] }))} />
      )}

      {view.top.length > 0 && (
        <>
          <h4 className="dash-sub">Most expensive runs</h4>
          <ol className="settings-card dash-top">
            {view.top.map((r) => {
              const when = new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
              const body = (
                <>
                  <span className="dash-top-name">{r.name} · {r.label}</span>
                  <span className="muted">{when} · {formatTokens(r.tokens)} tokens</span>
                  <span className="dash-top-cost">{money(r.usd)}</span>
                </>
              );
              return (
                <li key={r.requestId}>
                  {r.link
                    ? <button type="button" className="dash-top-row" aria-label={`Open the message: ${r.name}, ${r.label}, ${money(r.usd)}`} onClick={() => open(r.link!.chatId, r.link!.entryId)}>{body}</button>
                    : <div className="dash-top-row" title="This run sent no visible message">{body}</div>}
                </li>
              );
            })}
          </ol>
        </>
      )}

      <BudgetEditor budgets={view.budgets} botId={view.botId} name={scopeName} />
    </>
  );
}

/** API spend today / this week / this month, for all Bots and per Bot (the host's spendSummary). */
function SpendCard({ spend }: { spend: SpendSummary }) {
  return (
    <>
      <div className="settings-card dash-kpis" aria-label={STR_COST.apiSpend}>
        {([[STR_COST.today, spend.today], [STR_COST.thisWeek, spend.week], [STR_COST.thisMonth, spend.month]] as const).map(([label, usd]) => (
          <div key={label} className="dash-kpi">
            <span className="dash-kpi-value">{money(usd)}</span>
            <span className="muted">{label}</span>
          </div>
        ))}
      </div>
      {spend.bots.length > 0 && (
        <Table label={STR_COST.apiSpend} head={["Bot", STR_COST.today, STR_COST.thisWeek, STR_COST.thisMonth]}
          rows={spend.bots.map((b) => ({ key: b.botId, cells: [b.name, money(b.today), money(b.week), money(b.month)] }))} />
      )}
    </>
  );
}

function Table({ label, head, rows }: { label: string; head: string[]; rows: { key: string; cells: string[] }[] }) {
  return (
    <>
      <h4 className="dash-sub">{label}</h4>
      <div role="table" aria-label={label} className="settings-card usage-table dash-table">
        <div role="row" className="usage-head">{head.map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
        {rows.map((r) => (
          <div role="row" key={r.key} className="usage-row">{r.cells.map((c, i) => <span key={i} role="cell" title={i === 0 ? c : undefined}>{c}</span>)}</div>
        ))}
      </div>
    </>
  );
}

function limitOf(p: BudgetPolicy | null | undefined, period: "day" | "month"): BudgetLimit | undefined {
  return p?.limits.find((l) => l.period === period);
}

function BudgetEditor({ budgets, botId, name }: { budgets: BudgetsView; botId: string | null; name: string }) {
  const { setBudget, clearTaskAlert } = useDashboard();
  // New-user walk, finding 7: one budget — the account's monthly $ limit. Daily limits, tokens, the warning point, the
  // action at the limit and per-Bot budgets are advanced controls.
  const advanced = useUi((s) => s.settings?.advancedEnabled ?? false);
  const policy = botId ? budgets.config.bots[botId] ?? null : budgets.config.account;
  const [day, setDay] = useState("");
  const [dayUnit, setDayUnit] = useState<BudgetUnit>("usd");
  const [month, setMonth] = useState("");
  const [monthUnit, setMonthUnit] = useState<BudgetUnit>("usd");
  const [warn, setWarn] = useState("80");
  const [action, setAction] = useState<BudgetAction>("ask");
  const [invalid, setInvalid] = useState(false);
  // Review of finding 7: the simple view edits the monthly $ limit only, and shows every other limit that is set.
  const [monthUsd, setMonthUsd] = useState("");
  const botsById = useUi((s) => s.bots);
  const sig = JSON.stringify(policy);
  useEffect(() => {
    const d = limitOf(policy, "day");
    const m = limitOf(policy, "month");
    setDay(d ? limitText(d) : ""); setDayUnit(d?.unit ?? "usd");
    setMonth(m ? limitText(m) : ""); setMonthUnit(m?.unit ?? "usd");
    setWarn(String(policy?.warnPct ?? 80)); setAction(policy?.onLimit ?? "ask");
    setMonthUsd(m && m.unit === "usd" ? formatMoney(m.limit) : "");
    setInvalid(false);
  }, [sig, botId]);
  const save = () => {
    const limits: BudgetLimit[] = [];
    for (const [period, v, unit] of [["day", day, dayUnit], ["month", month, monthUnit]] as const) {
      if (!v.trim()) continue;
      const n = parseLimit(unit, v);
      if (n === null || n <= 0) { setInvalid(true); return; }
      limits.push({ period, unit, limit: n });
    }
    const w = /^\s*\d+\s*%?\s*$/.test(warn) ? Number(warn.replace("%", "")) : NaN;
    if (!Number.isFinite(w) || w < 1 || w > 100) { setInvalid(true); return; }
    setInvalid(false);
    void setBudget(botId, limits.length ? { limits, warnPct: Math.round(w), onLimit: action } : null);
  };
  const isMonthUsd = (l: BudgetLimit) => l.period === "month" && l.unit === "usd";
  const others = (policy?.limits ?? []).filter((l) => !isMonthUsd(l));
  const saveMonthly = () => {
    const n = parseMoney(monthUsd);
    if (n === null || n <= 0) { setInvalid(true); return; }
    setInvalid(false);
    // A monthly limit in tokens is replaced by the dollar one the user typed (it was shown above as tokens).
    const kept = others.filter((l) => l.period !== "month");
    void setBudget(botId, { limits: [...kept, { period: "month", unit: "usd", limit: n }], warnPct: policy?.warnPct ?? 80, onLimit: policy?.onLimit ?? "ask" });
  };
  const removeMonthly = () => void setBudget(botId, others.length ? { limits: others, warnPct: policy?.warnPct ?? 80, onLimit: policy?.onLimit ?? "ask" } : null);
  const periodLabel = (l: BudgetLimit) => (l.period === "day" ? "Daily limit" : "Monthly limit");
  const plainRows = others.map((l) => (
    <div key={`${l.period}:${l.unit}`} className="settings-row"><span className="grow">{periodLabel(l)}</span><span className="muted">{STR_COST.amount(l.unit, l.limit)}</span></div>
  ));
  const botLines = botId ? [] : Object.entries(budgets.config.bots).filter(([, p]) => p?.limits.length).map(([id, p]) =>
    `${botsById[id]?.profile.name ?? "A Bot"}: ${p!.limits.map((l) => `${STR_COST.amount(l.unit, l.limit)} a ${l.period === "day" ? "day" : "month"}`).join(", ")}`);
  const status = budgets.status.filter((s) => (botId ? s.scope === "bot" && s.botId === botId : s.scope === "account"));
  const unitSelect = (label: string, v: BudgetUnit, set: (u: BudgetUnit) => void) => (
    <select className="dropdown" aria-label={label} value={v} onChange={(e) => set(e.target.value as BudgetUnit)}>
      <option value="usd">$</option>
      <option value="tokens">tokens</option>
    </select>
  );
  if (botId && !advanced) return (
    <>
      {policy?.limits.length ? (
        <>
          <h4 className="dash-sub">{`Budget for ${name}`}</h4>
          <div className="settings-card">{policy.limits.map((l) => <div key={`${l.period}:${l.unit}`} className="settings-row"><span className="grow">{periodLabel(l)}</span><span className="muted">{STR_COST.amount(l.unit, l.limit)}</span></div>)}</div>
        </>
      ) : null}
      <TaskAlerts alerts={budgets.taskAlerts} clear={clearTaskAlert} />
    </>
  );
  return (
    <>
      <h4 className="dash-sub">{botId ? `Budget for ${name}` : STR_COST.monthlyBudget}</h4>
      <div className="settings-card dash-budget">
        {status.map((s) => (
          <div key={`${s.period}:${s.unit}`} className="usage-bar-row">
            <span className="dash-window-name">{s.period === "day" ? "Today" : "This month"}</span>
            <div role="progressbar" aria-label={`${s.period === "day" ? "Daily" : "Monthly"} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(s.pct))}
              className={`usage-bar${s.pct >= 100 ? " over" : s.pct >= s.warnPct ? " warn" : ""}`}><span style={{ width: `${Math.min(100, s.pct)}%` }} /></div>
            <span className="usage-meta"><span>{`${STR_COST.amount(s.unit, s.spent)} of ${STR_COST.amount(s.unit, s.limit)}`}</span></span>
          </div>
        ))}
        {advanced ? (
          <div className="dash-budget-grid">
            <label htmlFor="budget-day">Daily limit</label>
            <LimitInput id="budget-day" unit={dayUnit} value={day} onChange={setDay} invalid={invalid} />
            {unitSelect("Daily unit", dayUnit, setDayUnit)}
            <label htmlFor="budget-month">Monthly limit</label>
            <LimitInput id="budget-month" unit={monthUnit} value={month} onChange={setMonth} invalid={invalid} />
            {unitSelect("Monthly unit", monthUnit, setMonthUnit)}
            <label htmlFor="budget-warn">Warn at (%)</label>
            <input id="budget-warn" className="text-input narrow" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? "budget-error" : undefined} />
            <span />
            <label htmlFor="budget-action">At the limit</label>
            <select id="budget-action" className="dropdown" value={action} onChange={(e) => setAction(e.target.value as BudgetAction)}>
              <option value="ask">Ask before continuing</option>
              <option value="pause">Pause until it resets</option>
            </select>
            <span />
          </div>
        ) : (
          <>
            {plainRows}
            {botLines.map((t) => <div key={t} className="settings-row"><span className="grow">{t}</span></div>)}
            <div className="settings-row">
              <label htmlFor="budget-month" className="grow">{STR_COST.monthlyBudget}</label>
              <MoneyInput id="budget-month" className="narrow" placeholder="None" value={monthUsd} onChange={setMonthUsd}
                invalid={invalid} aria-describedby={invalid ? "budget-error" : undefined} />
            </div>
          </>
        )}
        {invalid && <span id="budget-error" className="error field-error" role="alert">{advanced ? "Enter positive numbers, and a warning between 1 and 100%." : STR_COST.amountInvalid}</span>}
        <div className="dash-budget-actions">
          {advanced
            ? policy && <button type="button" className="btn-outline small" onClick={() => void setBudget(botId, null)}>Remove all limits</button>
            : policy?.limits.some(isMonthUsd) && <button type="button" className="btn-outline small" onClick={removeMonthly}>Remove monthly budget</button>}
          <button type="button" className="btn-primary" onClick={advanced ? save : saveMonthly}>Save budget</button>
        </div>
      </div>
      <TaskAlerts alerts={budgets.taskAlerts} clear={clearTaskAlert} />
    </>
  );
}

function TaskAlerts({ alerts, clear }: { alerts: BudgetsView["taskAlerts"]; clear(botId: string): Promise<void> | void }) {
  if (!alerts.length) return null;
  return (
    <>
      <h4 className="dash-sub">Task alerts</h4>
      <ul className="settings-card dash-alerts">
        {alerts.map((a) => (
          <li key={a.botId} className="settings-row">
            <span style={{ flexGrow: 1 }}>{`${a.name}: tell me before ${money(a.limitUsd)} · ${money(a.spentUsd)} spent so far`}</span>
            <button type="button" className="btn-outline small" aria-label={`Clear alert for ${a.name}`} onClick={() => void clear(a.botId)}>Clear</button>
          </li>
        ))}
      </ul>
    </>
  );
}
