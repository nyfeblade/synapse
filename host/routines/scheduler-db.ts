import { DatabaseSync } from "node:sqlite";
import { LIMITS } from "@synapse/shared";

export type FireState = "claimed" | "gated" | "queued" | "running" | "retry_wait" | "finished_ok" | "finished_error" | "dropped";
/** C1: "bot-run" = a Bot asked for a run (update_state action "run"); reviewed, guarded and capped like a scheduled fire. */
export type FireTrigger = "schedule" | "manual" | "event" | "retry" | "bot-run";
export interface FireRow {
  runId: string; botId: string; routineId: string; trigger: FireTrigger; scheduledFor: number; defHash: string; state: FireState;
  reason: string | null; attempts: number; eventJson: string | null; dedupeKey: string | null; createdAt: number; updatedAt: number;
}
export interface IndexRow {
  botId: string; routineId: string; defHash: string; enabled: boolean; kind: "cron" | "rrule" | "every" | "once" | "event" | "mixed"; tz: string | null; nextRunAt: number | null;
}

type Raw = Record<string, string | number | null>;
const toFire = (r: Raw): FireRow => ({
  runId: String(r.run_id), botId: String(r.bot_id), routineId: String(r.routine_id), trigger: r.trigger as FireTrigger,
  scheduledFor: Number(r.scheduled_for), defHash: String(r.def_hash), state: r.state as FireState, reason: (r.reason as string | null) ?? null,
  attempts: Number(r.attempts ?? 0), eventJson: (r.event_json as string | null) ?? null, dedupeKey: (r.dedupe_key as string | null) ?? null,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
const toIndex = (r: Raw): IndexRow => ({
  botId: String(r.bot_id), routineId: String(r.routine_id), defHash: String(r.def_hash), enabled: Number(r.enabled) === 1,
  kind: r.kind as IndexRow["kind"], tz: (r.tz as string | null) ?? null, nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
});

/** ORIG-02 §02.1: `/home/box/.host/scheduler.db` — derived index, fires ledger (30 days), offline skips, meta. */
export class SchedulerDb {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedule_index (
        bot_id TEXT, routine_id TEXT, def_hash TEXT, enabled INTEGER,
        kind TEXT,
        tz TEXT, next_run_at INTEGER,
        PRIMARY KEY (bot_id, routine_id));
      CREATE TABLE IF NOT EXISTS fires (
        run_id TEXT PRIMARY KEY,
        bot_id TEXT, routine_id TEXT,
        trigger TEXT,
        scheduled_for INTEGER, def_hash TEXT,
        state TEXT,
        reason TEXT, attempts INTEGER DEFAULT 0,
        event_json TEXT, dedupe_key TEXT UNIQUE,
        created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS offline_skips (bot_id TEXT, routine_id TEXT, count INTEGER, first_at INTEGER, last_at INTEGER,
        PRIMARY KEY (bot_id, routine_id));
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  upsertIndex(r: IndexRow): void {
    this.db
      .prepare(`INSERT INTO schedule_index(bot_id, routine_id, def_hash, enabled, kind, tz, next_run_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(bot_id, routine_id) DO UPDATE SET def_hash=excluded.def_hash, enabled=excluded.enabled, kind=excluded.kind, tz=excluded.tz, next_run_at=excluded.next_run_at`)
      .run(r.botId, r.routineId, r.defHash, r.enabled ? 1 : 0, r.kind, r.tz, r.nextRunAt);
  }
  deleteIndex(botId: string, routineId?: string): void {
    if (routineId === undefined) this.db.prepare("DELETE FROM schedule_index WHERE bot_id = ?").run(botId);
    else this.db.prepare("DELETE FROM schedule_index WHERE bot_id = ? AND routine_id = ?").run(botId, routineId);
  }
  index(): IndexRow[] {
    return (this.db.prepare("SELECT * FROM schedule_index ORDER BY bot_id, routine_id").all() as Raw[]).map(toIndex);
  }

  /** INSERT … ON CONFLICT DO NOTHING on either unique key (run_id, dedupe_key). */
  claimFire(f: { runId: string; botId: string; routineId: string; trigger: FireTrigger; scheduledFor: number; defHash: string; eventJson: string | null; dedupeKey: string | null; state?: FireState }, now: number): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO fires(run_id, bot_id, routine_id, trigger, scheduled_for, def_hash, state, reason, attempts, event_json, dedupe_key, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,0,?,?,?,?)`)
      .run(f.runId, f.botId, f.routineId, f.trigger, f.scheduledFor, f.defHash, f.state ?? "claimed", f.eventJson, f.dedupeKey, now, now);
    return Number(res.changes) > 0;
  }
  setFireState(runId: string, state: FireState, reason: string | null, now: number): void {
    this.db.prepare("UPDATE fires SET state = ?, reason = ?, updated_at = ? WHERE run_id = ?").run(state, reason, now, runId);
  }
  bumpAttempts(runId: string): number {
    this.db.prepare("UPDATE fires SET attempts = attempts + 1 WHERE run_id = ?").run(runId);
    return this.fire(runId)?.attempts ?? 0;
  }
  fire(runId: string): FireRow | null {
    const r = this.db.prepare("SELECT * FROM fires WHERE run_id = ?").get(runId) as Raw | undefined;
    return r ? toFire(r) : null;
  }
  fires(q: { botId?: string; routineId?: string; states?: FireState[] }): FireRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.botId !== undefined) { where.push("bot_id = ?"); args.push(q.botId); }
    if (q.routineId !== undefined) { where.push("routine_id = ?"); args.push(q.routineId); }
    if (q.states?.length) { where.push(`state IN (${q.states.map(() => "?").join(",")})`); args.push(...q.states); }
    const sql = `SELECT * FROM fires${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY scheduled_for, created_at`;
    return (this.db.prepare(sql).all(...args) as Raw[]).map(toFire);
  }
  dedupeSeen(key: string, sinceMs: number): boolean {
    return this.db.prepare("SELECT 1 FROM fires WHERE dedupe_key = ? AND created_at >= ?").get(key, sinceMs) !== undefined;
  }

  addOfflineSkip(botId: string, routineId: string, at: number): void {
    this.db
      .prepare(`INSERT INTO offline_skips(bot_id, routine_id, count, first_at, last_at) VALUES(?,?,1,?,?)
        ON CONFLICT(bot_id, routine_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`)
      .run(botId, routineId, at, at);
  }
  offlineSkips(botId?: string): { botId: string; routineId: string; count: number; firstAt: number; lastAt: number }[] {
    const rows = (botId === undefined
      ? this.db.prepare("SELECT * FROM offline_skips ORDER BY bot_id, routine_id").all()
      : this.db.prepare("SELECT * FROM offline_skips WHERE bot_id = ? ORDER BY routine_id").all(botId)) as Raw[];
    return rows.map((r) => ({ botId: String(r.bot_id), routineId: String(r.routine_id), count: Number(r.count), firstAt: Number(r.first_at), lastAt: Number(r.last_at) }));
  }
  /** I7: a deleted Bot leaves no fires (incl. event_json), index rows or offline skips behind. */
  removeBot(botId: string): void {
    for (const t of ["fires", "schedule_index", "offline_skips"]) this.db.prepare(`DELETE FROM ${t} WHERE bot_id = ?`).run(botId);
  }

  clearOfflineSkips(botId: string): void {
    this.db.prepare("DELETE FROM offline_skips WHERE bot_id = ?").run(botId);
  }

  meta(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }
  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  /** Fires are kept 30 days; event dedupe keys only 24 h (ORIG-04 §04.1), so a source may legitimately repeat an id later. */
  prune(now: number): void {
    this.db.prepare("DELETE FROM fires WHERE created_at < ?").run(now - LIMITS.firesKeptMs);
    this.db.prepare("UPDATE fires SET dedupe_key = NULL WHERE trigger = 'event' AND dedupe_key IS NOT NULL AND created_at < ?").run(now - LIMITS.webhookDedupeMs);
  }

  close(): void {
    this.db.close();
  }
}
