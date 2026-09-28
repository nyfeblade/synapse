import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, STR, type RoutineRun } from "@synapse/shared";
import { ChainStore } from "../../b2b/chains";
import { LoopTracker } from "../../b2b/loops";
import type { Mailbox } from "../../b2b/mailbox";
import { RequestStore } from "../../b2b/requests";
import type { BotService } from "../../bots/bot-service";
import type { FireRequest, RoutineTurnOutcome } from "../../routines/fire-consumer";
import { RoutineStore } from "../../routines/routine-store";
import { RoutineTurns } from "../../routines/routine-turn";
import { emptyContext } from "../../runner/turn-context";
import type { TurnRunner } from "../../runner/turn-runner";
import { newSlot } from "../../runner/turn-slot";
import { botDir, initLayout } from "../../store/layout";
import { sendToAgentProvider } from "../../tools/send-to-agent";
import { tmpConfig } from "../helpers";
import { groupHarness, promptText, say } from "./harness";

const BIG = { inputTokens: LIMITS.chainTokenBudget + 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1 };

function poster(o: { admit?: boolean } = {}) {
  const cfg = tmpConfig();
  fs.mkdirSync(cfg.hostPrivate, { recursive: true });
  const chains = new ChainStore(path.join(cfg.hostPrivate, "chains.json"));
  const requests = new RequestStore(path.join(cfg.hostPrivate, "b2b-requests.json"));
  const loops = new LoopTracker(path.join(cfg.hostPrivate, "b2b-loops.json"));
  const posted: string[] = [];
  const groups = { isGroup: (id: string) => id === "g1", postFromBot: async (_g: string, _f: string, _a: unknown, chainId: string) => { posted.push(chainId); return { text: "Posted." }; } };
  const admitted: string[] = [];
  const mailbox = { tryAdmit: (to: string) => { admitted.push(to); return o.admit ?? true; } } as unknown as Mailbox;
  const bots = { has: () => true, summary: () => ({ profile: { name: "Room" } }) } as unknown as BotService;
  const metrics = { bump: () => {}, recordB2B: () => {} } as never;
  const provider = sendToAgentProvider({ bots, chains, requests, threads: null as never, classifier: null, loops, mailbox, metrics, groups, mirror: null, budgetFactor: () => 1, now: Date.now });
  const chain = chains.start("user", "b1");
  const slot = newSlot({ botId: "b1", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1, context: { ...emptyContext(), chainId: chain.chainId } });
  const tool = provider("b1", () => slot)[0]!;
  const post = () => tool.handler({ target_id: "g1", kind: "request", message: "Can someone confirm the train times?", expects: "train times" });
  return { chains, chain, posted, admitted, post };
}

describe("I6: group posts via SendToAgent go through the loop checks, the chain and admission", () => {
  it("hops the chain and asks the mailbox to admit the room turn", async () => {
    const s = poster();
    const r = await s.post();
    expect(r.isError).toBeFalsy();
    expect(s.posted).toEqual([s.chain.chainId]);
    expect(s.chains.get(s.chain.chainId)!.hops).toBe(1);
    expect(s.admitted).toEqual(["g1"]);
  });
  it("a chain over its token budget can't post to a group", async () => {
    const s = poster();
    s.chains.addPeerTurn(s.chain.chainId, BIG);
    const r = await s.post();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("b2b_budget_exhausted");
    expect(s.posted).toEqual([]);
  });
  it("a chain at its hop limit can't post to a group", async () => {
    const s = poster();
    for (let i = 0; i < LIMITS.maxHops - 1; i++) s.chains.hop(s.chain.chainId);
    const r = await s.post();
    expect(r.isError).toBe(true);
    expect(s.posted).toEqual([]);
  });
  it("mailbox admission refusal stops the post", async () => {
    const s = poster({ admit: false });
    const r = await s.post();
    expect(r.isError).toBe(true);
    expect(s.posted).toEqual([]);
  });
});

describe("I6: room-turn usage is charged to the chain", () => {
  it("each member turn of a room turn adds a peer turn to the room's chain", async () => {
    const h = groupHarness(() => (input) => (promptText(input).includes("[Group chat:") ? [say("Found 3 options near Hudson.")] : []));
    const a = h.mk("Planner"), b = h.mk("Scout");
    const { id: g } = h.groups.create([a, b], { origin: "user" });
    const chain = h.chains.start("user", g, { groupId: g });
    await h.orch.startRoomTurn(g, { mentioned: "all", chainId: chain.chainId, lane: "user" });
    expect(h.chains.get(chain.chainId)!.peerTurns).toBeGreaterThanOrEqual(2);
  });
});

describe("I6: a group routine's room turn gets the routine hard limit and spend accounting", () => {
  function setup(seed: (signal: { cancelled: boolean }) => Promise<{ usage: { inputTokens: number; outputTokens: number; costUsd: number } }>) {
    const cfg = tmpConfig();
    initLayout(cfg);
    const botId = randomUUID();
    fs.mkdirSync(botDir(cfg, botId), { recursive: true });
    const store = new RoutineStore({ cfg, now: () => 1 });
    const rec = store.create(botId, { name: "Standup", prompt: "Post the standup.", schedule: "0 9 * * *", enabled: true })!;
    const runner = { enqueueWake: () => "w", addPostToolHook: () => {}, interruptActive: async () => {} } as unknown as TurnRunner;
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const cancelled: string[] = [];
    const signal = { cancelled: false };
    const turns = new RoutineTurns({
      runner, store, chains: null, botTz: () => "UTC", now: () => 1,
      setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
      timings: { hardMs: 1000 },
      isGroup: () => true,
      groupSeed: () => seed(signal),
      groupCancel: (g) => { cancelled.push(g); signal.cancelled = true; },
    });
    const outcomes: RoutineTurnOutcome[] = [];
    const req: FireRequest = { runId: randomUUID(), botId, routineId: rec.id, trigger: "schedule", scheduledFor: 1, defHash: rec.defHash };
    const run: RoutineRun = { id: req.runId, trigger: "schedule", startedAt: 1, finishedAt: null, status: "running", requestId: "" };
    turns.start(req, run, (o) => outcomes.push(o));
    return { botId, timers, cancelled, outcomes };
  }

  it("the room turn's usage is reported for spend accounting", async () => {
    const s = setup(async () => ({ usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.outcomes[0]).toMatchObject({ status: "ok", usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 } });
    expect(s.timers[0]!.cleared).toBe(true);
  });

  it("past the routine hard limit the room turn is cancelled and the run fails with the hard-limit detail", async () => {
    let finish: (() => void) | null = null;
    const s = setup((sig) => new Promise((resolve) => { finish = () => resolve({ usage: { inputTokens: sig.cancelled ? 7 : 0, outputTokens: 0, costUsd: 0 } }); }));
    expect(s.timers[0]!.ms).toBe(1000);
    s.timers[0]!.fn();
    expect(s.cancelled).toEqual([s.botId]);
    finish!();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.outcomes[0]).toMatchObject({ status: "error", detail: STR.runHardLimit });
  });
});
