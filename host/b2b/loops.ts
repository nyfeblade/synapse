import { LIMITS, type B2BErrorCode, type Chain, type LoopDetector, type SendToAgentArgs } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import type { RequestStore } from "./requests";

export type LoopVerdict = { ok: true } | { ok: false; detector: LoopDetector; error: B2BErrorCode; action: "terminate" | "reject" | "fail"; detail: string };

export const ERROR_OF: Record<LoopDetector, B2BErrorCode> = {
  ping_pong: "b2b_loop_detected",
  repeated_request: "b2b_loop_detected",
  circular_handoff: "b2b_circular_handoff",
  deadlock: "b2b_deadlock",
  chain_too_long: "b2b_chain_too_long",
  budget_exhausted: "b2b_budget_exhausted",
};

interface Exchange { from: string; to: string; at: number; novelty: number; newArtifact: boolean }
interface State {
  version: 1;
  repeats: Record<string, number>;
  handoffs: Record<string, { taskId: string; from: string; to: string }[]>;
  exchanges: Record<string, Exchange[]>;
  terminated: Record<string, string[]>;
}
const EMPTY: State = { version: 1, repeats: {}, handoffs: {}, exchanges: {}, terminated: {} };
const pair = (a: string, b: string) => [a, b].sort().join("__");
const WAITS = new Set(["request", "question", "blocker"]);
const WAKING = new Set(["request", "question", "blocker", "handoff"]);

/** ORIG-09 §09.5: loop and cycle detectors. Every detector ends in a structured error for a Bot; none waits for the user. */
export class LoopTracker {
  private s: State;

  constructor(private file: string, private now: () => number = Date.now) {
    this.s = { ...structuredClone(EMPTY), ...readJson<Partial<State>>(file, {}) };
  }

  /** L2 bookkeeping: G6 rejections in this chain; the caller terminates at ≥ 3. */
  noteRepeat(chainId: string): number {
    this.s.repeats[chainId] = (this.s.repeats[chainId] ?? 0) + 1;
    this.save();
    return this.s.repeats[chainId] as number;
  }

  noteHandoff(chainId: string, taskId: string, from: string, to: string): void {
    (this.s.handoffs[chainId] ??= []).push({ taskId, from, to });
    this.save();
  }

  noteExchange(chainId: string, a: string, b: string, e: { novelty: number; newArtifact: boolean }): void {
    const list = (this.s.exchanges[chainId] ??= []);
    list.push({ from: a, to: b, at: this.now(), novelty: e.novelty, newArtifact: e.newArtifact });
    if (list.length > 40) list.splice(0, list.length - 40);
    this.save();
  }

  terminatePair(chainId: string, a: string, b: string): void {
    const list = (this.s.terminated[chainId] ??= []);
    if (!list.includes(pair(a, b))) list.push(pair(a, b));
    this.save();
  }

  isTerminated(chainId: string, a: string, b: string): boolean {
    return (this.s.terminated[chainId] ?? []).includes(pair(a, b));
  }

  forget(chainId: string): void {
    delete this.s.repeats[chainId];
    delete this.s.handoffs[chainId];
    delete this.s.exchanges[chainId];
    delete this.s.terminated[chainId];
    this.save();
  }

  check(i: { chain: Chain; from: string; to: string; args: SendToAgentArgs; requests: RequestStore; budgetFactor: number }): LoopVerdict {
    const c = i.chain;
    const kind = i.args.kind;
    const no = (detector: LoopDetector, action: "terminate" | "reject" | "fail", detail: string): LoopVerdict => ({ ok: false, detector, error: ERROR_OF[detector], action, detail });

    if (this.isTerminated(c.chainId, i.from, i.to)) return no(c.ended?.detector ?? "ping_pong", "reject", "this exchange was already ended automatically in this chain");
    // L6 token budget (per chain), halved by the usage ladder at ≥ 90% (budgetFactor 0.5)
    if (WAKING.has(kind) && c.weightedTokens > LIMITS.chainTokenBudget * i.budgetFactor) {
      return no("budget_exhausted", "fail", `this chain used ${Math.round(c.weightedTokens)} weighted tokens, over its budget of ${Math.round(LIMITS.chainTokenBudget * i.budgetFactor)}`);
    }
    // L5 hop limit
    if (c.hops + 1 >= LIMITS.maxHops) return no("chain_too_long", "terminate", `the chain reached ${LIMITS.maxHops} hops`);
    // L3 circular handoff
    if (kind === "handoff" && i.args.task_id) {
      const back = (this.s.handoffs[c.chainId] ?? []).some((h) => h.taskId === i.args.task_id && h.from === i.to);
      if (back) return no("circular_handoff", "reject", `task ${i.args.task_id} was already handed off by that Bot in this chain`);
    }
    // L4 wait-for cycle: would from → to close a cycle (to already waits, transitively, on from)?
    if (WAITS.has(kind) && reaches(i.requests.waitGraph(), i.to, i.from)) {
      return no("deadlock", "reject", "that Bot is already waiting, directly or through others, on a request from you");
    }
    // L1 ping-pong
    const recent = (this.s.exchanges[c.chainId] ?? []).filter((e) => pair(e.from, e.to) === pair(i.from, i.to) && this.now() - e.at <= LIMITS.pingPongWindowMs);
    let run = 0;
    for (let k = recent.length - 1; k >= 0; k--) {
      const e = recent[k] as Exchange;
      const next = k === recent.length - 1 ? { from: i.from } : (recent[k + 1] as Exchange);
      if (e.from === next.from) break;
      run++;
    }
    if (run >= LIMITS.pingPongAlternations) {
      const window = recent.slice(-run);
      const mean = window.reduce((s, e) => s + e.novelty, 0) / window.length;
      if (!window.some((e) => e.newArtifact) && mean < LIMITS.pingPongNovelty) {
        return no("ping_pong", "terminate", `${run} back-and-forth messages with no new file or result`);
      }
    }
    return { ok: true };
  }

  private save(): void {
    writeJsonAtomic(this.file, this.s, 0o600);
  }
}

function reaches(g: Map<string, Set<string>>, start: string, goal: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const n = stack.pop() as string;
    if (n === goal) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of g.get(n) ?? []) stack.push(m);
  }
  return false;
}

/** ORIG-09 §09.5: the one structured error the initiating Bot receives (as the tool error, a wake #23, or an inbox item). */
export function structuredError(p: { detector: LoopDetector; error: B2BErrorCode; chainId: string; requests: string[]; hops: number; weightedTokens: number; detail: string; peerName: string; action?: "terminate" | "reject" | "fail" }): { json: Record<string, unknown>; text: string } {
  const json = { error: p.error, detector: p.detector, chain: p.chainId, requests: p.requests, hops: p.hops, weightedTokens: Math.round(p.weightedTokens), detail: p.detail };
  const head = (p.action ?? "terminate") === "terminate"
    ? `[agent-error] Your exchange with ${p.peerName} was ended automatically.`
    : `[agent-error] Your message to ${p.peerName} was not sent.`;
  return { json, text: [head, JSON.stringify(json), "Continue without that exchange: do the work yourself, change the plan, or ask a different Bot."].join("\n") };
}
