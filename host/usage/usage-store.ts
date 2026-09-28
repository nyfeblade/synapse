import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_BOT_MODEL, STR5, type SavingsEstimates, USAGE_PURPOSE_GROUPS, purposeGroup, type EfficiencyTiles, type ModelId, type UsageBotRow, type UsagePurposeGroup, type UsagePurposeRow } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { TurnEvent, TurnUsage } from "../brain/types";
import type { SettledTurn, TurnObserver } from "../runner/observers";
import type { HostSettingsStore } from "../store/host-settings";
import type { MeteredRun, SessionTotals, UsageSink } from "./metered-query";
import { log } from "../util/log";
import { repairRunningTotals, type CostHistory } from "./repair-running-totals";
import { weekStartMs } from "./week";
import { SAVINGS_LOOKBACK_MS, SAVINGS_WINDOW_DAYS, estimateSavings, type SavingsRun } from "./savings-estimate";

/** §14.2 ladder decisions the user made by hand: `dismissed` maps an automatic tray's dedupeKey to the rank of
 *  the state they dismissed (see UsageLadder), `resumedWeek` is the week they last pressed Resume in. */
export interface LadderState { dismissed: Record<string, number>; resumedWeek: number | null }

/** One recorded run, as budgets and other spend listeners hear it. Dollars are API dollars at list price. */
export interface SpendEvent { botId: string; requestId: string; source: string; purpose: string; usd: number; tokens: number; at: number }
export interface RunTask { routineId: string | null; label: string | null }

export class UsageStore implements TurnObserver, UsageSink {
  private db: DatabaseSync;
  private listeners = new Set<(s: SpendEvent) => void>();
  /** What a run in flight is for (its routine / trigger), noted at dispatch and written with its row. */
  private tasks = new Map<string, RunTask>();
  /** saving-settings: the first and largest context of each Bot's turn in flight (context events), written with its row. */
  private ctx = new Map<string, { start: number; peak: number }>();

  constructor(private d: {
    file: string; metricsFile: string; bots: BotService; settings: HostSettingsStore; flags(): ConformanceFlags; now(): number; onChange?(): void;
    /** Integration: Phase 4's RuntimeMetrics owns efficiency_week (snake_case columns); read through it when wired. */
    efficiency?(): EfficiencyTiles;
  }) {
    this.db = new DatabaseSync(d.file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (requestId TEXT PRIMARY KEY, botId TEXT NOT NULL, source TEXT NOT NULL, routineId TEXT, model TEXT NOT NULL,
        startedAt INTEGER NOT NULL, durationMs INTEGER NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
        cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, costUsd REAL NOT NULL, numTurns INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(startedAt);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_totals (sessionId TEXT PRIMARY KEY, costUsd REAL NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
        cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    `);
    // Per-run accounting (2026-09-21): what each row was for, how its cost is known, and (for repaired rows)
    // the running total it originally held. `costBasis` NULL marks a row written before the fix.
    const cols = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("purpose")) this.db.exec("ALTER TABLE runs ADD COLUMN purpose TEXT");
    if (!cols.has("costBasis")) this.db.exec("ALTER TABLE runs ADD COLUMN costBasis TEXT");
    if (!cols.has("rawCostUsd")) this.db.exec("ALTER TABLE runs ADD COLUMN rawCostUsd REAL");
    // Cost dashboard (2026-09-22): the routine or trigger a run served, and the chat message it produced.
    // Covering indexes, one per way the dashboard slices (time, Bot, task), so every dashboard and budget query
    // is a plain range SUM over one index: no table lookups and no GROUP BY sort. `run_bots` / `run_tasks` hold
    // the distinct keys, so "per Bot" and "per task" are one small range query per key instead of a sort of a
    // month of rows. Under 50 ms on five years of runs (host/test/usage/dashboard-perf.test.ts).
    if (!cols.has("taskLabel")) this.db.exec("ALTER TABLE runs ADD COLUMN taskLabel TEXT");
    // saving-settings (2026-09-25): what the Savings estimates need per turn — a spoken call turn, a call live when it
    // started, and the context of its first and largest model call. NULL on rows written before (estimated, savings-estimate.ts).
    for (const c of ["voice", "callLive", "ctxStart", "ctxPeak"]) if (!cols.has(c)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${c} INTEGER`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS runs_time_cover ON runs(startedAt, costUsd, inputTokens, outputTokens, cacheRead, cacheWrite, botId);
      CREATE INDEX IF NOT EXISTS runs_bot_cover ON runs(botId, startedAt, costUsd, inputTokens, outputTokens, cacheRead, cacheWrite, purpose, taskLabel, routineId);
      CREATE INDEX IF NOT EXISTS runs_task_cover ON runs(purpose, taskLabel, startedAt, costUsd, inputTokens, outputTokens, cacheRead, cacheWrite);
      CREATE INDEX IF NOT EXISTS runs_routine ON runs(routineId, startedAt, costUsd, inputTokens, outputTokens, cacheRead, cacheWrite) WHERE routineId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS run_links (requestId TEXT PRIMARY KEY, chatId TEXT NOT NULL, entryId TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_bots (botId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS run_tasks (purpose TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (purpose, label)) WITHOUT ROWID;
    `);
    repairRunningTotals(this.db, this.d.now());
    // Once, after the repair has set every row's purpose: the distinct keys of the history already there.
    if (!this.getKv<boolean>("runKeys", false)) {
      this.db.exec(`UPDATE runs SET purpose = CASE WHEN source LIKE 'helper:%' THEN substr(source, 8) ELSE 'turn' END WHERE purpose IS NULL;
        INSERT OR IGNORE INTO run_bots SELECT DISTINCT botId FROM runs;
        INSERT OR IGNORE INTO run_tasks SELECT DISTINCT purpose, COALESCE(taskLabel, '') FROM runs;`);
      this.setKv("runKeys", true);
    }
    this.retirePlanData();
  }

  /**
   * synapse-public: Claude plan windows (rate_limit_event's five_hour / seven_day) belong to a Claude login, which Bots
   * never use, so none are recorded; the week is the calendar week and the ladder follows the dollar budgets only.
   * Once, the plan data an old subscription install left behind goes (a stale "86% of the week" would keep the ladder
   * raised, and the plan name would still show).
   */
  private retirePlanData(): void {
    if (this.getKv<boolean>("planRetired", false)) return;
    this.db.prepare("DELETE FROM kv WHERE key IN ('weekly', 'windows')").run();
    this.d.settings.setExtra("claudePlan", null);
    this.d.settings.setExtra("weeklyResetAt", null);
    this.setKv("planRetired", true);
  }

  onEvent(botId: string, e: TurnEvent): void {
    if (e.kind === "context") {
      const c = this.ctx.get(botId);
      if (c) c.peak = Math.max(c.peak, e.tokens);
      else this.ctx.set(botId, { start: e.tokens, peak: e.tokens });
      return;
    }
    // A rate_limit event (a Claude plan's windows) is not recorded: there is no plan (retirePlanData).
  }

  onSettled(t: SettledTurn): void {
    const ctx = this.ctx.get(t.botId);
    this.ctx.delete(t.botId);
    this.insert({
      requestId: t.requestId, botId: t.botId, source: t.source, purpose: "turn", model: t.model, startedAt: t.startedAt, durationMs: t.endedAt - t.startedAt, u: t.result.usage, status: t.result.error?.code ?? (t.result.aborted ? "aborted" : "ok"),
      turn: { voice: t.voice === true, callLive: t.callLive === true, ctxStart: ctx?.start ?? null, ctxPeak: ctx?.peak ?? null },
    });
    this.d.onChange?.();
  }

  /** USE-06: helper calls (dreaming, avatar, template drafting, coding agent) count for the Bot they served. */
  recordHelper(botId: string, source: string, model: string, u: TurnUsage): void {
    this.insert({ requestId: `helper_${source}_${this.d.now()}_${Math.random().toString(36).slice(2, 8)}`, botId, source: `helper:${source}`, purpose: source, model, startedAt: this.d.now(), durationMs: 0, u, status: "ok" });
    this.d.onChange?.();
  }

  /** UsageSink: every non-turn model call the host makes (usage/metered-query.ts). Host-level calls with no
   *  Bot (token check, conformance probes) are kept under "host": they count toward the week, not a Bot's row. */
  record(r: MeteredRun): void {
    this.recordHelper(r.botId ?? "host", r.purpose, r.model, r.usage);
  }

  /** saving-settings: each Savings choice's measured weekly figure, from the last 7 days of runs (savings-estimate.ts). */
  savings(): SavingsEstimates {
    const now = this.d.now();
    const since = now - SAVINGS_WINDOW_DAYS * 86_400_000;
    const rows = this.db.prepare(`SELECT botId, source, purpose, model, startedAt, durationMs, inputTokens, cacheRead, cacheWrite, voice, callLive, ctxStart, ctxPeak
      FROM runs WHERE startedAt >= ? AND startedAt <= ? ORDER BY startedAt`).all(since - SAVINGS_LOOKBACK_MS, now) as unknown as SavingsRun[];
    return estimateSavings(rows, { since });
  }

  /** A run in flight serves this routine / trigger; its row carries the label. */
  noteTask(requestId: string, t: RunTask): void {
    this.tasks.set(requestId, t);
    if (this.tasks.size > 256) this.tasks.delete(this.tasks.keys().next().value!);
  }

  /** The first visible chat message a run produced (the dashboard links its most expensive runs there). */
  noteLink(requestId: string, chatId: string, entryId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO run_links VALUES (?,?,?,?)").run(requestId, chatId, entryId, this.d.now());
  }

  /** Every recorded run, once. Returns the unsubscribe. */
  onSpend(fn: (s: SpendEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Small durable state kept beside the runs (budget approvals, task alerts): it outlives the host process. */
  state<T>(key: string, fallback: T): T {
    return this.getKv<T>(key, fallback);
  }

  setState(key: string, value: unknown): void {
    this.setKv(key, value);
  }

  /** The dashboard and budgets read the same file (host/usage/dashboard.ts). */
  database(): DatabaseSync {
    return this.db;
  }

  lastTotals(sessionId: string): SessionTotals | null {
    const r = this.db.prepare("SELECT costUsd, inputTokens, outputTokens, cacheRead, cacheWrite FROM session_totals WHERE sessionId = ?").get(sessionId) as
      { costUsd: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number } | undefined;
    return r ? { costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite } : null;
  }

  noteTotals(sessionId: string, t: SessionTotals): void {
    this.db.prepare(`INSERT INTO session_totals VALUES (?,?,?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET costUsd = excluded.costUsd, inputTokens = excluded.inputTokens,
      outputTokens = excluded.outputTokens, cacheRead = excluded.cacheRead, cacheWrite = excluded.cacheWrite, updatedAt = excluded.updatedAt`)
      .run(sessionId, t.costUsd, t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, this.d.now());
  }

  /** This week's spend by kind of work: the Bots' own conversations vs the background calls made for them. */
  purposes(): UsagePurposeRow[] {
    const rows = this.db.prepare(`SELECT COALESCE(purpose, CASE WHEN source LIKE 'helper:%' THEN substr(source, 8) ELSE 'turn' END) AS p, COUNT(*) AS n,
        SUM(inputTokens + outputTokens + cacheRead + cacheWrite) AS tokens, SUM(costUsd) AS cost FROM runs WHERE startedAt >= ? GROUP BY p`).all(this.weekStart()) as { p: string; n: number; tokens: number; cost: number }[];
    const by = new Map<UsagePurposeGroup, UsagePurposeRow>();
    for (const r of rows) {
      const g = purposeGroup(r.p);
      const acc = by.get(g) ?? { group: g, costUsd: 0, calls: 0, tokens: 0 };
      acc.costUsd += r.cost; acc.calls += r.n; acc.tokens += r.tokens;
      by.set(g, acc);
    }
    return USAGE_PURPOSE_GROUPS.flatMap((g) => {
      const r = by.get(g);
      return r ? [{ ...r, costUsd: Math.round(r.costUsd * 10_000) / 10_000 }] : [];
    });
  }

  /** Non-null while this week still shows rows rebuilt from pre-fix running totals (the view says so plainly). */
  costHistory(): CostHistory | null {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN costBasis = 'estimated' THEN 1 ELSE 0 END), 0) AS e, MAX(startedAt) AS last
      FROM runs WHERE rawCostUsd IS NOT NULL AND startedAt >= ?`).get(this.weekStart()) as { n: number; e: number; last: number | null };
    return r.n ? { repaired: r.n, estimated: r.e, before: r.last ?? 0 } : null;
  }

  /** The calendar week (Monday 00:00 in the user's time zone). */
  weekStart(): number {
    return weekStartMs(this.d.now(), this.d.settings.timeZone(), null);
  }

  /** Kept in usage.db's kv beside the week window, so a dismissal or a Resume outlives the host process. */
  ladderState(): LadderState {
    return this.getKv<LadderState>("ladder", { dismissed: {}, resumedWeek: null });
  }

  setLadderState(s: LadderState): void {
    this.setKv("ladder", s);
  }

  /**
   * How this week's PROMPT tokens were billed. A Bot re-sends a ~30k-token static prefix (the system
   * prompt, the built-in tool schemas and the bot MCP tool schemas) on every model call of a session,
   * so most of the spend IS that prefix, and the only question that matters about it is whether it
   * was billed as a cache read (0.1x), a cache write (1.25x) or uncached (1x). The runs table has
   * always carried the three separately and nothing has ever read them back, so the cache could not
   * be seen, let alone tuned. Percentages are of prompt tokens; null before the first turn.
   */
  cacheStats(): { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; promptTokens: number; hitRate: number | null; writeRate: number | null } {
    const r = this.db.prepare(`SELECT COALESCE(SUM(inputTokens), 0) AS i, COALESCE(SUM(cacheRead), 0) AS r, COALESCE(SUM(cacheWrite), 0) AS w
      FROM runs WHERE startedAt >= ?`).get(this.weekStart()) as { i: number; r: number; w: number };
    const promptTokens = r.i + r.r + r.w;
    const pct = (n: number) => (promptTokens ? Math.round((n / promptTokens) * 1000) / 10 : null);
    return { inputTokens: r.i, cacheReadTokens: r.r, cacheWriteTokens: r.w, promptTokens, hitRate: pct(r.r), writeRate: pct(r.w) };
  }

  weekCostUsd(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(costUsd), 0) AS c FROM runs WHERE startedAt >= ?").get(this.weekStart()) as { c: number };
    return Math.round(r.c * 10_000) / 10_000;
  }

  budgetUsd(): number | null {
    return this.d.settings.extra<{ usd?: number | null }>("weeklyBudget", {}).usd ?? null;
  }

  setBudgetUsd(usd: number | null): void {
    this.d.settings.setExtra("weeklyBudget", { usd: usd && usd > 0 ? Math.round(usd * 100) / 100 : null });
    this.d.onChange?.();
  }

  rows(): UsageBotRow[] {
    const rows = this.db.prepare(`SELECT botId, SUM(CASE WHEN source LIKE 'helper:%' THEN 0 ELSE 1 END) AS turns,
        SUM(inputTokens + outputTokens + cacheRead + cacheWrite) AS tokens, SUM(costUsd) AS cost FROM runs WHERE startedAt >= ? AND botId != 'host' GROUP BY botId`).all(this.weekStart()) as { botId: string; turns: number; tokens: number; cost: number }[];
    return rows
      .filter((r) => this.d.bots.has(r.botId))
      .map((r) => {
        const s = this.d.bots.summary(r.botId);
        return { botId: r.botId, name: s.profile.name, model: (s.profile.model ?? DEFAULT_BOT_MODEL) as ModelId, turns: r.turns, tokens: r.tokens, costUsd: Math.round(r.cost * 100) / 100 };
      })
      .sort((a, b) => b.tokens - a.tokens);
  }

  /** USE-05 tiles; Phase 4 writes `efficiency_week` (ORIG-18 §18.7). Missing file or table → zeros. */
  efficiency(): EfficiencyTiles {
    if (this.d.efficiency) return this.d.efficiency();
    const zero = { dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 };
    if (!fs.existsSync(this.d.metricsFile)) return zero;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.d.metricsFile, { readOnly: true });
      const r = db.prepare(`SELECT COALESCE(SUM(dropped),0) d, COALESCE(SUM(inboxDelivered),0) i, COALESCE(SUM(resultsBatched),0) b,
          COALESCE(SUM(coalescedTurns),0) c, COALESCE(SUM(loopsEnded),0) l FROM efficiency_week WHERE weekStart >= ?`).get(this.weekStart()) as { d: number; i: number; b: number; c: number; l: number };
      return { dropped: r.d, wakesAvoided: r.i + r.b, burstsCoalesced: r.c, loopsEnded: r.l };
    } catch {
      return zero;
    } finally {
      db?.close();
    }
  }

  close(): void {
    this.db.close();
  }

  private insert(r: { requestId: string; botId: string; source: string; purpose: string; model: string; startedAt: number; durationMs: number; u: TurnUsage; status: string; turn?: { voice: boolean; callLive: boolean; ctxStart: number | null; ctxPeak: number | null } }): void {
    const task = this.tasks.get(r.requestId);
    this.tasks.delete(r.requestId);
    const res = this.db.prepare(`INSERT OR IGNORE INTO runs (requestId, botId, source, routineId, model, startedAt, durationMs, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, numTurns, status, purpose, costBasis, taskLabel, voice, callLive, ctxStart, ctxPeak)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'exact',?,?,?,?,?)`).run(
      r.requestId, r.botId, r.source, task?.routineId ?? null, r.model, r.startedAt, r.durationMs, r.u.inputTokens, r.u.outputTokens, r.u.cacheReadTokens, r.u.cacheWriteTokens, r.u.costUsd ?? 0, 1, r.status, r.purpose, task?.label ?? null,
      r.turn ? Number(r.turn.voice) : null, r.turn ? Number(r.turn.callLive) : null, r.turn?.ctxStart ?? null, r.turn?.ctxPeak ?? null,
    );
    if (!res.changes) return;
    this.db.prepare("INSERT OR IGNORE INTO run_bots VALUES (?)").run(r.botId);
    this.db.prepare("INSERT OR IGNORE INTO run_tasks VALUES (?, ?)").run(r.purpose, task?.label ?? "");
    const ev: SpendEvent = {
      botId: r.botId, requestId: r.requestId, source: r.source, purpose: r.purpose, usd: r.u.costUsd ?? 0, at: r.startedAt,
      tokens: r.u.inputTokens + r.u.outputTokens + r.u.cacheReadTokens + r.u.cacheWriteTokens,
    };
    for (const fn of [...this.listeners]) {
      try { fn(ev); } catch (e) { log.warn("spend listener failed", { error: String(e) }); }
    }
  }

  private getKv<T>(k: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(k) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  private setKv(k: string, v: unknown): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v));
  }
}
