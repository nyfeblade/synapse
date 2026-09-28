import {
  STR_COST, type BudgetAction, type BudgetDecision, type BudgetEstimate, type BudgetHit, type BudgetLimit, type BudgetPolicy, type BudgetsConfig,
  type BudgetStatusRow, type BudgetsView, type BudgetVerdict, type TaskAlertView, type WidgetSpec,
} from "@synapse/shared";
import type { UsageDashboard } from "./dashboard";
import { periodEndMs, periodStartMs } from "./periods";
import type { SpendEvent } from "./usage-store";

const CONFIG = "budgets";
const APPROVALS = "budgetApprovals";
const ASKED = "budgetAsked";
const ALERTS = "taskSpendAlerts";
/** Approvals and posted cards are per (limit, period); the newest few are plenty. */
const KEEP = 64;
const RANK: Record<BudgetVerdict, number> = { ok: 0, warn: 1, ask: 2, pause: 3 };
const EMPTY: BudgetsConfig = { account: null, bots: {} };

interface TaskAlert { limitUsd: number; since: number }
interface Evaluated { verdict: BudgetVerdict; hit: BudgetHit; warnPct: number }

export interface BudgetsDeps {
  usage: { onSpend(fn: (s: SpendEvent) => void): () => void; state<T>(key: string, fallback: T): T; setState(key: string, value: unknown): void };
  query: Pick<UsageDashboard, "spent" | "estimate">;
  settings: { extra<T>(key: string, fallback: T): T; setExtra(key: string, value: unknown): void };
  bots: { has(id: string): boolean; summary(id: string): { profile: { name: string } } };
  trays: { add(t: { botId: string | null; title: string; detail?: string; dedupeKey?: string }): unknown };
  now(): number;
  tz(): string;
  /** An approval-style card in the Bot's chat (HostWidgets.hostPost); its answer comes back to `onAnswer`. */
  post?(botId: string, spec: WidgetSpec, onAnswer: (value: string) => void): void;
  onChange?(): void;
}

/** A policy the user typed, made safe: positive finite limits, one per (period, unit), sane thresholds. */
export function cleanPolicy(p: BudgetPolicy | null | undefined): BudgetPolicy | null {
  if (!p || !Array.isArray(p.limits)) return null;
  const seen = new Set<string>();
  const limits: BudgetLimit[] = [];
  for (const l of p.limits) {
    if (!l || (l.period !== "day" && l.period !== "month") || (l.unit !== "usd" && l.unit !== "tokens")) continue;
    if (typeof l.limit !== "number" || !Number.isFinite(l.limit) || l.limit <= 0 || seen.has(`${l.period}:${l.unit}`)) continue;
    seen.add(`${l.period}:${l.unit}`);
    limits.push({ period: l.period, unit: l.unit, limit: l.unit === "usd" ? Math.round(l.limit * 100) / 100 : Math.round(l.limit) });
  }
  if (!limits.length) return null;
  const warnPct = typeof p.warnPct === "number" && Number.isFinite(p.warnPct) ? Math.min(100, Math.max(1, Math.round(p.warnPct))) : 80;
  const onLimit: BudgetAction = p.onLimit === "pause" ? "pause" : "ask";
  return { limits, warnPct, onLimit };
}

/**
 * Per-Bot and account-wide budgets, daily and monthly, in API dollars (list price) or tokens.
 *
 * The interface other code uses (the API-key sign-in path, routines, the composer) is two calls:
 *   budgets.check(botId, estimate) → ok | warn | ask | pause, with the limit it hit and a sentence to show;
 *   budgets.onSpend(fn)            → hear every recorded run (returns the unsubscribe).
 * At 100% a budget either asks first (an approval card; the OK holds for the rest of that period) or pauses
 * until the period resets. Work whose estimate would take a budget past its limit always asks first, even in
 * pause mode. A "tell me before you spend more than X" task alert asks the same way and ends with the OK.
 */
export class Budgets {
  constructor(private d: BudgetsDeps) {
    d.usage.onSpend((s) => this.afterSpend(s));
  }

  // ---------- config ----------
  config(): BudgetsConfig {
    const c = this.d.settings.extra<BudgetsConfig>(CONFIG, EMPTY);
    return { account: c.account ?? null, bots: c.bots ?? {} };
  }

  setPolicy(botId: string | null, policy: BudgetPolicy | null): void {
    const c = this.config();
    const p = cleanPolicy(policy);
    if (botId === null) c.account = p;
    else if (p) c.bots = { ...c.bots, [botId]: p };
    else { const { [botId]: _gone, ...rest } = c.bots; c.bots = rest; }
    this.d.settings.setExtra(CONFIG, c);
    this.d.onChange?.();
  }

  /**
   * The monthly budget prompt (review fix): sets the account's monthly dollar limit and keeps the rest of the account
   * policy (its other limits, onLimit and warnPct). With no account policy it starts one that asks at the limit.
   */
  setAccountMonthlyUsd(usd: number): void {
    const cur = this.config().account;
    const base: BudgetPolicy = cur ?? { limits: [], warnPct: 80, onLimit: "ask" };
    const limits = [...base.limits.filter((l) => !(l.period === "month" && l.unit === "usd")), { period: "month" as const, unit: "usd" as const, limit: usd }];
    this.setPolicy(null, { ...base, limits });
  }

  /** A deleted Bot's budget and alert go with it. */
  forgetBot(botId: string): void {
    if (this.config().bots[botId]) this.setPolicy(botId, null);
    this.setTaskAlert(botId, null);
  }

  // ---------- the interface ----------
  onSpend(fn: (s: SpendEvent) => void): () => void {
    return this.d.usage.onSpend(fn);
  }

  estimate(botId: string, routineId?: string | null): { usd: number; tokens: number } {
    return this.d.query.estimate(botId, routineId);
  }

  check(botId: string, estimate?: BudgetEstimate): BudgetDecision {
    const all = this.evaluate(botId, estimate);
    let best: Evaluated | null = null;
    for (const e of all) if (!best || RANK[e.verdict] > RANK[best.verdict] || (e.verdict === best.verdict && e.hit.pct > best.hit.pct)) best = e;
    if (!best || best.verdict === "ok") return { verdict: "ok", hit: best?.hit ?? null, message: null };
    const name = this.nameOf(botId);
    const message = best.verdict === "pause" ? STR_COST.pausedLine(best.hit, name) : best.verdict === "ask" ? STR_COST.askQuestion(best.hit, name) : STR_COST.warnTitle(best.hit, name);
    return { verdict: best.verdict, hit: best.hit, message };
  }

  /** The user's OK: every ask-mode budget touching this Bot continues for the rest of its period, and a task alert ends. */
  approve(botId: string, key?: string): void {
    const keys = key ? [key] : this.evaluate(botId, { usd: 0, tokens: 0 }).map((e) => e.hit.key).filter((k) => !k.startsWith("task:"));
    const approvals = this.d.usage.state<string[]>(APPROVALS, []);
    this.d.usage.setState(APPROVALS, [...approvals.filter((k) => !keys.includes(k)), ...keys].slice(-KEEP));
    if (!key || key.startsWith("task:")) this.setTaskAlert(botId, null);
    this.d.onChange?.();
  }

  // ---------- "tell me before you spend more than X" ----------
  setTaskAlert(botId: string, usd: number | null): void {
    const alerts = { ...this.d.usage.state<Record<string, TaskAlert>>(ALERTS, {}) };
    if (usd !== null && Number.isFinite(usd) && usd > 0) alerts[botId] = { limitUsd: Math.round(usd * 100) / 100, since: this.d.now() };
    else if (alerts[botId]) delete alerts[botId];
    else return;
    this.d.usage.setState(ALERTS, alerts);
    this.d.onChange?.();
  }

  taskAlert(botId: string): TaskAlertView | null {
    const a = this.d.usage.state<Record<string, TaskAlert>>(ALERTS, {})[botId];
    return a ? { botId, name: this.nameOf(botId), limitUsd: a.limitUsd, spentUsd: this.d.query.spent(botId, a.since, "usd"), since: a.since } : null;
  }

  // ---------- scheduled and triggered runs ----------
  /**
   * The routine fire consumer's question (via the usage ladder seam): may this Bot's routine fire now?
   * null = yes. Pause mode holds fires until the period resets; ask mode holds them and posts one card per
   * budget state, and the user's Continue lets the next fires run.
   */
  routinePausedUntil(botId: string, routineId: string, routineName: string): number | null {
    const d = this.check(botId, this.estimate(botId, routineId));
    if (d.verdict === "pause") return d.hit?.resetsAt ?? Number.POSITIVE_INFINITY;
    if (d.verdict !== "ask" || !d.hit) return null;
    this.askOnce(botId, d.hit, `${STR_COST.routineHeld(routineName)} ${d.message}`);
    return Number.POSITIVE_INFINITY;
  }

  /** A budget-ask card's answer (also after a host restart, through the registered widget kind). */
  answer(botId: string, value: string): void {
    if (value.startsWith("approve:")) this.approve(botId, value.slice("approve:".length));
  }

  /** The account's monthly dollar budget as a % spent this month (the usage ladder slows near it), or null. */
  accountMonthPct(): number | null {
    const l = this.config().account?.limits.find((x) => x.period === "month" && x.unit === "usd");
    if (!l) return null;
    return (this.d.query.spent(null, periodStartMs("month", this.d.now(), this.d.tz()), "usd") / l.limit) * 100;
  }

  // ---------- view ----------
  view(): BudgetsView {
    const c = this.config();
    const status: BudgetStatusRow[] = [];
    const row = (scope: "account" | "bot", botId: string | null, p: BudgetPolicy) => {
      for (const l of p.limits) {
        const e = this.limitState(scope, botId, p, l, 0);
        status.push({ ...l, scope, botId, name: botId ? this.nameOf(botId) : "All Bots", spent: e.hit.spent, pct: e.hit.pct, resetsAt: e.hit.resetsAt!, onLimit: p.onLimit, warnPct: p.warnPct });
      }
    };
    if (c.account) row("account", null, c.account);
    for (const [id, p] of Object.entries(c.bots)) if (this.d.bots.has(id)) row("bot", id, p);
    const alerts = this.d.usage.state<Record<string, TaskAlert>>(ALERTS, {});
    const taskAlerts = Object.keys(alerts).filter((id) => this.d.bots.has(id)).map((id) => this.taskAlert(id)!);
    return { config: c, status, taskAlerts };
  }

  // ---------- internals ----------
  private evaluate(botId: string, estimate?: BudgetEstimate): Evaluated[] {
    const c = this.config();
    const scopes: ["account" | "bot", string | null, BudgetPolicy][] = [];
    const own = this.d.bots.has(botId) ? c.bots[botId] : undefined;
    if (own) scopes.push(["bot", botId, own]);
    if (c.account) scopes.push(["account", null, c.account]);
    const alert = this.d.usage.state<Record<string, TaskAlert>>(ALERTS, {})[botId];
    if (!scopes.length && !alert) return [];
    let auto: { usd: number; tokens: number } | null = null;
    const est = (unit: "usd" | "tokens") => {
      const given = unit === "usd" ? estimate?.usd : estimate?.tokens;
      if (typeof given === "number" && Number.isFinite(given) && given >= 0) return given;
      auto ??= this.estimate(botId);
      return auto[unit];
    };
    const out: Evaluated[] = [];
    for (const [scope, sb, p] of scopes) for (const l of p.limits) out.push(this.limitState(scope, sb, p, l, est(l.unit)));
    if (alert) {
      const spent = this.d.query.spent(botId, alert.since, "usd");
      const e = est("usd");
      const hit: BudgetHit = { scope: "task", botId, period: "task", unit: "usd", limit: alert.limitUsd, spent, estimate: e, pct: pct(spent, alert.limitUsd), resetsAt: null, key: `task:${botId}:${alert.since}` };
      out.push({ verdict: spent + e > alert.limitUsd ? "ask" : "ok", hit, warnPct: 100 });
    }
    return out;
  }

  private limitState(scope: "account" | "bot", botId: string | null, p: BudgetPolicy, l: BudgetLimit, estimate: number): Evaluated {
    const now = this.d.now();
    const tz = this.d.tz();
    const start = periodStartMs(l.period, now, tz);
    const spent = this.d.query.spent(botId, start, l.unit);
    const key = `${scope}:${botId ?? "*"}:${l.period}:${l.unit}:${l.limit}:${start}`;
    const approved = this.d.usage.state<string[]>(APPROVALS, []).includes(key);
    const hit: BudgetHit = { scope, botId, period: l.period, unit: l.unit, limit: l.limit, spent, estimate, pct: pct(spent, l.limit), resetsAt: periodEndMs(l.period, now, tz), key };
    let verdict: BudgetVerdict = "ok";
    // Pause is pause: an OK given to a would-exceed question does not reopen a budget that is spent.
    if (spent >= l.limit) verdict = p.onLimit === "pause" ? "pause" : approved ? "ok" : "ask";
    else if (spent + estimate > l.limit) verdict = approved ? "ok" : "ask";
    else if (hit.pct >= p.warnPct) verdict = "warn";
    return { verdict, hit, warnPct: p.warnPct };
  }

  /** One warning tray per budget and period once spend crosses the threshold. */
  private afterSpend(s: SpendEvent): void {
    const botId = s.botId === "host" ? "" : s.botId;
    for (const e of this.evaluate(botId, { usd: 0, tokens: 0 })) {
      // A task alert was the user's own "tell me": the run that passes it says so in the chat, once, with the
      // same Continue; the next message of theirs is asked about it too (the sendPrompt gate).
      if (e.hit.scope === "task") { if (e.verdict === "ask") this.askOnce(botId, e.hit, STR_COST.askQuestion(e.hit, this.nameOf(botId))); continue; }
      if (e.hit.pct < e.warnPct) continue;
      this.d.trays.add({ botId: e.hit.botId, title: STR_COST.warnTitle(e.hit, this.nameOf(botId)), dedupeKey: `budget-warn:${e.hit.key}` });
    }
  }

  /** One approval card per budget state (its key), in the Bot's chat. */
  private askOnce(botId: string, hit: BudgetHit, question: string): void {
    const asked = this.d.usage.state<string[]>(ASKED, []);
    if (asked.includes(hit.key) || !this.d.post) return;
    this.d.usage.setState(ASKED, [...asked, hit.key].slice(-KEEP));
    this.d.post(botId, {
      question, hostKind: "budget-ask",
      options: [{ label: STR_COST.budgetContinue, value: `approve:${hit.key}`, style: "primary" }, { label: STR_COST.budgetKeepPaused, value: "keep" }],
    }, (v) => this.answer(botId, v));
  }

  private nameOf(botId: string): string {
    return this.d.bots.has(botId) ? this.d.bots.summary(botId).profile.name : "This Bot";
  }
}

const pct = (spent: number, limit: number) => (limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 100);
