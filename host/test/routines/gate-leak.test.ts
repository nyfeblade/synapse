import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { RoutineRun } from "@synapse/shared";
import { FireConsumer, type FireRequest, type RoutineTurnOutcome } from "../../routines/fire-consumer";
import { RoutineTurns } from "../../routines/routine-turn";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";
import { makeRunnerHarness } from "../runner/harness";

const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now() + ms;
  while (!f()) {
    if (Date.now() > t) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const T0 = Date.UTC(2026, 8, 21, 8, 0, 0);

/** Real TurnRunner + real RoutineTurns + real FireConsumer: the gate slot must survive a dropped wake. */
async function integration() {
  const s = await makeRunnerHarness({ script: (input) => (input.source === "user" ? [{ wait: 3000 }] : [{ text: "ok" }]) });
  const botId = s.bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const store = new RoutineStore({ cfg: s.cfg, now: () => Date.now() });
  const rec = store.create(botId, { name: "Sweep", prompt: "Summarize my inbox.", schedule: "0 8 * * *", enabled: true })!;
  const db = new SchedulerDb(":memory:");
  let consumer: FireConsumer | null = null;
  const turns = new RoutineTurns({
    runner: s.runner, store, chains: null, botTz: () => "UTC", now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    paths: { workspace: s.cfg.workspace, hostPrivate: s.cfg.hostPrivate },
    onRunning: (runId) => consumer?.markRunning(runId),
  });
  const finished: RoutineTurnOutcome[] = [];
  consumer = new FireConsumer({
    db, store, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), starter: turns,
    guard: () => "ok", usagePaused: () => false, nextSlot: () => null, eventMatches: () => true,
    onFinished: (_r, o) => finished.push(o),
  });
  const fire = (): FireRequest => ({ runId: randomUUID(), botId, routineId: rec.id, trigger: "schedule", scheduledFor: Date.now(), defHash: rec.defHash });
  return { ...s, botId, store, db, consumer, rec, fire, finished };
}

describe("routine gate slots are never leaked (concurrency)", () => {
  it("Stop while a routine wake is queued releases the gate slot and closes the fire row", async () => {
    const s = await integration();
    s.runner.sendPrompt(s.botId, "hello", "n1");
    await until(() => s.brain(s.botId)?.procState === "running");
    const req = s.fire();
    expect(s.consumer.submit(req).accepted).toBe(true);
    expect(s.consumer.runningCount()).toBe(1);
    // CHAT-18 Stop: the queued background wake is dropped without ever running.
    await s.runner.interruptAgent(s.botId);
    await until(() => s.consumer.runningCount() === 0);
    expect(s.db.fire(req.runId)!.state).toBe("finished_error");
    expect(s.finished).toHaveLength(1);
    expect(s.store.runs(s.botId, s.rec.id)[0]).toMatchObject({ status: "error" });
  });

  it("deleting a Bot with a queued routine wake releases the gate slot", async () => {
    const s = await integration();
    s.runner.sendPrompt(s.botId, "hello", "n1");
    await until(() => s.brain(s.botId)?.procState === "running");
    const req = s.fire();
    expect(s.consumer.submit(req).accepted).toBe(true);
    await s.runner.beginDelete(s.botId);
    await until(() => s.consumer.runningCount() === 0);
    expect(s.db.fire(req.runId)!.state).toBe("finished_error");
  });

  it("a quiesce (host update) with a queued routine wake releases the gate slot", async () => {
    const s = await integration();
    s.runner.sendPrompt(s.botId, "hello", "n1");
    await until(() => s.brain(s.botId)?.procState === "running");
    const req = s.fire();
    expect(s.consumer.submit(req).accepted).toBe(true);
    s.runner.quiesce();
    await until(() => s.consumer.runningCount() === 0);
    expect(s.db.fire(req.runId)!.state).toBe("finished_error");
  });

  it("three dropped wakes do not wedge the host-wide gate for every other Bot", async () => {
    const s = await integration();
    const others: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = s.bots.create({ origin: "user", kickstart: false, name: `Other${i}` });
      others.push(id);
      s.runner.sendPrompt(id, "hi", `u${i}`);
    }
    await until(() => others.every((id) => s.brain(id)?.procState === "running"));
    const recs = others.map((id) => s.store.create(id, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true })!);
    others.forEach((id, i) => {
      const r = recs[i]!;
      s.consumer.submit({ runId: randomUUID(), botId: id, routineId: r.id, trigger: "schedule", scheduledFor: Date.now(), defHash: r.defHash });
    });
    expect(s.consumer.runningCount()).toBe(3);
    for (const id of others) await s.runner.interruptAgent(id);
    await until(() => s.consumer.runningCount() === 0);
    // A fresh Bot's scheduled routine still runs instead of being gated forever.
    const req = s.fire();
    expect(s.consumer.submit(req).accepted).toBe(true);
    expect(s.consumer.gatedCount()).toBe(0);
  });
});

/** Belt-and-braces: a starter that never settles must not hold a slot for the process's lifetime. */
describe("FireConsumer hold sweep", () => {
  function setup() {
    const cfg = tmpConfig();
    initLayout(cfg);
    const clock = { now: T0 };
    const store = new RoutineStore({ cfg, now: () => clock.now });
    const db = new SchedulerDb(":memory:");
    const started: FireRequest[] = [];
    const consumer = new FireConsumer({
      db, store, now: () => clock.now, setTimer: (fn, ms) => setTimeout(fn, ms),
      starter: { start: (req) => { started.push(req); } }, // never calls done()
      guard: () => "ok", usagePaused: () => false, nextSlot: () => null, eventMatches: () => true,
    });
    const bot = () => { const id = randomUUID(); fs.mkdirSync(botDir(cfg, id), { recursive: true }); return id; };
    return { cfg, clock, store, db, consumer, started, bot };
  }

  it("releases a slot whose run never settled once the hold timeout passes", () => {
    const s = setup();
    const routines = [0, 1, 2, 3].map(() => {
      const b = s.bot();
      return { b, r: s.store.create(b, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true })! };
    });
    for (const x of routines.slice(0, 3)) {
      s.consumer.submit({ runId: randomUUID(), botId: x.b, routineId: x.r.id, trigger: "schedule", scheduledFor: T0, defHash: x.r.defHash });
    }
    expect(s.consumer.runningCount()).toBe(3);
    const fourth = routines[3]!;
    const gatedId = randomUUID();
    s.consumer.submit({ runId: gatedId, botId: fourth.b, routineId: fourth.r.id, trigger: "schedule", scheduledFor: T0, defHash: fourth.r.defHash });
    expect(s.consumer.gatedCount()).toBe(1);
    // Well past the routine hard limit: those three runs can never report in.
    s.clock.now += 3 * 60 * 60_000;
    const fresh = routines[0]!;
    s.consumer.submit({ runId: randomUUID(), botId: fresh.b, routineId: fresh.r.id, trigger: "schedule", scheduledFor: s.clock.now, defHash: fresh.r.defHash });
    expect(s.started.map((r) => r.runId)).toContain(gatedId);
    expect(s.consumer.gatedCount()).toBe(0);
    expect(s.consumer.runningCount()).toBeLessThanOrEqual(3);
  });
});
