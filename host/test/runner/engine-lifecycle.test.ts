import { describe, expect, it } from "vitest";
import { FakeBrain } from "../../brain/fake-brain";
import type { TurnResult } from "../../brain/types";
import type { SettledTurn } from "../../runner/hooks";
import { makeRunnerHarness } from "./harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls instead of sleeping a fixed amount, so a loaded machine can't turn a real wait into a flake. */
const until = async (pred: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
};

/** A brain whose runTurn() rejects, the way ClaudeBrain does when a turn is admitted onto a
 *  half-torn-down query ("AsyncQueue is closed") or the SDK throws before any result arrives. */
class ThrowingBrain extends FakeBrain {
  override async runTurn(): Promise<TurnResult> {
    throw new Error("AsyncQueue is closed");
  }
}

/** A brain whose interrupt() rejects while a turn is running, the way ClaudeBrain does when the CLI
 *  answers the SDK control request with an error or dies while it is pending. A second interrupt
 *  (procState is no longer "running") returns normally, exactly like the real one. */
class RejectingInterruptBrain extends FakeBrain {
  override async interrupt(reason: string): Promise<void> {
    if (this.procState !== "running") return;
    await super.interrupt(reason);
    throw Object.assign(new Error("control request failed"), { errorClass: "control_request_failed" });
  }
}

describe("TurnRunner.execute: a turn that throws still settles (ENG-01)", () => {
  it("synthesizes an errored TurnResult so the tray, afterSettle and the wake's onSettle all still run", async () => {
    const settles: SettledTurn[] = [];
    const h = await makeRunnerHarness({
      script: () => [{ text: "never reached" }],
      hooks: { afterSettle: (_botId, info) => { settles.push(info); } },
      brainFactory: (id, wiring) => new ThrowingBrain(id, wiring, () => []),
    });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });

    h.runner.sendPrompt(botId, "are you there?", "n1");
    await h.untilIdle(botId);

    // The user is owed something visible: a tray saying the turn failed.
    expect(h.trays.list().map((t) => t.botId)).toContain(botId);
    expect(settles).toHaveLength(1);
    expect(settles[0]!.error).not.toBeNull();
  });

  it("gives an agent wake's onSettle a non-null result, so the sender's batch can be requeued", async () => {
    const seen: (TurnResult | null)[] = [];
    const h = await makeRunnerHarness({
      script: () => [],
      brainFactory: (id, wiring) => new ThrowingBrain(id, wiring, () => []),
    });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });

    h.runner.enqueueWake(botId, {
      source: "agent", lane: "agent", silenceAllowed: true,
      prompt: () => [{ text: "a peer sent you this" }],
      onSettle: (_slot, result) => { seen.push(result); },
    });
    await h.untilIdle(botId);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(seen[0]!.error?.retryable).toBe(true);
  });
});

describe("TurnRunner.resumeAtBoot: a durable ack obligation is redriven after a restart (ENG-02)", () => {
  it("arms the redrive for an idle Bot that owes a reply even with no restart-resume marker", async () => {
    const h = await makeRunnerHarness({ script: () => [{ text: "sorry, here it is" }], timings: { ackRedriveIdleMs: 20 } });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });
    // The previous process took a user message whose turn died (rate limit, overflow, CLI crash), so
    // the obligation is on disk. It went idle, and quiesce() never ran — a crash/systemd restart.
    h.acks.record(botId);
    expect(h.acks.pending().map((o) => o.botId)).toEqual([botId]);

    const next = h.boot(); // a fresh host process: empty `rt`, no resume markers
    next.runner.resumeAtBoot();
    await until(() => (h.brain(botId)?.inputs.length ?? 0) > 0);

    expect(h.brain(botId).inputs.map((i) => i.source)).toContain("ack-redrive");
  });

  it("retrying the 'Bot failed to respond' tray works after a restart too", async () => {
    const h = await makeRunnerHarness({ script: () => [{ text: "sorry, here it is" }], timings: { ackRedriveIdleMs: 20 } });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });
    const tray = h.trays.add({ botId, title: "Bot failed to respond", retry: true });

    const next = h.boot(); // the user quits, reopens the app, and only then presses Retry
    next.runner.retryTray(tray.id);
    await until(() => (h.brain(botId)?.inputs.length ?? 0) > 0);

    expect(h.brain(botId).inputs.map((i) => i.source)).toContain("ack-redrive");
  });
});

describe("TurnRunner.enqueueHidden: start/drop callbacks for durable background work (ENG-03)", () => {
  it("calls onStart when the hidden turn actually runs", async () => {
    const h = await makeRunnerHarness({ script: () => [{ text: "ok" }] });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });
    let started = 0;
    let dropped = 0;

    h.runner.enqueueHidden(botId, {
      source: "shell-done", lane: "background", silenceAllowed: true, text: "a command finished",
      onStart: () => { started += 1; }, onDropped: () => { dropped += 1; },
    });
    await h.untilIdle(botId);

    expect(started).toBe(1);
    expect(dropped).toBe(0);
  });

  it("calls onDropped, not onStart, when the queued wake is dropped before it runs", async () => {
    const h = await makeRunnerHarness({ script: () => [{ wait: 2000 }] });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });
    let started = 0;
    let dropped = 0;

    h.runner.sendPrompt(botId, "keep busy", "n1");
    await until(() => h.runner.recipientState(botId) === "user");
    h.runner.enqueueHidden(botId, {
      source: "shell-done", lane: "background", silenceAllowed: true, text: "a command finished",
      onStart: () => { started += 1; }, onDropped: () => { dropped += 1; },
    });
    h.runner.quiesce(); // the app is quitting: the queued revival is discarded with the process

    expect(started).toBe(0);
    expect(dropped).toBe(1);
  });
});

describe("TurnRunner.beginDelete: a rejecting interrupt must not strand the Bot (ENG-04)", () => {
  it("still finishes the delete when the brain's interrupt() rejects mid-turn", async () => {
    const h = await makeRunnerHarness({
      script: () => [{ wait: 3000 }, { text: "late" }],
      brainFactory: (id, wiring) => new RejectingInterruptBrain(id, wiring, () => [{ wait: 3000 }, { text: "late" }]),
    });
    const botId = h.bots.create({ name: "Ada", origin: "user", kickstart: false });
    h.runner.sendPrompt(botId, "long one", "n1");
    await until(() => h.runner.recipientState(botId) === "user");
    expect(h.runner.recipientState(botId)).toBe("user");

    await expect(h.runner.deleteBot(botId)).resolves.toBeUndefined();
    expect(h.bots.has(botId)).toBe(false);
  });
});
