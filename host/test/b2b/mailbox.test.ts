import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@synapse/shared";
import { ChainStore } from "../../b2b/chains";
import { installChainTracking, Mailbox, type Delivery } from "../../b2b/mailbox";
import { RequestStore } from "../../b2b/requests";
import { ThreadStore } from "../../b2b/threads";
import { BotService } from "../../bots/bot-service";
import { messageText, type ModelMessage, type TurnResult } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import type { RuntimeMetrics } from "../../metrics/runtime-metrics";
import { emptyContext } from "../../runner/turn-context";
import type { TurnSlot } from "../../runner/turn-slot";
import type { RecipientState, TurnObserver, TurnRunner, WakeSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import type { RunTask } from "../../transcript/run-scheduler";
import { tmpConfig } from "../helpers";

// Strict TS (Controller ruling, matches extension-points.test.ts): ModelMessage is a { text } | { image }
// union; messageText() narrows it. textOf() extends that through the ModelMessage | null this brief's
// decorate() calls return, without changing any assertion.
const textOf = (m: ModelMessage | null | undefined): string | undefined => (m ? messageText(m) : undefined);

interface Wake { botId: string; spec: WakeSpec; id: string; ran: boolean; dropped: boolean }
class FakeRunner {
  state = new Map<string, RecipientState>();
  wakes: Wake[] = [];
  interrupts: string[] = [];
  observers: TurnObserver[] = [];
  enqueueWake(botId: string, spec: WakeSpec): string {
    const w: Wake = { botId, spec, id: `w${this.wakes.length + 1}`, ran: false, dropped: false };
    if (spec.head) this.wakes.unshift(w); else this.wakes.push(w);
    return w.id;
  }
  recipientState(botId: string): RecipientState { return this.state.get(botId) ?? "idle"; }
  queued(botId: string, pred: (t: RunTask) => boolean): number { return this.wakes.filter((w) => w.botId === botId && !w.ran && !w.dropped && pred({ id: w.id } as RunTask)).length; }
  dropQueued(botId: string, pred: (t: RunTask) => boolean): void { for (const w of this.wakes) if (w.botId === botId && pred({ id: w.id } as RunTask)) w.dropped = true; }
  async interruptForPriority(botId: string): Promise<boolean> { this.interrupts.push(botId); return true; }
  addObserver(o: TurnObserver): void { this.observers.push(o); }
  pendingFor(botId: string): Wake[] { return this.wakes.filter((w) => w.botId === botId && !w.ran && !w.dropped); }
  /** Runs the next queued wake for a Bot like the real runner: onStart → prompt() → onSettle. */
  run(botId: string, usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }): { text: string; slot: TurnSlot } {
    const { text, slot, settle } = this.start(botId);
    settle(usage);
    return { text, slot };
  }
  /**
   * Like `run`, but stops after onStart → prompt(), leaving the wake "active" (started, not yet
   * settled) — the same window the real scheduler holds open while `execute()` awaits the brain —
   * so a test can deliver more messages into that window before calling the returned `settle()`.
   */
  start(botId: string, usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }): { text: string; slot: TurnSlot; settle: (u?: typeof usage) => void } {
    const w = this.pendingFor(botId)[0];
    if (!w) throw new Error(`no wake for ${botId}`);
    const slot = { botId, source: w.spec.source, lane: w.spec.lane, context: { ...emptyContext(), ...w.spec.context } } as unknown as TurnSlot;
    w.spec.onStart?.(slot);
    const text = w.spec.prompt().map((m) => messageText(m)).join("\n");
    w.ran = true;
    return { text, slot, settle: (u = usage) => w.spec.onSettle?.(slot, { usage: u } as TurnResult) };
  }
}

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const [a, b, c] = ["Piper", "Scout", "Ledger"].map((name) => bots.create({ origin: "user", kickstart: false, name }));
  const runner = new FakeRunner();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const flush = (maxMs = Infinity) => { for (const t of timers.splice(0)) if (t.live && t.ms <= maxMs) t.fn(); else if (t.live) timers.push(t); };
  let t = 1_000_000;
  const now = () => t;
  const chains = new ChainStore(path.join(cfg.hostPrivate, "chains.json"), now);
  const requests = new RequestStore(path.join(cfg.hostPrivate, "b2b-requests.json"), now);
  const threads = new ThreadStore(path.join(cfg.hostPrivate, "b2b-threads"), now);
  const metrics = { bump: vi.fn(), recordB2B: vi.fn() } as unknown as RuntimeMetrics;
  const nameOf = (id: string) => bots.summary(id).profile.name;
  const mailbox = new Mailbox({
    runner: runner as unknown as TurnRunner, bots, chains, requests, threads, metrics, nameOf, now,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const chain = chains.start("user", a as string);
  const del = (p: Partial<Delivery> & Pick<Delivery, "kind" | "message">): Delivery => ({ from: a as string, fromName: "Piper", chainId: chain.chainId, priority: false, ...p });
  return { bots, runner, mailbox, metrics, chains, requests, chain, del, flush, timers, a: a as string, b: b as string, c: c as string, advance: (ms: number) => { t += ms; } };
}

describe("Mailbox", () => {
  it("coalesces waking messages in the 5 s window into one ordered wake with digests (wake #6)", () => {
    const s = setup();
    const r1 = s.requests.open({ from: s.a, to: s.b, kind: "request", expects: "a CSV of Q3 leads", chainId: s.chain.chainId });
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "Build the Q3 leads CSV", rid: r1.rid, expects: "a CSV of Q3 leads" }));
    s.mailbox.deliverWaking(s.b, s.del({ kind: "blocker", message: "I can't continue until you share the CRM export", rid: "r_bbbbbbbb", from: s.c, fromName: "Ledger" }));
    expect(s.runner.pendingFor(s.b)).toHaveLength(0);
    s.flush();
    expect(s.runner.pendingFor(s.b)).toHaveLength(1);
    const { text, slot } = s.runner.run(s.b);
    expect(text).toContain("[HIDDEN_PROMPT]");
    expect(text).toContain("[agent] 2 messages from other Bots arrived. This is not the user typing.");
    expect(text).toContain("Thread with Piper (id ");
    expect(text.indexOf('kind="blocker"')).toBeLessThan(text.indexOf('kind="request"'));
    expect(text).toContain(`<message kind="request" id="${r1.rid}" from="Piper (id ${s.a.slice(0, 4)}…)" expects="a CSV of Q3 leads">Build the Q3 leads CSV</message>`);
    expect(text).toContain("Never send acknowledgements.");
    expect(slot.context.wake).toEqual({ kind: "agent", senderIds: expect.arrayContaining([s.a, s.c]) });
    expect(s.metrics.bump).toHaveBeenCalledWith(s.b, "coalescedTurns");
    expect(s.runner.wakes[0]?.spec).toMatchObject({ source: "agent", lane: "agent", silenceAllowed: true });
  });

  it("reports pending work while a coalesce timer is armed or messages await a wake, so a caller waiting on real idle doesn't stop too early", () => {
    const s = setup();
    expect(s.mailbox.hasPendingWork()).toBe(false);
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "first", rid: "r_aaaaaaa1", expects: "x" }));
    expect(s.mailbox.hasPendingWork()).toBe(true); // the coalesce timer is armed but hasn't fired
    s.flush();
    expect(s.mailbox.hasPendingWork()).toBe(true); // a wake is queued, waiting to run
    s.runner.run(s.b);
    expect(s.mailbox.hasPendingWork()).toBe(false);
  });

  it("re-arms the coalesce timer on each new arrival (debounce), so a burst spread wider than the window by real scheduling delay still coalesces into one wake", () => {
    const s = setup();
    const isSweep = (x: { ms: number }) => x.ms === 60_000; // Mailbox's own housekeeping timer (armSweep), not the coalesce timer under test
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "first", rid: "r_aaaaaaa1", expects: "x" }));
    expect(s.timers.filter((x) => x.live && !isSweep(x))).toHaveLength(1);
    const firstTimer = s.timers.find((x) => x.live && !isSweep(x));
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "second", rid: "r_aaaaaaa2", expects: "y" }));
    expect(firstTimer?.live).toBe(false); // the original timer was cleared, not left free to fire on its own
    expect(s.timers.filter((x) => x.live && !isSweep(x))).toHaveLength(1); // exactly one fresh timer is armed in its place
    s.flush();
    const { text } = s.runner.run(s.b);
    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  it("caps the debounced wake at coalesceMs from the FIRST arrival, so a sustained sub-window burst can't defer it indefinitely (fix round 1)", () => {
    const s = setup();
    const isSweep = (x: { ms: number }) => x.ms === 60_000;
    // First message arrives at t0: arms a full-window timer.
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "first", rid: "r_aaaaaaa1", expects: "x" }));
    expect(s.timers.filter((x) => x.live && !isSweep(x))).toHaveLength(1);
    // Second message arrives 4 s later (still under the 5 s window): re-arms, but only for the
    // remaining 1 s until the 5 s bound from "first" — not another full 5 s window.
    s.advance(4000);
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "second", rid: "r_aaaaaaa2", expects: "y" }));
    const rearmed = s.timers.find((x) => x.live && !isSweep(x));
    expect(rearmed?.ms).toBe(1000); // capped to the remaining time until firstArrival + coalesceMs, not a fresh 5000
    // A third message arrives right at the 5 s bound. Under the old unbounded re-arm this would push
    // the wake out to t0 + 10 s and no wake would be queued yet; the bound must force it now instead.
    s.advance(1000);
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "third", rid: "r_aaaaaaa3", expects: "z" }));
    expect(s.runner.pendingFor(s.b)).toHaveLength(1); // scheduled immediately, no timer wait left
    expect(s.timers.filter((x) => x.live && !isSweep(x))).toHaveLength(0);
    const { text } = s.runner.run(s.b);
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("third");
  });

  it("takes at most 5 messages per turn and schedules the rest after it settles", () => {
    const s = setup();
    for (let i = 0; i < 7; i++) s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: `Task number ${i}`, rid: `r_aaaaaaa${i}` }));
    s.flush();
    const first = s.runner.run(s.b).text;
    expect(first.match(/<message /g)).toHaveLength(5);
    expect(s.runner.pendingFor(s.b)).toHaveLength(1);
    expect(s.runner.run(s.b).text.match(/<message /g)).toHaveLength(2);
  });

  it("bug 432: a batch stops growing before its wake would pass what Auto-review reads; the rest wake next", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: `${i} ${"m".repeat(1500)}`, rid: `r_aaaaaaa${i}` }));
    s.flush();
    const first = s.runner.run(s.b).text;
    expect(first.match(/<message /g)).toHaveLength(1);
    expect(first.length).toBeLessThanOrEqual(LIMITS.reviewerContextChars + "[HIDDEN_PROMPT]\n".length);
    expect(s.runner.run(s.b).text.match(/<message /g)).toHaveLength(1);
    expect(s.runner.run(s.b).text.match(/<message /g)).toHaveLength(1);
  });

  it("a message that arrives after a follow-up wake is already queued is not dropped when the earlier wake settles (fix round 1)", () => {
    const s = setup();
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "first", rid: "r_aaaaaaa1", expects: "x" }));
    s.flush();
    const w1 = s.runner.start(s.b); // wake #1 is now "active": started, but not yet settled
    s.runner.state.set(s.b, "agent"); // recipientState is no longer idle while wake #1 runs
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "second", rid: "r_aaaaaaa2", expects: "y" }));
    expect(s.runner.pendingFor(s.b)).toHaveLength(1); // a single follow-up wake #2 is queued behind #1
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "third", rid: "r_aaaaaaa3", expects: "z" }));
    expect(s.runner.pendingFor(s.b)).toHaveLength(1); // "third" joins #2's pending batch, no extra wake
    w1.settle(); // wake #1 finally settles — must not clobber #2's bookkeeping or re-schedule a stale #3
    expect(s.runner.pendingFor(s.b)).toHaveLength(1);
    const second = s.runner.run(s.b).text;
    expect(second).toContain("second");
    expect(second).toContain("third");
    expect(s.runner.pendingFor(s.b)).toHaveLength(0); // no leftover wake #3
  });

  it("batches results that arrive while the requester is busy into one wake", () => {
    const s = setup();
    s.runner.state.set(s.a, "user");
    for (const [i, from] of [s.b, s.c, s.b].entries()) s.mailbox.deliverResult(s.a, s.del({ kind: "result", message: `result ${i} with 4${i} rows`, inReplyTo: `r_cccccc0${i}`, from, fromName: "X" }));
    expect(s.runner.pendingFor(s.a)).toHaveLength(1);
    expect(vi.mocked(s.metrics.bump).mock.calls.filter((c) => c[1] === "resultsBatched")).toHaveLength(2);
    expect(s.runner.run(s.a).text.match(/kind="result"/g)).toHaveLength(3);
  });

  it("adds each peer turn's usage to its chain", () => {
    const s = setup();
    s.mailbox.deliverWaking(s.b, s.del({ kind: "question", message: "Which channel?", rid: "r_dddddddd", expects: "a channel name" }));
    s.flush();
    s.runner.run(s.b, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(s.chains.get(s.chain.chainId)).toMatchObject({ peerTurns: 1, weightedTokens: 1500 });
  });

  it("rations priority and follows the recipient-state table", async () => {
    const s = setup();
    expect(s.mailbox.priorityAllowed(s.b, s.chain.chainId, "question")).toEqual({ ok: false, reason: "priority is only for blockers and requests" });
    expect(s.mailbox.priorityAllowed(s.b, s.chain.chainId, "blocker")).toEqual({ ok: true });
    s.runner.state.set(s.b, "agent");
    s.mailbox.deliverWaking(s.b, s.del({ kind: "blocker", message: "Stop the campaign now", priority: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.runner.interrupts).toEqual([s.b]);
    expect(s.runner.pendingFor(s.b)[0]?.spec.head).toBe(true);
    expect(s.mailbox.priorityAllowed(s.b, s.chain.chainId, "request")).toEqual({ ok: false, reason: "Scout already got a priority message in the last 10 minutes" });
    s.runner.state.set(s.c, "parked");
    s.advance(11 * 60_000);
    s.mailbox.deliverWaking(s.c, s.del({ kind: "request", message: "Pause the ads", priority: true, expects: "ads paused" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.runner.interrupts).toEqual([s.b]);
    expect(s.mailbox.priorityAllowed(s.b, s.chain.chainId, "request")).toEqual({ ok: false, reason: "this chain already used its 2 priority messages" });
  });

  it("folds inbox items into the next turn (≤ 10 items, ≤ 3,000 chars) without a wake", () => {
    const s = setup();
    for (let i = 0; i < 12; i++) s.mailbox.deliverInbox(s.a, { from: s.b, fromName: "Scout", text: `moved report ${i} to /workspace/r${i}.pdf`, chainId: s.chain.chainId });
    expect(s.runner.wakes).toHaveLength(0);
    expect(vi.mocked(s.metrics.bump).mock.calls.filter((c) => c[1] === "inboxDelivered")).toHaveLength(12);
    const fold = s.mailbox.decorate(s.a, { source: "user", silenceAllowed: false, lane: "user" });
    expect(textOf(fold)?.split("\n")[0]).toBe("Inbox (no reply needed):");
    expect(textOf(fold)).toContain("- Scout: moved report 11 to /workspace/r11.pdf");
    expect(textOf(fold)).not.toContain("moved report 1 to");
    expect(textOf(fold)).toContain("(2 more in your transcript)");
    expect(s.mailbox.decorate(s.a, { source: "user", silenceAllowed: false, lane: "user" })).toBeNull();
  });

  it("sends loop errors as wake #23 to an idle Bot and to the inbox of a busy one — never a card or tray", () => {
    const s = setup();
    s.mailbox.deliverError(s.a, { text: "[agent-error] Your exchange with Scout was ended automatically.\n{}", chainId: s.chain.chainId });
    expect(s.runner.wakes[0]?.spec).toMatchObject({ source: "agent-error", lane: "agent", silenceAllowed: true });
    expect(s.runner.run(s.a).text).toContain("[agent-error] Your exchange with Scout was ended automatically.");
    s.runner.state.set(s.a, "agent");
    s.mailbox.deliverError(s.a, { text: "[agent-error] second", chainId: s.chain.chainId });
    expect(s.runner.pendingFor(s.a)).toHaveLength(0);
    expect(textOf(s.mailbox.decorate(s.a, { source: "agent", silenceAllowed: true, lane: "agent" }))).toContain("[agent-error] second");
  });

  it("defers peer wakes over the rate limit with backoff instead of blocking", () => {
    const s = setup();
    for (let i = 0; i < 30; i++) {
      s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: `job ${i}`, rid: `r_eeeeee${String(i).padStart(2, "0")}` }));
      s.flush();
      s.runner.run(s.b);
    }
    s.mailbox.deliverWaking(s.b, s.del({ kind: "request", message: "one more job", rid: "r_ffffffff" }));
    s.flush(5000);
    expect(s.runner.pendingFor(s.b)).toHaveLength(0);
    expect(s.mailbox.deferredCount()).toBe(1);
    s.advance(3_600_000);
    s.flush();
    expect(s.runner.pendingFor(s.b)).toHaveLength(1);
  });

  it("notes expired requests in the requester's inbox", () => {
    const s = setup();
    const r = s.requests.open({ from: s.a, to: s.b, kind: "question", expects: "a yes or no", chainId: s.chain.chainId });
    s.advance(24 * 3_600_000);
    expect(s.mailbox.sweepExpired()).toBe(1);
    expect(textOf(s.mailbox.decorate(s.a, { source: "user", silenceAllowed: false, lane: "user" }))).toContain(`Your question ${r.rid} to Scout expired after 24 h with no result.`);
  });
});

describe("installChainTracking", () => {
  it("starts a user chain for user turns and a routine chain for routine fires", () => {
    const s = setup();
    installChainTracking(s.runner as unknown as TurnRunner, s.chains);
    const user = { source: "user", context: emptyContext() } as unknown as TurnSlot;
    const routine = { source: "routine", context: emptyContext() } as unknown as TurnSlot;
    s.runner.observers[0]?.onTurnStart?.(s.a, user);
    s.runner.observers[0]?.onTurnStart?.(s.a, routine);
    expect(s.chains.get(user.context.chainId as string)?.rootKind).toBe("user");
    expect(s.chains.get(routine.context.chainId as string)?.rootKind).toBe("routine");
    const peer = { source: "agent", context: { ...emptyContext(), chainId: s.chain.chainId } } as unknown as TurnSlot;
    s.runner.observers[0]?.onTurnStart?.(s.b, peer);
    expect(peer.context.chainId).toBe(s.chain.chainId);
  });
  it("0.1.4: a nudge roots as the turn that caused it, not as a user chain", () => {
    const s = setup();
    installChainTracking(s.runner as unknown as TurnRunner, s.chains);
    const owner = { source: "reply-nudge", context: emptyContext() } as unknown as TurnSlot;
    const routine = { source: "reply-nudge", reviewSource: "routine", context: emptyContext() } as unknown as TurnSlot;
    const mcp = { source: "closing-nudge", reviewSource: "mcp", context: emptyContext() } as unknown as TurnSlot;
    for (const x of [owner, routine, mcp]) s.runner.observers[0]?.onTurnStart?.(s.a, x);
    expect(s.chains.get(owner.context.chainId as string)?.rootKind).toBe("user");
    expect(s.chains.get(routine.context.chainId as string)?.rootKind).toBe("routine");
    expect(s.chains.get(mcp.context.chainId as string)?.rootKind).toBe("system");
  });
});
