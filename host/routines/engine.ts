import { createHash } from "node:crypto";
import { LIMITS, type Trigger } from "@synapse/shared";
import { quietOf, nextRunOutsideQuiet } from "../schedule/quiet";
import { effectiveZone, parseSchedule } from "../schedule/schedule";
import type { ParsedSchedule } from "../schedule/types";
import { log } from "../util/log";
import type { RoutineRecord, RoutineStore } from "./routine-store";
import type { FireRow, IndexRow, SchedulerDb } from "./scheduler-db";

export const RUN_ID_NS = "3b241101-e2bb-4255-8caf-4136c566a962";

/** RFC 4122 §4.3 name-based UUID (SHA-1). */
export function uuidv5(name: string, ns: string = RUN_ID_NS): string {
  const h = createHash("sha1").update(Buffer.from(ns.replace(/-/g, ""), "hex")).update(name, "utf8").digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const scheduleRunId = (botId: string, routineId: string, scheduledForMs: number) => uuidv5(`${botId}\0${routineId}\0${scheduledForMs}`);
export const eventRunId = (botId: string, routineId: string, source: string, eventId: string) => uuidv5(`${botId}\0${routineId}\0${source}\0${eventId}`);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(s, "utf8")) {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** ORIG-02 §02.2: a deterministic 0–30 s offset per routine spreads the "8:00 AM" storm. */
export const jitterMs = (routineId: string) => (fnv1a(routineId) % (LIMITS.cronJitterMaxS + 1)) * 1000;

const JITTERED = new Set<IndexRow["kind"]>(["cron", "rrule", "mixed"]);
export const fireAtOf = (row: IndexRow, slot: number) => slot + (JITTERED.has(row.kind) ? jitterMs(row.routineId) : 0);

export interface PlanOutput { claims: { row: IndexRow; slot: number; missed?: number }[]; skips: { row: IndexRow; slot: number }[]; updated: IndexRow[] }

/**
 * Pure core of the engine loop (ORIG-02 §02.2, §02.5). Every due slot is claimed (≤ 60 s late) or skipped; the next slot is > now.
 * A catch-up routine (`catchUp(row)`) instead runs its latest missed slot once, with the missed count; never a burst.
 */
export function planTick(i: { rows: IndexRow[]; now: number; nextAfter(row: IndexRow, fromMs: number): number | null; catchUp?(row: IndexRow): boolean }): PlanOutput {
  const out: PlanOutput = { claims: [], skips: [], updated: [] };
  for (const row of i.rows) {
    if (!row.enabled || row.nextRunAt === null) continue;
    let slot: number | null = row.nextRunAt;
    let due: number | null = null;
    let n = 0;
    const rowSkips: { row: IndexRow; slot: number }[] = [];
    while (slot !== null && fireAtOf(row, slot) <= i.now) {
      if (due !== null) rowSkips.push({ row, slot: due });
      due = slot;
      if (++n >= 10_000) {
        slot = i.nextAfter(row, i.now);
        break;
      }
      slot = i.nextAfter(row, slot);
    }
    if (due === null) continue;
    const late = i.now - fireAtOf(row, due) > LIMITS.schedulerLatenessMs;
    if (late && i.catchUp?.(row)) out.claims.push({ row, slot: due, missed: n });
    else {
      out.skips.push(...rowSkips);
      if (late) out.skips.push({ row, slot: due });
      else out.claims.push({ row, slot: due });
    }
    out.updated.push({ ...row, nextRunAt: slot });
  }
  return out;
}

export interface EngineDeps {
  db: SchedulerDb;
  store: RoutineStore;
  botTz(botId: string): string;
  now(): number;
  mono(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** `missed` > 0: a catch-up run for that many slots missed while asleep. */
  onClaim(fire: FireRow, extra?: { missed: number }): void;
  onOfflineSkips(botIds: string[]): void;
}

function cronSchedules(t: Trigger | undefined): string[] {
  if (!t) return [];
  if ("cron" in t) return [t.cron.schedule];
  if ("group" in t) return t.group.listeners.flatMap(cronSchedules);
  return [];
}
function hasEventListener(t: Trigger | undefined): boolean {
  if (!t) return false;
  if ("cron" in t) return false;
  if ("group" in t) return t.group.listeners.some(hasEventListener);
  return true;
}

export class SchedulerEngine {
  private timer: unknown = null;
  private running = false;
  private lastHeartbeat = 0;
  private lastWall = 0;
  private lastMono = 0;

  constructor(private d: EngineDeps) {}

  private parsed(rec: RoutineRecord): ParsedSchedule[] {
    const tz = this.d.botTz(rec.botId);
    const all = [...(rec.def.schedule ? [rec.def.schedule] : []), ...cronSchedules(rec.def.trigger)];
    return all.flatMap((s) => {
      try {
        return [parseSchedule(s, { tz, nowMs: rec.def.createdAt })];
      } catch (e) {
        log.warn("routine has an unparsable schedule", { botId: rec.botId, routineId: rec.id, error: String(e) });
        return [];
      }
    });
  }

  /** RTN-07: earliest next occurrence across cron members, anchored at lastRunAt ?? createdAt. */
  private nextFor(rec: RoutineRecord, fromMs: number): number | null {
    const tz = this.d.botTz(rec.botId);
    const anchor = rec.def.lastRunAt ?? rec.def.createdAt;
    const quiet = quietOf(rec.def.quietHours);
    let best: number | null = null;
    for (const p of this.parsed(rec)) {
      const n = nextRunOutsideQuiet(p, fromMs, effectiveZone(p, tz), anchor, quiet);
      if (n !== null && (best === null || n < best)) best = n;
    }
    return best;
  }

  private rowFor(rec: RoutineRecord, fromMs: number): IndexRow {
    const ps = this.parsed(rec);
    const kind: IndexRow["kind"] = !ps.length ? "event" : ps.length > 1 || hasEventListener(rec.def.trigger) ? "mixed" : ps[0]!.kind;
    return {
      botId: rec.botId, routineId: rec.id, defHash: rec.defHash, enabled: rec.def.enabled, kind,
      tz: ps[0] ? effectiveZone(ps[0], this.d.botTz(rec.botId)) : null,
      nextRunAt: rec.def.enabled && ps.length ? this.nextFor(rec, fromMs) : null,
    };
  }

  private nextAfter = (row: IndexRow, fromMs: number): number | null => {
    const rec = this.d.store.get(row.botId, row.routineId);
    return rec && rec.def.enabled ? this.nextFor(rec, fromMs) : null;
  };

  /** Rebuild the derived index from automation.json; hand back owed fires (re-queue) and fires that were running at the crash. */
  boot(): { recovered: FireRow[]; interrupted: FireRow[] } {
    const now = this.d.now();
    const last = Number(this.d.db.meta("last_tick_at") ?? 0);
    if (last && now - last > LIMITS.clockJumpMs) log.info("scheduler: host was down; missed slots will be skipped", { downMs: now - last });
    const old = new Map(this.d.db.index().map((r) => [`${r.botId}/${r.routineId}`, r]));
    const seen = new Set<string>();
    for (const rec of this.d.store.all()) {
      const key = `${rec.botId}/${rec.id}`;
      seen.add(key);
      const prev = old.get(key);
      // 0.1.4 first-run: a row computed in another time zone (the Mac moved zones while the host was down) is redone too.
      if (prev && prev.defHash === rec.defHash && prev.enabled === rec.def.enabled && !this.zoneMoved(prev, rec)) continue; // past next_run_at values are skipped by tick()
      this.d.db.upsertIndex(this.rowFor(rec, now));
    }
    for (const [key, r] of old) if (!seen.has(key)) this.d.db.deleteIndex(r.botId, r.routineId);
    this.lastWall = now;
    this.lastMono = this.d.mono();
    return {
      recovered: this.d.db.fires({ states: ["claimed", "gated", "queued", "retry_wait"] }),
      interrupted: this.d.db.fires({ states: ["running"] }),
    };
  }

  /** Recompute index rows after a store change; a changed definition or re-enable recomputes from now (saving never runs it). */
  reindex(botId: string, routineId: string | null): void {
    const now = this.d.now();
    const recs = routineId === null ? this.d.store.list(botId) : [this.d.store.get(botId, routineId)].filter((r): r is RoutineRecord => r !== null);
    const keep = new Set(recs.map((r) => r.id));
    for (const row of this.d.db.index()) {
      if (row.botId !== botId) continue;
      if ((routineId === null || row.routineId === routineId) && !keep.has(row.routineId)) this.d.db.deleteIndex(botId, row.routineId);
    }
    const rows = new Map(this.d.db.index().map((r) => [`${r.botId}/${r.routineId}`, r]));
    for (const rec of recs) {
      const prev = rows.get(`${rec.botId}/${rec.id}`);
      if (!prev || prev.defHash !== rec.defHash || prev.enabled !== rec.def.enabled) this.d.db.upsertIndex(this.rowFor(rec, now));
    }
    if (this.running) this.arm();
  }

  /** A scheduled row whose zone is no longer the zone its schedule runs in now. */
  private zoneMoved(row: IndexRow, rec: RoutineRecord): boolean {
    const ps = this.parsed(rec);
    return !!ps[0] && row.tz !== effectiveZone(ps[0], this.d.botTz(rec.botId));
  }

  /**
   * 0.1.4 first-run (code audit 6.1): the user's time zone changed (the Mac moved zones, or Settings → Time zone).
   * Every scheduled row that follows the user's zone gets its next run recomputed from now in the new zone; rows with
   * an explicit zone of their own are left alone. Returns how many rows moved.
   */
  rezone(): number {
    const now = this.d.now();
    const rows = new Map(this.d.db.index().map((r) => [`${r.botId}/${r.routineId}`, r]));
    let moved = 0;
    for (const rec of this.d.store.all()) {
      const prev = rows.get(`${rec.botId}/${rec.id}`);
      if (!prev || !this.zoneMoved(prev, rec)) continue;
      this.d.db.upsertIndex(this.rowFor(rec, now));
      moved++;
    }
    if (moved && this.running) this.arm();
    return moved;
  }

  nextRunAt(botId: string, routineId: string): number | null {
    return this.d.db.index().find((r) => r.botId === botId && r.routineId === routineId)?.nextRunAt ?? null;
  }

  tick(): void {
    const now = this.d.now();
    const mono = this.d.mono();
    if (this.lastMono && now - this.lastWall - (mono - this.lastMono) > LIMITS.clockJumpMs) log.info("scheduler: clock jump (sleep) detected", { jumpMs: now - this.lastWall });
    this.lastWall = now;
    this.lastMono = mono;
    if (now - this.lastHeartbeat >= LIMITS.schedulerHeartbeatMs) {
      this.d.db.setMeta("last_tick_at", String(now));
      this.lastHeartbeat = now;
    }
    const plan = planTick({ rows: this.d.db.index(), now, nextAfter: this.nextAfter, catchUp: (row) => this.d.store.get(row.botId, row.routineId)?.def.catchUp === true });
    for (const r of plan.updated) this.d.db.upsertIndex(r);
    for (const s of plan.skips) this.d.db.addOfflineSkip(s.row.botId, s.row.routineId, s.slot);
    for (const c of plan.claims) {
      const runId = scheduleRunId(c.row.botId, c.row.routineId, c.slot);
      const claimed = this.d.db.claimFire({ runId, botId: c.row.botId, routineId: c.row.routineId, trigger: "schedule", scheduledFor: c.slot, defHash: c.row.defHash, eventJson: null, dedupeKey: runId }, now);
      const fire = claimed ? this.d.db.fire(runId) : null;
      if (fire) this.d.onClaim(fire, c.missed ? { missed: c.missed } : undefined);
    }
    if (plan.skips.length) this.d.onOfflineSkips([...new Set(plan.skips.map((s) => s.row.botId))]);
    if (this.running) this.arm();
  }

  private arm(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    const now = this.d.now();
    let next = now + LIMITS.schedulerMaxSleepMs;
    for (const r of this.d.db.index()) if (r.enabled && r.nextRunAt !== null) next = Math.min(next, fireAtOf(r, r.nextRunAt));
    this.timer = this.d.setTimer(() => this.tick(), Math.max(0, Math.min(LIMITS.schedulerMaxSleepMs, next - now)));
  }

  start(): void {
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }
}
