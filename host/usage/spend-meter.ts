import type { BudgetsConfig, SpendMeterMode, SpendMeterView } from "@synapse/shared";
import type { TurnEvent } from "../brain/types";
import type { SettledTurn, TurnObserver } from "../runner/observers";
import { dayStartMs, monthStartMs } from "./periods";
import type { SpendEvent } from "./usage-store";

const MODE_KEY = "spendMeter";
const MODES: readonly SpendMeterMode[] = ["today", "month", "off"];
/** 5.7: at most four updates a second, and only when a figure the header shows (to the cent) changed. */
export const METER_MIN_INTERVAL_MS = 250;

const cents = (usd: number) => Math.round(usd * 100) / 100;

export interface SpendMeterDeps {
  /** The dashboard's running totals over usage.db (the same numbers Settings → Usage shows). */
  spent(botId: string | null, since: number, unit: "usd"): number;
  budgets(): BudgetsConfig;
  onSpend(fn: (s: SpendEvent) => void): () => void;
  settings: { extra<T>(key: string, fallback: T): T; setExtra(key: string, value: unknown): void };
  publish(v: SpendMeterView): void;
  now(): number;
  tz(): string;
  minIntervalMs?: number;
}

/**
 * The header's live spend meter. Totals come from usage.db through the dashboard's running totals; a running turn
 * adds its spend so far (the brain's `spend` events, list price) until its recorded row lands and replaces it. No
 * polling: it moves on a spend event, a recorded run or a budget change, trailing-throttled, and publishes only when a
 * shown cent changes.
 */
export class SpendMeter implements TurnObserver {
  private live = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;
  private last: string | null = null;
  private off: () => void;
  /** Tests and diagnostics: how many times the meter was published. */
  published = 0;

  constructor(private d: SpendMeterDeps) {
    this.off = d.onSpend(() => this.schedule());
  }

  onEvent(botId: string, e: TurnEvent): void {
    if (e.kind !== "spend" || !Number.isFinite(e.turnUsd) || e.turnUsd < 0) return;
    this.live.set(botId, e.turnUsd);
    this.schedule();
  }

  /** The turn's own row is written by UsageStore's observer in the same settle; the trailing publish reads both. */
  onSettled(t: SettledTurn): void {
    if (!this.live.delete(t.botId)) return;
    this.schedule();
  }

  mode(): SpendMeterMode {
    const m = this.d.settings.extra<SpendMeterMode>(MODE_KEY, "today");
    return MODES.includes(m) ? m : "today";
  }

  setMode(mode: SpendMeterMode): SpendMeterView {
    if (!MODES.includes(mode)) throw new Error("bad spend meter mode");
    this.d.settings.setExtra(MODE_KEY, mode);
    this.flush(true);
    return this.view();
  }

  view(): SpendMeterView {
    const now = this.d.now();
    const tz = this.d.tz();
    let inflight = 0;
    const turns: Record<string, number> = {};
    for (const [id, usd] of this.live) { inflight += usd; turns[id] = cents(usd); }
    const todayUsd = cents(this.d.spent(null, dayStartMs(now, tz), "usd") + inflight);
    const month = this.d.spent(null, monthStartMs(now, tz), "usd") + inflight;
    const policy = this.d.budgets().account;
    const limit = policy?.limits.find((l) => l.period === "month" && l.unit === "usd")?.limit ?? null;
    const budgetPct = limit ? Math.round((month / limit) * 1000) / 10 : null;
    return {
      mode: this.mode(), todayUsd, monthUsd: cents(month), budgetUsd: limit, budgetPct,
      warn: budgetPct !== null && budgetPct >= (policy?.warnPct ?? 80), turns,
    };
  }

  /** Something moved: publish on the trailing edge, no sooner than the interval after the last one. */
  schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastAt + (this.d.minIntervalMs ?? METER_MIN_INTERVAL_MS) - this.d.now());
    this.timer = setTimeout(() => { this.timer = null; this.flush(false); }, wait);
    this.timer.unref?.();
  }

  private flush(force: boolean): void {
    const v = this.view();
    const key = JSON.stringify(v);
    if (!force && key === this.last) return;
    this.last = key;
    this.lastAt = this.d.now();
    this.published += 1;
    this.d.publish(v);
  }

  stop(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
