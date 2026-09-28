import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { RoutineRun } from "@synapse/shared";
import { FireConsumer, type FireRequest, type RoutineTurnOutcome } from "../../routines/fire-consumer";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { botDir, initLayout } from "../../store/layout";
import type { TriggerEvent } from "../../triggers/types";
import { tmpConfig } from "../helpers";

const T0 = Date.UTC(2026, 8, 21, 8, 0, 0);

function setup(o: { guard?: "ok" | "paused"; usagePaused?: boolean; nextSlot?: number | null; matches?: boolean } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: T0 };
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const started: { req: FireRequest; run: RoutineRun; done: (o: RoutineTurnOutcome) => void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const dropped: string[] = [];
  const resumed: string[] = [];
  const consumer = new FireConsumer({
    db, store, now: () => clock.now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    starter: { start: (req, run, done) => { started.push({ req, run, done }); } },
    guard: () => o.guard ?? "ok", usagePaused: () => o.usagePaused ?? false, nextSlot: () => o.nextSlot ?? null,
    eventMatches: () => o.matches ?? true, onDropped: (_r, reason) => dropped.push(reason), resume: (b) => resumed.push(b),
  });
  const bot = () => { const id = randomUUID(); fs.mkdirSync(botDir(cfg, id), { recursive: true }); return id; };
  return { cfg, clock, store, db, consumer, started, timers, dropped, resumed, bot };
}
const mkRoutine = (s: ReturnType<typeof setup>, botId: string, name = "Sweep", extra: object = {}) =>
  s.store.create(botId, { name, prompt: "Summarize my inbox.", schedule: "0 8 * * *", enabled: true, ...extra })!;
const req = (botId: string, routineId: string, defHash: string, extra: Partial<FireRequest> = {}): FireRequest =>
  ({ runId: randomUUID(), botId, routineId, trigger: "schedule", scheduledFor: T0, defHash, ...extra });
const ok = (requestId = "req_1", sideEffects = 0): RoutineTurnOutcome => ({ status: "ok", sideEffects, requestId });
const ev: TriggerEvent = { source: "github", eventId: "d1", occurredAt: T0, text: "PR opened", raw: {}, kind: "prOpened", repo: "o/r" };

describe("FireConsumer checks (RTN-14, RTN-15)", () => {
  it("drops in the spec order and writes no run history for drops", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    expect(s.consumer.submit(req(b, "missing", "h")).reason).toBe("automation_missing");
    s.store.update(b, r.id, { enabled: false });
    const disabled = s.store.get(b, r.id)!;
    expect(s.consumer.submit(req(b, r.id, disabled.defHash)).reason).toBe("disabled");
    const on = s.store.update(b, r.id, { enabled: true, lastRunAt: T0 });
    expect(s.consumer.submit(req(b, r.id, on.defHash)).reason).toBe("slot_already_covered");
    expect(s.consumer.submit(req(b, r.id, "old-hash", { scheduledFor: T0 + 1 })).reason).toBe("definition_changed");
    expect(s.store.runs(b, r.id)).toEqual([]);
    expect(s.dropped).toEqual(["automation_missing", "disabled", "slot_already_covered", "definition_changed"]);
  });

  it("checks event context and matching", () => {
    const s = setup({ matches: false });
    const b = s.bot();
    const r = mkRoutine(s, b, "Watch", { schedule: undefined, trigger: { github: { repo: "o/r", events: ["prOpened"] } } });
    expect(s.consumer.submit(req(b, r.id, r.defHash, { trigger: "event", events: [ev] })).reason).toBe("trigger_no_longer_matches");
    expect(s.consumer.submit(req(b, r.id, r.defHash, { trigger: "event", events: [] })).reason).toBe("missing_event_context");
  });

  it("an already finished run id is idempotent", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    const q = req(b, r.id, r.defHash);
    expect(s.consumer.submit(q).accepted).toBe(true);
    s.started[0]!.done(ok());
    expect(s.consumer.submit(q)).toMatchObject({ accepted: false, reason: "already_finished" });
    expect(s.started).toHaveLength(1);
  });

  it("drops a second non-event fire while one is in flight (duplicate_in_flight)", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    s.consumer.submit(req(b, r.id, r.defHash));
    expect(s.consumer.submit(req(b, r.id, r.defHash, { scheduledFor: T0 + 3_600_000 })).reason).toBe("duplicate_in_flight");
  });

  it("drops for the spend guard and the usage pause, but Test run bypasses both (RTN-18, RTN-20, USE-04)", () => {
    const g = setup({ guard: "paused" });
    const b = g.bot();
    const r = mkRoutine(g, b);
    expect(g.consumer.submit(req(b, r.id, r.defHash)).reason).toBe("user_away_paused");
    expect(g.consumer.submit(req(b, r.id, r.defHash, { trigger: "manual", bypassGate: true })).accepted).toBe(true);
    const u = setup({ usagePaused: true });
    const b2 = u.bot();
    const r2 = mkRoutine(u, b2);
    expect(u.consumer.submit(req(b2, r2.id, r2.defHash)).reason).toBe("usage_paused");
  });
});

describe("FireConsumer gate and run records (ORIG-02 §02.3)", () => {
  it("12 routines across 6 Bots at 08:00: never more than 3 at once, all 12 run", () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      const b = s.bot();
      for (const n of ["A", "B"]) { const r = mkRoutine(s, b, n); s.consumer.submit(req(b, r.id, r.defHash)); }
      expect(s.consumer.runningCount()).toBeLessThanOrEqual(3);
    }
    expect(s.consumer.gatedCount()).toBe(9);
    let finished = 0;
    while (finished < s.started.length) {
      s.started[finished]!.done(ok());
      finished += 1;
      expect(s.consumer.runningCount()).toBeLessThanOrEqual(3);
    }
    expect(s.started).toHaveLength(12);
    expect(s.consumer.gatedCount()).toBe(0);
  });

  it("Test run bypasses the gate", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) { const b = s.bot(); const r = mkRoutine(s, b); s.consumer.submit(req(b, r.id, r.defHash)); }
    const b = s.bot();
    const r = mkRoutine(s, b);
    s.consumer.submit(req(b, r.id, r.defHash, { trigger: "manual", bypassGate: true }));
    expect(s.consumer.runningCount()).toBe(4);
  });

  it("records the finished run newest first with status, detail and usage; sets lastRunAt", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    const q = req(b, r.id, r.defHash);
    s.consumer.submit(q);
    expect(s.store.get(b, r.id)!.def.lastRunAt).toBe(T0);
    s.clock.now = T0 + 60_000;
    s.started[0]!.done({ status: "error", detail: "x".repeat(400), sideEffects: 1, requestId: "req_9", errorCode: "BOT-E0405", usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.01 } });
    const [run] = s.store.runs(b, r.id);
    expect(run).toMatchObject({ id: q.runId, trigger: "schedule", status: "error", finishedAt: T0 + 60_000, requestId: "req_9", usage: { inputTokens: 5 } });
    expect(run!.detail).toHaveLength(300);
    expect(s.db.fire(q.runId)!.state).toBe("finished_error");
  });
});

describe("FireConsumer retries (ORIG-02 §02.7)", () => {
  it("retries a transient, side-effect-free failure after 2 min then 10 min, reusing the run record, then gives up", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    const q = req(b, r.id, r.defHash);
    s.consumer.submit(q);
    s.started[0]!.done({ status: "error", errorCode: "BOT-E0403", detail: "stream reset", sideEffects: 0, requestId: "r1" });
    expect(s.timers.map((t) => t.ms)).toEqual([120_000]);
    expect(s.store.runs(b, r.id)[0]).toMatchObject({ id: q.runId, status: "running", attempts: 2, detail: "Retrying after a connection problem (attempt 2 of 3)" });
    s.timers[0]!.fn();
    expect(s.started).toHaveLength(2);
    expect(s.started[1]!.req).toMatchObject({ trigger: "retry", coalescedRunIds: [q.runId] });
    expect(s.started[1]!.run.id).toBe(q.runId);
    s.started[1]!.done({ status: "error", errorCode: "BOT-E0401", detail: "overloaded", sideEffects: 0, requestId: "r2" });
    expect(s.timers.map((t) => t.ms)).toEqual([120_000, 600_000]);
    s.timers[1]!.fn();
    s.started[2]!.done({ status: "error", errorCode: "BOT-E0401", detail: "overloaded", sideEffects: 0, requestId: "r3" });
    expect(s.timers).toHaveLength(2);
    const runs = s.store.runs(b, r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "error", attempts: 3, detail: "Gave up after the connection kept dropping: overloaded" });
  });

  it("resolves the run-history record to a terminal state when the re-admitted retry is dropped (routine disabled during the wait)", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    const q = req(b, r.id, r.defHash);
    s.consumer.submit(q);
    s.started[0]!.done({ status: "error", errorCode: "BOT-E0403", detail: "stream reset", sideEffects: 0, requestId: "r1" });
    expect(s.store.runs(b, r.id)[0]).toMatchObject({ id: q.runId, status: "running", finishedAt: null });
    s.store.update(b, r.id, { enabled: false }); // user disables the routine while the retry timer is waiting
    s.clock.now = T0 + 120_000;
    s.timers[0]!.fn();
    expect(s.started).toHaveLength(1); // the re-admitted retry was dropped, never started
    expect(s.dropped).toEqual(["disabled"]);
    const [run] = s.store.runs(b, r.id);
    expect(run).toMatchObject({ id: q.runId, status: "error", finishedAt: T0 + 120_000 });
    expect(run!.status).not.toBe("running");
  });

  it("never retries after a side effect, for a usage-limit error, or when the next slot is too close", () => {
    const s = setup({ nextSlot: T0 + 150_000 });
    const b = s.bot();
    for (const [name, o] of [
      ["A", { status: "error", errorCode: "BOT-E0403", detail: "reset", sideEffects: 1, requestId: "r" }],
      ["B", { status: "error", errorCode: "BOT-E0420", detail: "limit", sideEffects: 0, requestId: "r" }],
      ["C", { status: "error", errorCode: "BOT-E0406", detail: "retryable", sideEffects: 0, requestId: "r" }],
    ] as const) {
      const r = mkRoutine(s, b, name);
      s.consumer.submit(req(b, r.id, r.defHash));
      s.started[s.started.length - 1]!.done(o);
      expect(s.store.runs(b, r.id)[0]!.status).toBe("error");
    }
    expect(s.timers).toEqual([]);
  });
});

describe("FireConsumer crash recovery (ORIG-02 §02.5, EVT-19)", () => {
  it("re-queues owed fires and records running ones as interrupted, then resumes the Bot", () => {
    const s = setup();
    const b = s.bot();
    const r = mkRoutine(s, b);
    const q = req(b, r.id, r.defHash);
    s.consumer.submit(q);
    s.consumer.markRunning(q.runId);
    s.store.upsertRun(b, r.id, { ...s.started[0]!.run, requestId: "req_1" });
    const fresh = setup();
    // same data dirs: reuse s's store and db through a second consumer
    const started: FireRequest[] = [];
    const resumed: string[] = [];
    const c2 = new FireConsumer({
      db: s.db, store: s.store, now: () => T0 + 5_000, setTimer: () => 0, starter: { start: (rq) => { started.push(rq); } },
      guard: () => "ok", usagePaused: () => false, nextSlot: () => null, eventMatches: () => true, resume: (id) => resumed.push(id),
    });
    c2.markInterrupted(s.db.fires({ states: ["running"] }));
    expect(s.store.runs(b, r.id)[0]).toMatchObject({ id: q.runId, status: "error", detail: "Interrupted by a host update; resuming after restart." });
    expect(resumed).toEqual([b]);
    const r2 = mkRoutine(s, b, "Other");
    const owed = req(b, r2.id, r2.defHash);
    s.db.claimFire({ runId: owed.runId, botId: b, routineId: r2.id, trigger: "schedule", scheduledFor: T0, defHash: r2.defHash, eventJson: null, dedupeKey: owed.runId }, T0);
    s.db.setFireState(owed.runId, "queued", null, T0);
    s.store.update(b, r2.id, { lastRunAt: T0 }); // the crashed host had already started it
    c2.recover(s.db.fires({ states: ["claimed", "gated", "queued", "retry_wait"] }));
    expect(started.map((x) => x.runId)).toEqual([owed.runId]);
    expect(fresh.started).toEqual([]);
  });
});
