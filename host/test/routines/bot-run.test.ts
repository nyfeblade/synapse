import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, type Chain, type RoutineRun } from "@synapse/shared";
import { messageText, type TurnResult } from "../../brain/types";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool } from "../../review/classify";
import { SchedulerEngine } from "../../routines/engine";
import { FireConsumer, type FireRequest, type RoutineTurnOutcome } from "../../routines/fire-consumer";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { RoutineTurns, renderRoutineWake } from "../../routines/routine-turn";
import { SchedulerDb } from "../../routines/scheduler-db";
import { emptyContext } from "../../runner/turn-context";
import type { TurnRunner, WakeSpec } from "../../runner/turn-runner";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { botDir, initLayout } from "../../store/layout";
import { routineStateTarget } from "../../tools/routine-tools";
import { tmpConfig } from "../helpers";

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0);
const chainOf = (over: Partial<Chain> = {}): Chain => ({ chainId: "c_run", rootKind: "user", rootBotId: "b", rootAt: NOW, hops: 0, peerTurns: 0, weightedTokens: 0, costUsd: 0, lastActivityAt: NOW, ...over });

describe("C1: a Bot-initiated routine run is reviewed (automation_write)", () => {
  it('classifies update_state routine "run" as automation_write, never unreviewed', () => {
    const c = classifyTool({ toolName: "mcp__bot__update_state", input: { target: "routine", action: "run", id: "sweep" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host" });
    expect(c.surface).toBe("automation_write");
    expect(c.sideEffect).toBe(true);
    expect(c.summary).toContain("Run the routine");
    expect(c.target?.arguments).toMatchObject({ action: "run", id: "sweep" });
  });
});

function serviceSetup(o: { chain?: Chain | null } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: NOW };
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings, now: () => clock.now });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => "UTC", now: () => clock.now, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const submitted: FireRequest[] = [];
  const consumer = {
    submit: (r: FireRequest) => {
      submitted.push(r);
      db.claimFire({ runId: r.runId, botId: r.botId, routineId: r.routineId, trigger: r.trigger, scheduledFor: r.scheduledFor, defHash: r.defHash, eventJson: null, dedupeKey: null }, clock.now);
      return { accepted: true, runId: r.runId };
    },
  } as unknown as FireConsumer;
  let chain = o.chain === undefined ? chainOf() : o.chain;
  const hops: string[] = [];
  const chains = {
    get: (cid: string) => (chain && chain.chainId === cid ? chain : null),
    hop: (cid: string) => { hops.push(cid); chain = { ...chain!, hops: chain!.hops + 1 }; return chain; },
  };
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => clock.now, publicBaseUrl: () => "http://x", chains });
  store.create(id, { name: "Sweep", prompt: "Summarize my inbox.", schedule: "0 8 * * *", enabled: true });
  const handle = routineStateTarget({ routines, bots, now: () => clock.now });
  const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 4, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: NOW, context: { ...emptyContext(), chainId: "c_run" } });
  return { clock, id, store, db, routines, submitted, handle, slot, hops, setChain: (c: Chain | null) => { chain = c; } };
}

describe("C1: RoutineService.botRun", () => {
  it("the tool submits a bot-run fire (never manual, never bypassGate) on the caller's chain, and hops the chain", async () => {
    const s = serviceSetup();
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "run", id: "sweep" });
    expect(r.isError).toBeFalsy();
    expect(s.submitted[0]!.trigger).toBe("bot-run");
    expect(s.submitted[0]!.bypassGate).toBeFalsy();
    expect(s.submitted[0]!.chainId).toBe("c_run");
    expect(s.hops).toEqual(["c_run"]);
  });

  it("caps Bot-initiated runs at 3 per routine per hour", () => {
    const s = serviceSetup({ chain: null });
    for (let i = 0; i < 3; i++) s.routines.botRun(s.id, "sweep", { chainId: null });
    expect(() => s.routines.botRun(s.id, "sweep", { chainId: null })).toThrow(/at most 3 times an hour/);
    s.clock.now = NOW + 3_600_001;
    expect(() => s.routines.botRun(s.id, "sweep", { chainId: null })).not.toThrow();
    // a user's Run now is not counted against the Bot cap
    expect(() => s.routines.runNow(s.id, "sweep")).not.toThrow();
  });

  it("a chain of Bot-initiated runs counts toward the chain's hop limit and token budget", () => {
    const s = serviceSetup({ chain: chainOf({ hops: LIMITS.maxHops - 1 }) });
    expect(() => s.routines.botRun(s.id, "sweep", { chainId: "c_run" })).toThrow(/chain/);
    s.setChain(chainOf({ weightedTokens: LIMITS.chainTokenBudget + 1 }));
    expect(() => s.routines.botRun(s.id, "sweep", { chainId: "c_run" })).toThrow(/budget/);
    expect(s.submitted).toHaveLength(0);
  });
});

function consumerSetup(o: { guard?: "ok" | "paused"; usagePaused?: boolean } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const store = new RoutineStore({ cfg, now: () => NOW });
  const db = new SchedulerDb(":memory:");
  const started: FireRequest[] = [];
  const consumer = new FireConsumer({
    db, store, now: () => NOW, setTimer: () => 0, starter: { start: (req) => { started.push(req); } },
    guard: () => o.guard ?? "ok", usagePaused: () => o.usagePaused ?? false, nextSlot: () => null, eventMatches: () => true,
  });
  const botId = randomUUID();
  fs.mkdirSync(botDir(cfg, botId), { recursive: true });
  const mk = (name: string) => store.create(botId, { name, prompt: "p", schedule: "0 8 * * *", enabled: true })!;
  const run = (r: ReturnType<typeof mk>) => consumer.submit({ runId: randomUUID(), botId, routineId: r.id, trigger: "bot-run", scheduledFor: NOW, defHash: r.defHash });
  return { store, consumer, started, mk, run };
}

describe("C1: FireConsumer applies the spend guard, usage pause and concurrency cap to bot-run", () => {
  it("drops on the spend guard", () => {
    const s = consumerSetup({ guard: "paused" });
    expect(s.run(s.mk("A")).reason).toBe("user_away_paused");
  });
  it("drops on the usage pause", () => {
    const s = consumerSetup({ usagePaused: true });
    expect(s.run(s.mk("A")).reason).toBe("usage_paused");
  });
  it("drops a paused routine", () => {
    const s = consumerSetup();
    const r = s.mk("A");
    s.store.update(r.botId, r.id, { enabled: false });
    expect(s.run(s.store.get(r.botId, r.id)!).reason).toBe("disabled");
  });
  it("gates the 4th concurrent run", () => {
    const s = consumerSetup();
    for (const n of ["A", "B", "C", "D"]) expect(s.run(s.mk(n)).accepted).toBe(true);
    expect(s.started).toHaveLength(LIMITS.concurrentRoutineTurns);
    expect(s.consumer.gatedCount()).toBe(1);
  });
});

describe("C1: the wake is truthful", () => {
  const routine = { botId: "b", id: "sweep", defHash: "h", def: { name: "Sweep", prompt: "Summarize my inbox.", enabled: true, createdAt: 0 } };
  const base = { routine, description: "Every day", expr: null, firedAt: NOW, scheduledFor: NOW, events: [], lateByMs: 0, tz: "UTC" };
  it("names the Bot that started it, never the user, and the trusted marker covers only the saved instruction", () => {
    const w = renderRoutineWake({ ...base, trigger: "bot-run", startedBy: "Piper" });
    expect(w.text).toContain("Piper started this routine");
    expect(w.text).not.toContain("pressed Run now");
    expect(w.text).not.toMatch(/user pressed|started by the user|from the user/);
    const marker = w.text.indexOf("[TRUSTED_ROUTINE_PROMPT]");
    expect(marker).toBeGreaterThan(w.text.indexOf("Piper started this routine"));
    expect(w.text.slice(marker)).toMatch(/^\[TRUSTED_ROUTINE_PROMPT\]\nWhat you saved to do each time:\nSummarize my inbox\./);
  });
});

describe("C1: RoutineTurns continues the caller's chain and charges it", () => {
  it("a bot-run turn uses the request's chain and adds its usage to the chain", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const botId = randomUUID();
    fs.mkdirSync(botDir(cfg, botId), { recursive: true });
    const store = new RoutineStore({ cfg, now: () => NOW });
    const rec = store.create(botId, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true })!;
    const wakes: WakeSpec[] = [];
    const runner = { enqueueWake: (_id: string, spec: WakeSpec) => { wakes.push(spec); return "w"; }, addPostToolHook: () => {}, interruptActive: async () => {} } as unknown as TurnRunner;
    const charged: string[] = [];
    const started: string[] = [];
    const turns = new RoutineTurns({
      runner, store, botTz: () => "UTC", now: () => NOW, setTimer: () => 0, clearTimer: () => {}, nameOf: () => "Piper",
      chains: {
        start: (k, b) => { started.push(k); return chainOf({ chainId: "c_new", rootKind: k, rootBotId: b }); },
        get: (id) => (id === "c_run" ? chainOf() : null),
        addPeerTurn: (id) => { charged.push(id); return chainOf(); },
      },
    });
    const req: FireRequest = { runId: randomUUID(), botId, routineId: rec.id, trigger: "bot-run", scheduledFor: NOW, defHash: rec.defHash, chainId: "c_run" };
    const run: RoutineRun = { id: req.runId, trigger: "bot", startedAt: NOW, finishedAt: null, status: "running", requestId: "" };
    const outcomes: RoutineTurnOutcome[] = [];
    turns.start(req, run, (o) => outcomes.push(o));
    const spec = wakes[0]!;
    expect(spec.context?.chainId).toBe("c_run");
    expect(started).toEqual([]);
    expect(messageText(spec.prompt()[0]!)).toContain("Piper started this routine");
    const slot = newSlot({ botId, requestId: "req_9", turnNo: 1, lane: "background", source: "routine", hidden: true, silenceAllowed: true, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: NOW, context: { ...emptyContext(), ...spec.context } });
    spec.onStart!(slot);
    const res: TurnResult = { sentMessageCount: 0, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 }, finalText: "", toolCallCount: 0, model: "m" };
    spec.onSettle!(slot, res);
    expect(charged).toEqual(["c_run"]);
    expect(outcomes[0]!.status).toBe("ok");
  });
});
