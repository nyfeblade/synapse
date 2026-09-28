import type { DatabaseSync, StatementSync } from "node:sqlite";
import { STR5, purposeGroup, type SpendSummary, type UsageBotTotals, type UsagePoint, type UsageRange, type UsageTaskRow, type UsageTopRun, type UsageTotals } from "@synapse/shared";
import { dayStarts, dayStartMs, monthStartMs, nextDayStartMs, nextMonthStartMs } from "./periods";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOP_N = 10;
const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

export interface DashboardSource { database(): DatabaseSync; weekStart(): number; onSpend?(fn: (s: { botId: string; at: number; usd: number; tokens: number }) => void): () => void }
export interface DashboardBots { has(id: string): boolean; summary(id: string): { profile: { name: string } } }

export interface DashboardSlice {
  range: UsageRange; botId: string | null; start: number; end: number;
  totals: UsageTotals; series: UsagePoint[]; bots: UsageBotTotals[]; tasks: UsageTaskRow[]; top: UsageTopRun[];
}

type Sums = { i: number; r: number; w: number; o: number; c: number; n: number };
const SUMS = "COALESCE(SUM(inputTokens),0) i, COALESCE(SUM(cacheRead),0) r, COALESCE(SUM(cacheWrite),0) w, COALESCE(SUM(outputTokens),0) o, COALESCE(SUM(costUsd),0) c, COUNT(*) n";
const totalsOf = (s: Sums): UsageTotals => ({ inputTokens: s.i, cacheReadTokens: s.r, cacheWriteTokens: s.w, outputTokens: s.o, tokens: s.i + s.r + s.w + s.o, usd: round(s.c), runs: s.n });

/**
 * Read side of usage.db for the cost dashboard and the budgets: per Bot, per day / week / month, per task,
 * and the most expensive runs. Every query is a range scan of a covering index (usage-store.ts).
 */
export class UsageDashboard {
  private stmts = new Map<string, StatementSync>();

  /** Budget checks run before every user send and routine fire; spend only changes when a run is recorded. */
  private spentCache = new Map<string, { botId: string | null; since: number; unit: "usd" | "tokens"; v: number }>();

  constructor(private d: { usage: DashboardSource; bots: DashboardBots; tz(): string; now(): number }) {
    d.usage.onSpend?.((s) => this.addSpend(s));
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.d.usage.database().prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  /** [start, end) of a range, and its chart buckets: local hours for a day, local days otherwise. */
  bounds(range: UsageRange): { start: number; end: number; buckets: number[] } {
    const now = this.d.now();
    const tz = this.d.tz();
    if (range === "day") {
      const start = dayStartMs(now, tz);
      const end = nextDayStartMs(now, tz);
      const buckets: number[] = [];
      for (let t = start; t < end; t += HOUR) buckets.push(t);
      return { start, end, buckets };
    }
    const start = range === "week" ? this.d.usage.weekStart() : monthStartMs(now, tz);
    const end = range === "week" ? start + 7 * DAY : nextMonthStartMs(now, tz);
    const buckets = dayStarts(start, end, tz);
    buckets[0] = Math.min(buckets[0]!, start);
    return { start, end, buckets };
  }

  view(range: UsageRange, botId: string | null): DashboardSlice {
    const { start, end, buckets } = this.bounds(range);
    const where = `startedAt >= ? AND startedAt < ?${botId ? " AND botId = ?" : ""}`;
    const args = botId ? [start, end, botId] : [start, end];

    // Per Bot: one range SUM per known Bot on (botId, startedAt, …). No GROUP BY, so no sort of a month of rows.
    const ids = botId ? [botId] : (this.q("SELECT botId FROM run_bots").all() as { botId: string }[]).map((r) => r.botId);
    const perBot = this.q(`SELECT ${SUMS} FROM runs WHERE botId = ? AND startedAt >= ? AND startedAt < ?`);
    const byBot = ids.map((id) => ({ botId: id, ...(perBot.get(id, start, end) as unknown as Sums) })).filter((b) => b.n > 0);
    const all: Sums = { i: 0, r: 0, w: 0, o: 0, c: 0, n: 0 };
    for (const b of byBot) { all.i += b.i; all.r += b.r; all.w += b.w; all.o += b.o; all.c += b.c; all.n += b.n; }
    const bots = byBot.map((b) => ({ botId: b.botId, name: this.nameOf(b.botId), ...totalsOf(b) })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);

    // The chart: one range SUM per bucket (local hour or local day), exact across DST and any UTC offset.
    const perBucket = this.q(`SELECT COALESCE(SUM(costUsd),0) c, COALESCE(SUM(inputTokens + outputTokens + cacheRead + cacheWrite),0) t
      FROM runs WHERE startedAt >= ? AND startedAt < ?${botId ? " AND botId = ?" : ""}`);
    const series: UsagePoint[] = buckets.map((b, i) => {
      const from = Math.max(b, start);
      const to = Math.min(buckets[i + 1] ?? end, end);
      const s = perBucket.get(...(botId ? [from, to, botId] : [from, to])) as { c: number; t: number };
      return { start: b, usd: round(s.c), tokens: s.t };
    });

    // Per task: grouped over one Bot's rows (small), or one range SUM per known (purpose, label) for all Bots.
    const taskRows: { p: string; l: string | null; n: number; c: number; t: number }[] = botId
      ? this.q(`SELECT COALESCE(purpose, 'turn') p, taskLabel l, COUNT(*) n, COALESCE(SUM(costUsd),0) c,
          COALESCE(SUM(inputTokens + outputTokens + cacheRead + cacheWrite),0) t FROM runs WHERE ${where} GROUP BY p, l`).all(...args) as never
      : (this.q("SELECT purpose, label FROM run_tasks").all() as { purpose: string; label: string }[]).map((k) => ({
        p: k.purpose, l: k.label || null,
        ...(this.q(`SELECT COUNT(*) n, COALESCE(SUM(costUsd),0) c, COALESCE(SUM(inputTokens + outputTokens + cacheRead + cacheWrite),0) t
          FROM runs WHERE purpose = ? AND taskLabel IS ? AND startedAt >= ? AND startedAt < ?`).get(k.purpose, k.label || null, start, end) as { n: number; c: number; t: number }),
      })).filter((r) => r.n > 0);
    const tasks = new Map<string, UsageTaskRow>();
    for (const r of taskRows) {
      const g = purposeGroup(r.p);
      const key = r.l ? `routine:${r.l}` : `group:${g}`;
      const row = tasks.get(key) ?? { key, label: r.l ?? STR5.purposeLabels[g], kind: r.l ? "routine" as const : g === "conversations" ? "conversation" as const : "background" as const, runs: 0, usd: 0, tokens: 0 };
      row.runs += r.n; row.usd += r.c; row.tokens += r.t;
      tasks.set(key, row);
    }

    return {
      range, botId, start, end, totals: totalsOf(all), series, bots,
      tasks: [...tasks.values()].map((t) => ({ ...t, usd: round(t.usd) })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens),
      top: this.top(where, args),
    };
  }

  /** The most expensive runs: ranked on the covering index (rowid + cost), then only those rows are read. */
  private top(where: string, args: (string | number)[]): UsageTopRun[] {
    const ids = this.q(`SELECT rowid id FROM runs WHERE ${where} ORDER BY costUsd DESC LIMIT ${TOP_N}`).all(...args) as { id: number }[];
    if (!ids.length) return [];
    const rows = this.q(`SELECT r.requestId, r.botId, r.startedAt, r.costUsd, r.inputTokens + r.outputTokens + r.cacheRead + r.cacheWrite t, COALESCE(r.purpose, 'turn') p, r.taskLabel l,
        k.chatId, k.entryId FROM runs r LEFT JOIN run_links k ON k.requestId = r.requestId WHERE r.rowid IN (${ids.map(() => "?").join(",")})`)
      .all(...ids.map((x) => x.id)) as { requestId: string; botId: string; startedAt: number; costUsd: number; t: number; p: string; l: string | null; chatId: string | null; entryId: string | null }[];
    return rows
      .map((r) => {
        const g = purposeGroup(r.p);
        return {
          requestId: r.requestId, botId: r.botId, name: this.nameOf(r.botId), startedAt: r.startedAt, usd: round(r.costUsd), tokens: r.t,
          label: r.l ?? (g === "conversations" ? "Conversation" : STR5.purposeLabels[g]),
          link: r.chatId && r.entryId ? { chatId: r.chatId, entryId: r.entryId } : null,
        };
      })
      .sort((a, b) => b.usd - a.usd);
  }

  /** API dollars (list price) or tokens spent since `since` (ms), by one Bot or (null) the whole account. */
  spent(botId: string | null, since: number, unit: "usd" | "tokens"): number {
    const k = `${botId ?? "*"}\u0000${since}\u0000${unit}`;
    const hit = this.spentCache.get(k);
    if (hit) return unit === "usd" ? round(hit.v) : hit.v;
    if (this.spentCache.size > 256) this.spentCache.clear();
    const v = this.spentUncached(botId, since, unit);
    this.spentCache.set(k, { botId, since, unit, v });
    return v;
  }

  /** A recorded run moves every running total it belongs to, so a check after it stays a map lookup. */
  private addSpend(s: { botId: string; at: number; usd: number; tokens: number }): void {
    for (const e of this.spentCache.values()) {
      if ((e.botId === null || e.botId === s.botId) && s.at >= e.since) e.v += e.unit === "usd" ? s.usd : s.tokens;
    }
  }

  private spentUncached(botId: string | null, since: number, unit: "usd" | "tokens"): number {
    const col = unit === "usd" ? "costUsd" : "inputTokens + outputTokens + cacheRead + cacheWrite";
    const r = this.q(`SELECT COALESCE(SUM(${col}), 0) v FROM runs WHERE startedAt >= ?${botId ? " AND botId = ?" : ""}`).get(...(botId ? [since, botId] : [since])) as { v: number };
    return unit === "usd" ? round(r.v) : r.v;
  }

  /**
   * Settings → Usage "API spend" (API-key mode; ported from api-key-only): dollars today, this week and this month
   * (local calendar, the week as the dashboard's), for the account and per Bot. Each figure is a cached running total.
   */
  spendSummary(): SpendSummary {
    const now = this.d.now();
    const tz = this.d.tz();
    const since = { today: dayStartMs(now, tz), week: this.d.usage.weekStart(), month: monthStartMs(now, tz) };
    const of = (botId: string | null) => ({ today: this.spent(botId, since.today, "usd"), week: this.spent(botId, since.week, "usd"), month: this.spent(botId, since.month, "usd") });
    const ids = (this.q("SELECT botId FROM run_bots").all() as { botId: string }[]).map((r) => r.botId);
    const bots = ids.map((id) => ({ botId: id, name: this.nameOf(id), ...of(id) }))
      .filter((b) => b.today > 0 || b.week > 0 || b.month > 0)
      .sort((a, b) => b.month - a.month || b.week - a.week || a.name.localeCompare(b.name));
    return { ...of(null), bots };
  }

  /** What the next run will likely cost: the routine's last 5 runs, else the Bot's last 20 conversation turns. */
  estimate(botId: string, routineId?: string | null): { usd: number; tokens: number } {
    const avg = (rows: { c: number; t: number }[]) => rows.length
      ? { usd: round(rows.reduce((s, r) => s + r.c, 0) / rows.length), tokens: Math.round(rows.reduce((s, r) => s + r.t, 0) / rows.length) }
      : null;
    const tok = "inputTokens + outputTokens + cacheRead + cacheWrite";
    if (routineId) {
      const r = avg(this.q(`SELECT costUsd c, ${tok} t FROM runs WHERE routineId = ? ORDER BY startedAt DESC LIMIT 5`).all(routineId) as { c: number; t: number }[]);
      if (r) return r;
    }
    return avg(this.q(`SELECT costUsd c, ${tok} t FROM runs WHERE botId = ? AND purpose = 'turn' AND routineId IS NULL ORDER BY startedAt DESC LIMIT 20`).all(botId) as { c: number; t: number }[])
      ?? { usd: 0, tokens: 0 };
  }

  private nameOf(botId: string): string {
    if (botId === "host") return "Host checks";
    return this.d.bots.has(botId) ? this.d.bots.summary(botId).profile.name : "Removed Bot";
  }
}
