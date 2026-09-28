import { LIMITS, LIMITS_SCHED } from "@synapse/shared";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import { eventRunId, uuidv5 } from "../routines/engine";
import type { FireConsumer } from "../routines/fire-consumer";
import type { RoutineRecord, RoutineStore } from "../routines/routine-store";
import type { SchedulerDb } from "../routines/scheduler-db";
import { matchesTrigger, triggerSources } from "./match";
import type { TriggerEvent } from "./types";

export interface EventQueueDeps {
  store: RoutineStore;
  db: SchedulerDb;
  consumer: FireConsumer;
  metrics: RuntimeMetrics | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  debounceMs?: number;
  workspace?: string;
  /** I10: the Bot's scanner; event text is redacted before it is queued, stored (scheduler.db, runs.json) or rendered into a wake. */
  redact?(botId: string, text: string): string;
  /** A routine hit its daily cap (once per cap window): the caller tells the user. */
  onDailyCap?(botId: string, routineId: string): void;
}

/** I10: every free-text field of an event, and its raw payload, through the Bot's scanner. */
export function redactEvent(ev: TriggerEvent, redact: (text: string) => string): TriggerEvent {
  const opt = (v: string | undefined) => (v === undefined ? v : redact(v));
  let raw: TriggerEvent["raw"] = ev.raw;
  try {
    raw = JSON.parse(redact(JSON.stringify(ev.raw ?? {}))) as TriggerEvent["raw"];
  } catch {
    raw = { redacted: true };
  }
  return { ...ev, text: redact(ev.text), subject: opt(ev.subject), actor: opt(ev.actor), url: opt(ev.url), path: opt(ev.path), raw };
}

interface Item { ev: TriggerEvent; runId: string; key: string }
interface Batch { botId: string; routineId: string; items: Item[]; timer: unknown | null; firstAt: number }

const MAX_HOLD_FACTOR = 4;

/** RTN-15 / ORIG-04 §04.1: match, dedupe (24 h), debounce (750 ms), coalesce (≤ 25 per wake), queue (≤ 500). */
export class EventQueue {
  private batches = new Map<string, Batch>();
  private since = new Map<string, { defHash: string; at: number }>();
  private lastFlush = new Map<string, number>(); // per routine; survives the batch (file spacing)
  /** Per routine: when each accepted wake started, for the rolling 24 h daily cap. */
  private started = new Map<string, number[]>();
  private capNoted = new Map<string, number>();

  constructor(private d: EventQueueDeps) {}

  pending(botId: string, routineId: string): number {
    return this.batches.get(`${botId}/${routineId}`)?.items.length ?? 0;
  }

  ingest(raw: TriggerEvent, only?: { botId: string; routineId: string }): { botId: string; routineId: string; runId: string; duplicate: boolean }[] {
    const now = this.d.now();
    const out: { botId: string; routineId: string; runId: string; duplicate: boolean }[] = [];
    const recs = only ? [this.d.store.get(only.botId, only.routineId)].filter((r): r is RoutineRecord => r !== null) : this.d.store.all();
    for (const r of recs) {
      if (!r.def.enabled || !r.def.trigger) continue;
      const ev = this.d.redact ? redactEvent(raw, (t) => this.d.redact!(r.botId, t)) : raw;
      if (!matchesTrigger(r.def.trigger, ev, { savedAt: this.activeSince(r), workspace: this.d.workspace })) continue;
      const runId = eventRunId(r.botId, r.id, ev.source, ev.eventId);
      const key = `${ev.source}:${ev.eventId}@${r.botId}/${r.id}`;
      const bk = `${r.botId}/${r.id}`;
      let b = this.batches.get(bk);
      if (b?.items.some((i) => i.key === key) || this.d.db.dedupeSeen(key, now - LIMITS.webhookDedupeMs)) {
        out.push({ botId: r.botId, routineId: r.id, runId, duplicate: true });
        continue;
      }
      if (!b) {
        b = { botId: r.botId, routineId: r.id, items: [], timer: null, firstAt: now };
        this.batches.set(bk, b);
      }
      if (!b.items.length) b.firstAt = now;
      b.items.push({ ev, runId, key });
      while (b.items.length > LIMITS.eventsQueuedMax) this.shed(r, b.items.shift()!);
      this.arm(b, r);
      out.push({ botId: r.botId, routineId: r.id, runId, duplicate: false });
    }
    return out;
  }

  /** "Only events after save/Active count": the time the routine's defHash last changed (it covers `enabled`). */
  private activeSince(r: RoutineRecord): number {
    const k = `${r.botId}/${r.id}`;
    const cur = this.since.get(k);
    if (cur?.defHash === r.defHash) return cur.at;
    const at = cur ? this.d.now() : r.def.createdAt;
    this.since.set(k, { defHash: r.defHash, at });
    return at;
  }

  private arm(b: Batch, r: RoutineRecord): void {
    if (b.timer !== null) this.d.clearTimer(b.timer);
    const now = this.d.now();
    const debounce = this.d.debounceMs ?? LIMITS.eventDebounceMs;
    let delay = Math.max(0, Math.min(debounce, b.firstAt + MAX_HOLD_FACTOR * debounce - now));
    const isFile = r.def.trigger ? triggerSources(r.def.trigger).includes("file") : false;
    const last = this.lastFlush.get(`${b.botId}/${b.routineId}`);
    if (isFile && last !== undefined) delay = Math.max(delay, last + LIMITS.fileTriggerMinSpacingMs - now);
    b.timer = this.d.setTimer(() => this.flush(b), delay);
  }

  private flush(b: Batch): void {
    b.timer = null;
    const bk = `${b.botId}/${b.routineId}`;
    const r = this.d.store.get(b.botId, b.routineId);
    if (!r || !r.def.enabled) { this.batches.delete(bk); return; }
    const take = b.items.splice(0, LIMITS.eventsPerWake);
    if (!take.length) { this.batches.delete(bk); return; }
    if (this.overCap(r)) {
      // Rate limit, not a failure: the events are recorded as dropped (so a resend is still deduped) and no model wakes.
      const now = this.d.now();
      for (const i of [...take, ...b.items.splice(0)]) this.dropCapped(r, i, now);
      this.batches.delete(bk);
      return;
    }
    const first = take[0]!;
    const res = this.d.consumer.submit({
      runId: first.runId, botId: b.botId, routineId: b.routineId, trigger: "event", scheduledFor: first.ev.occurredAt, defHash: r.defHash,
      events: take.map((i) => i.ev), coalescedRunIds: take.slice(1).map((i) => i.runId),
    });
    const now = this.d.now();
    if (res.accepted) {
      this.started.set(bk, [...(this.started.get(bk) ?? []), now]);
      for (const i of take) this.mark(r, i, now);
      if (take.length >= 2) this.d.metrics?.bump(b.botId, "coalescedTurns");
    }
    this.lastFlush.set(bk, now);
    if (b.items.length) {
      b.firstAt = now;
      this.arm(b, r);
    } else this.batches.delete(bk);
  }

  private overCap(r: RoutineRecord): boolean {
    const bk = `${r.botId}/${r.id}`;
    const since = this.d.now() - 24 * 3_600_000;
    const recent = (this.started.get(bk) ?? []).filter((t) => t > since);
    this.started.set(bk, recent);
    const cap = r.def.dailyCap ?? LIMITS_SCHED.triggerDailyCapDefault;
    if (recent.length < cap) return false;
    const noted = this.capNoted.get(bk);
    if (noted === undefined || noted <= since) {
      this.capNoted.set(bk, this.d.now());
      this.d.onDailyCap?.(r.botId, r.id);
    }
    return true;
  }

  private dropCapped(r: RoutineRecord, i: Item, now: number): void {
    if (this.d.db.claimFire({ runId: i.runId, botId: r.botId, routineId: r.id, trigger: "event", scheduledFor: i.ev.occurredAt, defHash: r.defHash, eventJson: null, dedupeKey: i.key, state: "dropped" }, now)) {
      this.d.db.setFireState(i.runId, "dropped", "daily_cap", now);
    }
  }

  private mark(r: RoutineRecord, i: Item, now: number): void {
    const id = uuidv5(`dedupe\0${i.runId}`);
    if (this.d.db.claimFire({ runId: id, botId: r.botId, routineId: r.id, trigger: "event", scheduledFor: i.ev.occurredAt, defHash: r.defHash, eventJson: null, dedupeKey: i.key, state: "dropped" }, now)) {
      this.d.db.setFireState(id, "dropped", "dedupe-marker", now);
    }
  }

  private shed(r: RoutineRecord, i: Item): void {
    const now = this.d.now();
    if (this.d.db.claimFire({ runId: i.runId, botId: r.botId, routineId: r.id, trigger: "event", scheduledFor: i.ev.occurredAt, defHash: r.defHash, eventJson: null, dedupeKey: i.key, state: "dropped" }, now)) {
      this.d.db.setFireState(i.runId, "dropped", "event_batch_overflow", now);
    }
  }
}
