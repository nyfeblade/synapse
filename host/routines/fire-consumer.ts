import { randomUUID } from "node:crypto";
import { LIMITS, STR, type RoutineRun, type RunTrigger } from "@synapse/shared";
import type { ErrorCode } from "../brain/types";
import type { TriggerEvent } from "../triggers/types";
import type { RoutineRecord, RoutineStore } from "./routine-store";
import type { FireRow, FireState, FireTrigger, SchedulerDb } from "./scheduler-db";

export type DropReason =
  | "automation_missing" | "already_finished" | "disabled" | "slot_already_covered" | "definition_changed" | "trigger_no_longer_matches"
  | "missing_event_context" | "duplicate_in_flight" | "user_away_paused" | "usage_paused" | "event_batch_overflow";

export interface FireRequest {
  runId: string; botId: string; routineId: string; trigger: FireTrigger; scheduledFor: number; defHash: string;
  events?: TriggerEvent[]; coalescedRunIds?: string[]; bypassGate?: boolean;
  /** C1: a Bot-initiated run continues the calling turn's chain (loop/chain budget). */
  chainId?: string;
  /** A catch-up run after sleep: how many slots were missed (the engine claims the latest one only). */
  caughtUp?: number;
}
export interface RoutineTurnOutcome {
  status: "ok" | "error"; detail?: string; sideEffects: number; errorCode?: ErrorCode; requestId: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}
export interface RoutineTurnStarter { start(req: FireRequest, run: RoutineRun, done: (o: RoutineTurnOutcome) => void): void }
export interface ConsumerDeps {
  db: SchedulerDb;
  store: RoutineStore;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  starter: RoutineTurnStarter;
  guard(botId: string): "ok" | "paused";
  /** RTN-20 usage pause, plus Phase 5's ladder (USE-03/04) for this routine when wired. */
  usagePaused(routineId?: string): boolean;
  nextSlot(botId: string, routineId: string): number | null;
  eventMatches(r: RoutineRecord, ev: TriggerEvent): boolean;
  onFinished?(req: FireRequest, o: RoutineTurnOutcome): void;
  onDropped?(req: FireRequest, reason: DropReason): void;
  retryDelaysMs?: number[];
  resume?(botId: string): void;
  /** Belt-and-braces: how long one gate slot may be held before it is assumed lost. Tests override it. */
  holdTimeoutMs?: number;
}

const TRANSIENT: ErrorCode[] = ["BOT-E0401", "BOT-E0403", "BOT-E0406", "BOT-E0408"];
const IN_FLIGHT: FireState[] = ["claimed", "gated", "queued", "running", "retry_wait"];
/** A run is reported by RoutineTurns; the routine hard limit stops it after an hour. Anything still
 *  holding a slot well past that was lost on a path that never reported, and the slot is reclaimed. */
const HOLD_TIMEOUT_MS = LIMITS.routineHardLimitMs + 15 * 60_000;

export class FireConsumer {
  private holding = new Map<string, number>(); // run id → the ms it took the gate slot (queued → finished)
  private gated: FireRequest[] = [];
  private retryRuns = new Map<string, RoutineRun>();

  constructor(private d: ConsumerDeps) {}

  runningCount(): number {
    return this.holding.size;
  }
  gatedCount(): number {
    return this.gated.length;
  }

  submit(req: FireRequest): { accepted: boolean; reason?: DropReason; runId: string } {
    const existing = this.d.db.fire(req.runId);
    if (existing && existing.state !== "claimed") return this.drop(req, "already_finished", false);
    if (!existing) {
      const claimed = this.d.db.claimFire(
        { runId: req.runId, botId: req.botId, routineId: req.routineId, trigger: req.trigger, scheduledFor: req.scheduledFor, defHash: req.defHash, eventJson: req.events ? JSON.stringify(req.events) : null, dedupeKey: null },
        this.d.now(),
      );
      if (!claimed) return this.drop(req, "already_finished", false);
    }
    return this.admit(req, false);
  }

  markRunning(runId: string): void {
    this.d.db.setFireState(runId, "running", null, this.d.now());
  }

  /** ORIG-02 §02.5: a claimed/gated/queued fire was accepted before the crash — owed work, not a missed slot. */
  recover(fires: FireRow[]): void {
    for (const f of fires) {
      this.admit({ runId: f.runId, botId: f.botId, routineId: f.routineId, trigger: f.trigger, scheduledFor: f.scheduledFor, defHash: f.defHash, events: f.eventJson ? (JSON.parse(f.eventJson) as TriggerEvent[]) : undefined, bypassGate: f.trigger === "manual" }, true); // C1: a recovered bot-run is never bypassed
    }
  }

  /** EVT-19: a fire that was running at the crash is recorded as interrupted and the Bot is resumed (wake #18). */
  markInterrupted(fires: FireRow[]): void {
    const now = this.d.now();
    for (const f of fires) {
      this.d.db.setFireState(f.runId, "finished_error", "interrupted", now);
      const runs = this.d.store.get(f.botId, f.routineId) ? this.d.store.runs(f.botId, f.routineId) : [];
      const run = runs.find((r) => r.id === f.runId) ?? runs.find((r) => r.status === "running");
      if (run) this.d.store.upsertRun(f.botId, f.routineId, { ...run, status: "error", finishedAt: now, detail: STR.runInterrupted });
      this.d.resume?.(f.botId);
    }
  }

  private drop(req: FireRequest, reason: DropReason, record = true): { accepted: false; reason: DropReason; runId: string } {
    if (record) this.d.db.setFireState(req.runId, "dropped", reason, this.d.now());
    this.d.onDropped?.(req, reason);
    return { accepted: false, reason, runId: req.runId };
  }

  private admit(req: FireRequest, recovering: boolean): { accepted: boolean; reason?: DropReason; runId: string } {
    this.sweepHolding();
    const rec = this.d.store.get(req.botId, req.routineId);
    const manual = req.trigger === "manual";
    if (!rec) return this.drop(req, "automation_missing");
    if (!manual && !rec.def.enabled) return this.drop(req, "disabled");
    if (!recovering && req.trigger === "schedule" && rec.def.lastRunAt !== undefined && rec.def.lastRunAt >= req.scheduledFor) return this.drop(req, "slot_already_covered");
    if ((req.trigger === "schedule" || req.trigger === "event") && req.defHash !== rec.defHash) return this.drop(req, "definition_changed");
    if (req.trigger === "event") {
      const evs = req.events ?? [];
      if (evs.length && !evs.some((e) => this.d.eventMatches(rec, e))) return this.drop(req, "trigger_no_longer_matches");
      if (!evs.length) return this.drop(req, "missing_event_context");
    }
    if (!recovering && req.trigger !== "event" && req.trigger !== "retry") {
      const other = this.d.db.fires({ botId: req.botId, routineId: req.routineId, states: IN_FLIGHT }).some((f) => f.runId !== req.runId && f.trigger !== "event");
      if (other) return this.drop(req, "duplicate_in_flight");
    }
    if (!manual && this.d.guard(req.botId) === "paused") return this.drop(req, "user_away_paused");
    if (!manual && this.d.usagePaused(req.routineId)) return this.drop(req, "usage_paused");
    if (manual || req.bypassGate || this.holding.size < LIMITS.concurrentRoutineTurns) this.start(req);
    else {
      this.d.db.setFireState(req.runId, "gated", null, this.d.now());
      this.gated.push(req);
      this.gated.sort((a, b) => a.scheduledFor - b.scheduledFor);
    }
    return { accepted: true, runId: req.runId };
  }

  private start(req: FireRequest): void {
    const now = this.d.now();
    this.holding.set(req.runId, now);
    this.d.db.setFireState(req.runId, "queued", null, now);
    if (req.trigger !== "retry" && this.d.store.get(req.botId, req.routineId)) this.d.store.update(req.botId, req.routineId, { lastRunAt: now });
    const events = req.events ?? [];
    const run: RoutineRun = this.retryRuns.get(req.runId) ?? {
      id: req.runId, trigger: runTriggerOf(req.trigger), startedAt: now, finishedAt: null, status: "running", requestId: "",
      ...(req.caughtUp ? { caughtUp: req.caughtUp } : {}),
      ...(req.coalescedRunIds?.length ? { coalescedRunIds: req.coalescedRunIds.slice(0, LIMITS.eventsPerWake) } : {}),
      ...(events.length ? { event: `${events.length} event${events.length === 1 ? "" : "s"}: ${events[0]!.subject ?? events[0]!.text}`.slice(0, LIMITS.runDetailMax) } : {}),
    };
    this.retryRuns.delete(req.runId);
    this.d.starter.start(req, run, (o) => this.finish(req, run, o));
  }

  private finish(req: FireRequest, run: RoutineRun, o: RoutineTurnOutcome): void {
    this.holding.delete(req.runId);
    const now = this.d.now();
    const delays = this.d.retryDelaysMs ?? LIMITS.routineRetryDelaysMs;
    const attempts = run.attempts ?? 1;
    const transient = o.status === "error" && o.errorCode !== undefined && TRANSIENT.includes(o.errorCode) && o.sideEffects === 0;
    if (transient && attempts <= delays.length) {
      const delay = delays[attempts - 1]!;
      const next = this.d.nextSlot(req.botId, req.routineId);
      if (next === null || next - (now + delay) > LIMITS.routineRetryBeforeNextSlotMs) {
        this.scheduleRetry(req, run, o, delay, attempts + 1);
        this.drain();
        return;
      }
    }
    this.d.db.setFireState(req.runId, o.status === "ok" ? "finished_ok" : "finished_error", o.status === "error" ? (o.errorCode ?? "error") : null, now);
    const detail = transient && attempts > 1 ? STR.runGaveUp(o.detail ?? o.errorCode ?? "error") : o.detail;
    const done: RoutineRun = {
      ...run, requestId: o.requestId || run.requestId, status: o.status, finishedAt: now,
      ...(detail ? { detail: detail.slice(0, LIMITS.runDetailMax) } : {}), ...(o.usage ? { usage: o.usage } : {}),
    };
    if (o.status === "ok" && !o.detail) delete done.detail;
    this.d.store.upsertRun(req.botId, req.routineId, done);
    this.d.onFinished?.(req, o);
    this.drain();
  }

  /** ORIG-02 §02.7: the retry reuses the original run-history entry; its fire gets a UUIDv4 with coalescedRunIds[0] = original id. */
  private scheduleRetry(req: FireRequest, run: RoutineRun, o: RoutineTurnOutcome, delay: number, attempt: number): void {
    const now = this.d.now();
    const waiting: RoutineRun = { ...run, status: "running", attempts: attempt, detail: STR.runRetrying(attempt), requestId: o.requestId || run.requestId };
    this.d.store.upsertRun(req.botId, req.routineId, waiting);
    this.d.db.setFireState(req.runId, "retry_wait", o.errorCode ?? "error", now);
    this.d.setTimer(() => {
      const retry: FireRequest = { ...req, runId: randomUUID(), trigger: "retry", coalescedRunIds: [run.id] };
      this.d.db.setFireState(req.runId, "finished_error", "retried", this.d.now());
      this.d.db.claimFire({ runId: retry.runId, botId: retry.botId, routineId: retry.routineId, trigger: "retry", scheduledFor: retry.scheduledFor, defHash: retry.defHash, eventJson: retry.events ? JSON.stringify(retry.events) : null, dedupeKey: null }, this.d.now());
      this.retryRuns.set(retry.runId, waiting);
      const result = this.admit(retry, false);
      if (!result.accepted) {
        this.retryRuns.delete(retry.runId);
        this.d.store.upsertRun(req.botId, req.routineId, { ...waiting, status: "error", finishedAt: this.d.now(), detail: STR.runRetryAbandoned });
      }
    }, delay);
  }

  /** Reclaims gate slots whose run can no longer report in, and lets the gated queue move again. */
  private sweepHolding(): void {
    const cutoff = this.d.now() - (this.d.holdTimeoutMs ?? HOLD_TIMEOUT_MS);
    let freed = false;
    for (const [runId, at] of this.holding) {
      if (at > cutoff) continue;
      this.holding.delete(runId);
      this.d.db.setFireState(runId, "finished_error", "lost", this.d.now());
      freed = true;
    }
    if (freed) this.drain();
  }

  private drain(): void {
    while (this.gated.length && this.holding.size < LIMITS.concurrentRoutineTurns) this.start(this.gated.shift()!);
  }
}

function runTriggerOf(t: FireTrigger): RunTrigger {
  return t === "manual" ? "manual" : t === "bot-run" ? "bot" : t === "event" ? "event" : "schedule";
}
