import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Chain, SendToAgentArgs } from "@synapse/shared";
import { LoopTracker, structuredError } from "../../b2b/loops";
import { RequestStore } from "../../b2b/requests";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "loops-"));
const chain = (p: Partial<Chain> = {}): Chain => ({ chainId: "c_1", rootKind: "user", rootBotId: "A", rootAt: 0, hops: 3, peerTurns: 2, weightedTokens: 1000, costUsd: 0, lastActivityAt: 0, ...p });
const args = (p: Partial<SendToAgentArgs>): SendToAgentArgs => ({ target_id: "B", kind: "request", message: "Please do the thing", expects: "the thing done", ...p });

function setup() {
  const dir = tmp();
  let t = 1_000_000;
  const now = () => t;
  return { loops: new LoopTracker(path.join(dir, "loops.json"), now), requests: new RequestStore(path.join(dir, "req.json"), now), advance: (ms: number) => { t += ms; } };
}

describe("LoopTracker", () => {
  it("L6 fails further requests when the chain is over its weighted-token budget, halved near the usage limit", () => {
    const { loops, requests } = setup();
    expect(loops.check({ chain: chain({ weightedTokens: 1_500_001 }), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toMatchObject({ ok: false, detector: "budget_exhausted", error: "b2b_budget_exhausted", action: "fail" });
    expect(loops.check({ chain: chain({ weightedTokens: 1_500_001 }), from: "A", to: "B", args: args({ kind: "result", in_reply_to: "r_x" }), requests, budgetFactor: 1 })).toEqual({ ok: true });
    expect(loops.check({ chain: chain({ weightedTokens: 800_000 }), from: "A", to: "B", args: args({}), requests, budgetFactor: 0.5 })).toMatchObject({ detector: "budget_exhausted" });
  });

  it("L5 terminates the chain at 40 hops", () => {
    const { loops, requests } = setup();
    expect(loops.check({ chain: chain({ hops: 38 }), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toEqual({ ok: true });
    expect(loops.check({ chain: chain({ hops: 39 }), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toMatchObject({ detector: "chain_too_long", error: "b2b_chain_too_long", action: "terminate" });
  });

  it("L3 rejects a handoff back to a Bot that already handed the task off", () => {
    const { loops, requests } = setup();
    loops.noteHandoff("c_1", "t_task", "A", "B");
    loops.noteHandoff("c_1", "t_task", "B", "C");
    expect(loops.check({ chain: chain(), from: "C", to: "A", args: args({ kind: "handoff", task_id: "t_task", target_id: "A" }), requests, budgetFactor: 1 })).toMatchObject({ detector: "circular_handoff", error: "b2b_circular_handoff", action: "reject" });
    expect(loops.check({ chain: chain(), from: "C", to: "D", args: args({ kind: "handoff", task_id: "t_task", target_id: "D" }), requests, budgetFactor: 1 })).toEqual({ ok: true });
  });

  it("L4 rejects a request that would close a wait-for cycle", () => {
    const { loops, requests } = setup();
    requests.open({ from: "B", to: "C", kind: "question", expects: "an answer please", chainId: "c_x" });
    requests.open({ from: "C", to: "A", kind: "request", expects: "a file please", chainId: "c_y" });
    expect(loops.check({ chain: chain(), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toMatchObject({ detector: "deadlock", error: "b2b_deadlock", action: "reject" });
    expect(loops.check({ chain: chain(), from: "A", to: "B", args: args({ kind: "handoff", task_id: "t_1" }), requests, budgetFactor: 1 })).toEqual({ ok: true });
  });

  it("L1 terminates a ping-pong with no new artifact and low novelty, but not a productive exchange", () => {
    const { loops, requests, advance } = setup();
    for (const [a, b] of [["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"]] as const) { loops.noteExchange("c_1", a, b, { novelty: 0.1, newArtifact: false }); advance(60_000); }
    expect(loops.check({ chain: chain(), from: "A", to: "B", args: args({ kind: "result" }), requests, budgetFactor: 1 })).toMatchObject({ detector: "ping_pong", error: "b2b_loop_detected", action: "terminate" });
    expect(loops.check({ chain: chain(), from: "B", to: "A", args: args({ kind: "result" }), requests, budgetFactor: 1 })).toEqual({ ok: true });
    loops.noteExchange("c_2", "A", "B", { novelty: 0.1, newArtifact: true });
    for (const [a, b] of [["B", "A"], ["A", "B"], ["B", "A"]] as const) loops.noteExchange("c_2", a, b, { novelty: 0.1, newArtifact: false });
    expect(loops.check({ chain: chain({ chainId: "c_2" }), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toEqual({ ok: true });
    advance(31 * 60_000);
    expect(loops.check({ chain: chain(), from: "A", to: "B", args: args({}), requests, budgetFactor: 1 })).toEqual({ ok: true });
  });

  it("counts G6 repeats per chain, remembers terminated pairs, persists and forgets", () => {
    const dir = tmp();
    const loops = new LoopTracker(path.join(dir, "loops.json"));
    expect([loops.noteRepeat("c_1"), loops.noteRepeat("c_1"), loops.noteRepeat("c_1")]).toEqual([1, 2, 3]);
    loops.terminatePair("c_1", "A", "B");
    const again = new LoopTracker(path.join(dir, "loops.json"));
    expect(again.isTerminated("c_1", "B", "A")).toBe(true);
    expect(again.check({ chain: chain(), from: "B", to: "A", args: args({}), requests: new RequestStore(path.join(dir, "r.json")), budgetFactor: 1 })).toMatchObject({ ok: false, action: "reject" });
    again.forget("c_1");
    expect(again.isTerminated("c_1", "A", "B")).toBe(false);
    expect(again.noteRepeat("c_1")).toBe(1);
  });
});

describe("structuredError", () => {
  it("renders the §09.5 error block", () => {
    const e = structuredError({ detector: "ping_pong", error: "b2b_loop_detected", chainId: "c_4f9a", requests: ["r_7k2m9q"], hops: 9, weightedTokens: 412000, detail: "4 back-and-forth messages with no new file or result", peerName: "Scout" });
    expect(e.json).toEqual({ error: "b2b_loop_detected", detector: "ping_pong", chain: "c_4f9a", requests: ["r_7k2m9q"], hops: 9, weightedTokens: 412000, detail: "4 back-and-forth messages with no new file or result" });
    expect(e.text).toBe([
      "[agent-error] Your exchange with Scout was ended automatically.",
      JSON.stringify(e.json),
      "Continue without that exchange: do the work yourself, change the plan, or ask a different Bot.",
    ].join("\n"));
    expect(structuredError({ detector: "deadlock", error: "b2b_deadlock", chainId: "c", requests: [], hops: 1, weightedTokens: 0, detail: "d", peerName: "Scout", action: "reject" }).text).toMatch(/^\[agent-error\] Your message to Scout was not sent\./);
  });
});
