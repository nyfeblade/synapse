import { DatabaseSync } from "node:sqlite";
import type { EfficiencyTotals, EfficiencyView } from "@synapse/shared";

export type EfficiencyField = keyof EfficiencyTotals;
export type B2BMetricEvent = {
  botId: string;
  chainId: string | null;
  event: "sent" | "dropped" | "rejected" | "inbox" | "classifier_call" | "classifier_cache_hit" | "terminated" | "coalesced";
  kind?: string;
  reason?: string;
};

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const KEEP_MS = 30 * DAY;
const COLS: Record<EfficiencyField, string> = {
  dropped: "dropped", inboxDelivered: "inbox_delivered", resultsBatched: "results_batched", coalescedTurns: "coalesced_turns", loopsEnded: "loops_ended",
};

function offsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(utcMs / 1000) * 1000;
}

/** USE-05: the weekly period aligned to the weekly reset when known, else Monday 00:00 in the user's zone. */
export function weekStartOf(ms: number, tz: string, weeklyResetAt: number | null): number {
  if (weeklyResetAt !== null) return weeklyResetAt + Math.floor((ms - weeklyResetAt) / WEEK) * WEEK; // latest reset boundary ≤ ms
  const local = new Date(ms + offsetMs(ms, tz));
  const back = (local.getUTCDay() + 6) % 7; // days since Monday
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back);
  let guess = midnightLocal - offsetMs(midnightLocal, tz);
  guess = midnightLocal - offsetMs(guess, tz); // second pass settles DST days
  return guess;
}

export class RuntimeMetrics {
  private db: DatabaseSync;
  private now: () => number;

  constructor(file: string, private o: { now?(): number; timeZone(): string; weeklyResetAt?(): number | null; onChange?(v: EfficiencyView): void }) {
    this.now = o.now ?? Date.now;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS efficiency_week (
        week_start INTEGER NOT NULL, bot_id TEXT NOT NULL,
        dropped INTEGER NOT NULL DEFAULT 0, inbox_delivered INTEGER NOT NULL DEFAULT 0, results_batched INTEGER NOT NULL DEFAULT 0,
        coalesced_turns INTEGER NOT NULL DEFAULT 0, loops_ended INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (week_start, bot_id));
      CREATE TABLE IF NOT EXISTS b2b_events (ts INTEGER NOT NULL, bot_id TEXT NOT NULL, chain_id TEXT, event TEXT NOT NULL, kind TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS b2b_events_ts ON b2b_events(ts);
    `);
  }

  private weekStart(): number {
    return weekStartOf(this.now(), this.o.timeZone(), this.o.weeklyResetAt?.() ?? null);
  }

  bump(botId: string, field: EfficiencyField, by = 1): void {
    const col = COLS[field];
    this.db.prepare(`INSERT INTO efficiency_week(week_start, bot_id, ${col}) VALUES(?, ?, ?) ON CONFLICT(week_start, bot_id) DO UPDATE SET ${col} = ${col} + excluded.${col}`)
      .run(this.weekStart(), botId, by);
    this.o.onChange?.(this.efficiency());
  }

  recordB2B(e: B2BMetricEvent): void {
    const t = this.now();
    this.db.prepare("INSERT INTO b2b_events(ts, bot_id, chain_id, event, kind, reason) VALUES(?, ?, ?, ?, ?, ?)").run(t, e.botId, e.chainId, e.event, e.kind ?? null, e.reason ?? null);
    this.db.prepare("DELETE FROM b2b_events WHERE ts < ?").run(t - KEEP_MS);
  }

  byBot(): Record<string, EfficiencyTotals> {
    const rows = this.db.prepare("SELECT * FROM efficiency_week WHERE week_start = ?").all(this.weekStart()) as Record<string, number | string>[];
    return Object.fromEntries(rows.map((r) => [r.bot_id as string, {
      dropped: Number(r.dropped), inboxDelivered: Number(r.inbox_delivered), resultsBatched: Number(r.results_batched),
      coalescedTurns: Number(r.coalesced_turns), loopsEnded: Number(r.loops_ended),
    }]));
  }

  /** ORIG-18 §18.7 tile formulas; ORIG-09 §09.9's broader total is `wakesAvoidedTotal` (Advanced). */
  efficiency(): EfficiencyView {
    const t = Object.values(this.byBot()).reduce<EfficiencyTotals>(
      (a, b) => ({ dropped: a.dropped + b.dropped, inboxDelivered: a.inboxDelivered + b.inboxDelivered, resultsBatched: a.resultsBatched + b.resultsBatched, coalescedTurns: a.coalescedTurns + b.coalescedTurns, loopsEnded: a.loopsEnded + b.loopsEnded }),
      { dropped: 0, inboxDelivered: 0, resultsBatched: 0, coalescedTurns: 0, loopsEnded: 0 },
    );
    return {
      weekStart: this.weekStart(),
      messagesDropped: t.dropped,
      wakesAvoided: t.inboxDelivered + t.resultsBatched,
      burstsCoalesced: t.coalescedTurns,
      loopsEnded: t.loopsEnded,
      wakesAvoidedTotal: t.dropped + t.inboxDelivered + t.resultsBatched + t.coalescedTurns,
    };
  }

  b2bCounts(sinceMs: number): Record<string, number> {
    const rows = this.db.prepare("SELECT event, COUNT(*) AS n FROM b2b_events WHERE ts >= ? GROUP BY event").all(sinceMs) as { event: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.event, Number(r.n)]));
  }

  close(): void {
    this.db.close();
  }
}
