import { LIMITS, type B2BKind, type ChainRootKind, type LoopDetector, type ResultStatus } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { ModelMessage, TurnResult, WakeSource } from "../brain/types";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { HIDDEN_MARKER } from "../runner/prompt-collector";
import type { TurnSlot } from "../runner/turn-slot";
import type { PromptDecorator, TurnRunner } from "../runner/turn-runner";
import type { ChainStore } from "./chains";
import type { RequestStore } from "./requests";
import type { ThreadStore } from "./threads";
import { agentWakeFits, renderAgentWake } from "./wake-prompt";

export { renderAgentWake } from "./wake-prompt";

export interface Delivery {
  from: string; fromName: string; kind: B2BKind; message: string; rid?: string; expects?: string; inReplyTo?: string;
  status?: ResultStatus; artifacts?: string[]; images?: { url: string; alt?: string }[]; chainId: string; priority: boolean; taskId?: string;
}
export interface MailboxDeps {
  runner: TurnRunner; bots: BotService; chains: ChainStore; requests: RequestStore; threads: ThreadStore; metrics: RuntimeMetrics;
  nameOf(id: string): string; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void;
  coalesceMs?: number; budgetFactor?(): number; onTerminateChain?(chainId: string, detector: LoopDetector): void;
}
interface Box { pending: Delivery[]; timer: unknown | null; taskId: string | null; started: boolean; batch: Delivery[] | null; firstArrival: number | null }
interface InboxItem { from: string; fromName: string; text: string; chainId: string; at: number }

const INBOX_KEY = "b2bInbox";
const ORDER: Record<B2BKind, number> = { blocker: 0, question: 1, request: 2, handoff: 3, result: 4 };
const HOUR = 3_600_000;
const TEN_MIN = 600_000;
const SWEEP_MS = 60_000;
const USER_ROOTS = new Set<WakeSource>(["user", "kickstart", "reply-nudge", "closing-nudge", "ack-redrive", "widget-answer", "broadcast"]);

/** ORIG-09 §09.3 wake economics: which messages wake a Bot, when, and how many turns a burst costs. */
export class Mailbox {
  readonly decorate: PromptDecorator;
  private boxes = new Map<string, Box>();
  private peerTurns: { botId: string; at: number }[] = [];
  private deferrals = new Map<string, { attempt: number; timer: unknown | null }>();
  private lastPriority = new Map<string, number>();
  private chainPriority = new Map<string, number>();
  private sweepTimer: unknown = null;
  private coalesceMs: number;

  constructor(private d: MailboxDeps) {
    this.coalesceMs = d.coalesceMs ?? LIMITS.coalesceWindowMs;
    this.decorate = (botId) => this.fold(botId);
    this.armSweep();
  }

  // ---------- delivery ----------
  deliverWaking(to: string, del: Delivery): void {
    if (del.priority) void this.priorityDeliver(to, del);
    else this.enqueue(to, del);
  }

  deliverResult(to: string, del: Delivery): void {
    this.enqueue(to, del);
  }

  deliverInbox(to: string, item: { from: string; fromName: string; text: string; chainId: string }): void {
    if (!this.d.bots.has(to)) return;
    this.pushInbox(to, { ...item, at: this.d.now() });
    this.d.metrics.bump(to, "inboxDelivered");
    this.d.metrics.recordB2B({ botId: to, chainId: item.chainId, event: "inbox" });
  }

  /** Loop errors (Task 28): wake #23 for an idle Bot, else the inbox. Never a card, a tray or a question to the user. */
  deliverError(to: string, e: { text: string; chainId: string }): void {
    if (!this.d.bots.has(to)) return;
    if (this.d.runner.recipientState(to) !== "idle") {
      this.pushInbox(to, { from: "host", fromName: "System", text: e.text, chainId: e.chainId, at: this.d.now() });
      return;
    }
    this.d.runner.enqueueWake(to, {
      source: "agent-error", lane: "agent", silenceAllowed: true, context: { chainId: e.chainId },
      prompt: () => [{ text: `${HIDDEN_MARKER}\n${fillTemplate(loadPrompt("wakes/agent-error.md"), { TEXT: e.text }).trim()}` }],
    });
  }

  /** EVT-14 as limited by ORIG-09 §09.3: blocker/request only, ≤ 1 per recipient per 10 min, ≤ 2 per chain. */
  priorityAllowed(to: string, chainId: string, kind: B2BKind): { ok: true } | { ok: false; reason: string } {
    if (kind !== "blocker" && kind !== "request") return { ok: false, reason: "priority is only for blockers and requests" };
    const last = this.lastPriority.get(to);
    if (last !== undefined && this.d.now() - last < LIMITS.priorityPerRecipientMs) return { ok: false, reason: `${this.d.nameOf(to)} already got a priority message in the last 10 minutes` };
    if ((this.chainPriority.get(chainId) ?? 0) >= LIMITS.priorityPerChain) return { ok: false, reason: "this chain already used its 2 priority messages" };
    return { ok: true };
  }

  deferredCount(): number {
    return [...this.deferrals.values()].filter((x) => x.timer !== null).length;
  }

  /**
   * True while any box has an armed coalesce timer, an admission backoff timer, or messages that
   * haven't yet been folded into a scheduled wake. A caller polling `TurnRunner.isIdle` alone can't see
   * this: the scheduler looks idle for the whole coalesce window even though a wake is coming. Tests
   * that wait for a bot-to-bot exchange to fully settle should treat this as "not idle" too, or they can
   * return before a delayed timer (under real system load, or a large `coalesceMs`) ever fires.
   */
  hasPendingWork(): boolean {
    for (const b of this.boxes.values()) if (b.timer !== null || b.pending.length > 0) return true;
    for (const d of this.deferrals.values()) if (d.timer !== null) return true;
    return false;
  }

  /** Open requests expire after 24 h; the requester gets an inbox note, not a wake (§09.1). */
  sweepExpired(): number {
    const due = this.d.requests.expireDue();
    for (const r of due) {
      this.deliverInbox(r.from, { from: r.to, fromName: this.d.nameOf(r.to), text: `Your ${r.kind} ${r.rid} to ${this.d.nameOf(r.to)} expired after 24 h with no result.`, chainId: r.chainId });
    }
    return due.length;
  }

  stop(): void {
    if (this.sweepTimer !== null) this.d.clearTimer(this.sweepTimer);
    this.sweepTimer = null;
    for (const b of this.boxes.values()) if (b.timer !== null) this.d.clearTimer(b.timer);
    for (const x of this.deferrals.values()) if (x.timer !== null) this.d.clearTimer(x.timer);
  }

  // ---------- internals ----------
  private box(to: string): Box {
    let b = this.boxes.get(to);
    if (!b) { b = { pending: [], timer: null, taskId: null, started: false, batch: null, firstArrival: null }; this.boxes.set(to, b); }
    // A queued wake that the runner dropped (Stop, delete, interrupt) no longer carries the pending messages.
    if (b.taskId !== null && !b.started && this.d.runner.queued(to, (t) => t.id === b?.taskId) === 0) b.taskId = null;
    return b;
  }

  private enqueue(to: string, del: Delivery): void {
    const box = this.box(to);
    const joins = box.pending.length > 0 || (box.taskId !== null && !box.started);
    box.pending.push(del);
    if (del.kind === "result" && joins) this.d.metrics.bump(to, "resultsBatched");
    if (box.taskId !== null && !box.started) return; // the queued wake builds its prompt at turn start and takes this message too
    if (this.d.runner.recipientState(to) === "idle") {
      // Debounce, capped: each fresh arrival re-arms the window instead of racing a timer set from the
      // first message, so a burst coalesces as long as its messages keep arriving close together — real
      // scheduling jitter between them (host load, a slow tool round-trip) shouldn't be able to split it
      // just because the *whole* burst spans longer than one window measured from the start. But the
      // wake is never pushed out past `coalesceMs` from the *first* message in the burst: a sender that
      // keeps calling SendToAgent faster than the coalesce window (a single Agent SDK turn can call a
      // tool many times in a row) must not be able to defer the recipient's wake indefinitely.
      const now = this.d.now();
      if (box.timer === null) box.firstArrival = now;
      const deadline = (box.firstArrival ?? now) + this.coalesceMs;
      if (box.timer !== null) this.d.clearTimer(box.timer);
      if (now >= deadline) {
        box.timer = null;
        box.firstArrival = null;
        this.schedule(to, false);
        return;
      }
      box.timer = this.d.setTimer(() => { box.timer = null; box.firstArrival = null; this.schedule(to, false); }, deadline - now);
      return;
    }
    this.schedule(to, false); // queued behind the current run; later arrivals join it
  }

  private async priorityDeliver(to: string, del: Delivery): Promise<void> {
    this.lastPriority.set(to, this.d.now());
    this.chainPriority.set(del.chainId, (this.chainPriority.get(del.chainId) ?? 0) + 1);
    const box = this.box(to);
    box.pending.push(del);
    const state = this.d.runner.recipientState(to);
    if (state === "agent" || state === "background" || state === "group-member") await this.d.runner.interruptForPriority(to, "a priority message from another Bot arrived");
    if (box.timer !== null) { this.d.clearTimer(box.timer); box.timer = null; box.firstArrival = null; }
    if (box.taskId !== null && !box.started) {
      const id = box.taskId;
      this.d.runner.dropQueued(to, (t) => t.id === id);
      box.taskId = null;
    }
    this.schedule(to, true);
  }

  private schedule(to: string, head: boolean): void {
    const box = this.box(to);
    if (!box.pending.length || (box.taskId !== null && !box.started)) return;
    if (!this.d.bots.has(to)) { box.pending = []; return; }
    if (!this.admit(to)) return;
    box.started = false;
    box.batch = null;
    const first = [...box.pending].sort((x, y) => ORDER[x.kind] - ORDER[y.kind])[0] as Delivery;
    // The id isn't known until enqueueWake returns, but onSettle can't fire before that (it always
    // takes at least one microtask), so the closure below always sees the id it was assigned.
    let id = "";
    id = this.d.runner.enqueueWake(to, {
      source: "agent", lane: "agent", silenceAllowed: true, head,
      context: { chainId: first.chainId, wake: { kind: "agent", senderIds: [...new Set(box.pending.map((p) => p.from))] } },
      prompt: () => this.take(to),
      onStart: (slot) => {
        box.started = true;
        const batch = this.batchOf(to);
        if (batch[0]) slot.context.chainId = batch[0].chainId;
        slot.context.wake = { kind: "agent", senderIds: [...new Set(batch.map((m) => m.from))] };
      },
      onSettle: (slot, result) => this.settled(to, id, slot, result),
    });
    box.taskId = id;
  }

  /** Picks this turn's batch once: ordered blocker > question > request > handoff > result, ≤ 5 messages, ≤ 20,000 chars,
   *  and (bug 432) a wake Auto-review can read whole. */
  private batchOf(to: string): Delivery[] {
    const box = this.box(to);
    if (box.batch) return box.batch;
    const sorted = box.pending.map((m, i) => ({ m, i })).sort((x, y) => ORDER[x.m.kind] - ORDER[y.m.kind] || x.i - y.i).map((x) => x.m);
    const batch: Delivery[] = [];
    let chars = 0;
    for (const m of sorted) {
      if (batch.length >= LIMITS.coalesceMaxMessages) break;
      if (batch.length && chars + m.message.length > LIMITS.coalesceMaxChars) break;
      // Bug 432: the batch's wake stays within what Auto-review reads (the first message always fits: b2b/gate.ts).
      if (batch.length && !agentWakeFits([...batch, m])) break;
      batch.push(m);
      chars += m.message.length;
    }
    box.pending = box.pending.filter((m) => !batch.includes(m));
    box.batch = batch;
    if (batch.length >= 2) {
      this.d.metrics.bump(to, "coalescedTurns");
      this.d.metrics.recordB2B({ botId: to, chainId: batch[0]?.chainId ?? null, event: "coalesced" });
    }
    return batch;
  }

  private take(to: string): ModelMessage[] {
    const batch = this.batchOf(to);
    const senders = [...new Set(batch.map((m) => m.from))];
    const digests = senders.map((s) => this.d.threads.digest(to, s, this.d.requests, this.d.nameOf));
    return [{ text: `${HIDDEN_MARKER}\n${renderAgentWake({ messages: batch, digests, nameOf: this.d.nameOf })}` }];
  }

  /**
   * A message arriving while this wake is active (started, not yet settled) can't join its already-taken
   * batch, so it schedules its own follow-up wake and takes over the box's bookkeeping (`enqueue`'s
   * "queued behind the current run" branch). When the earlier wake then settles, its `taskId` no longer
   * matches `box.taskId` — that's the signal this settle is stale; resetting the box or rescheduling here
   * would clobber the follow-up's tracking and either drop its pending messages or double-schedule them.
   * Usage still gets recorded either way, since it reflects real work this turn actually did.
   */
  private settled(to: string, taskId: string, slot: TurnSlot, result: TurnResult | null): void {
    const box = this.box(to);
    const chainId = slot.context.chainId;
    if (result && chainId && this.d.chains.get(chainId)) this.d.chains.addPeerTurn(chainId, result.usage);
    if (box.taskId !== taskId) return;
    box.taskId = null;
    box.started = false;
    box.batch = null;
    if (box.pending.length) this.schedule(to, false);
  }

  /** I6: admission for a room turn a Bot's group post would start (same per-recipient and account limits; no deferral). */
  tryAdmit(to: string): boolean {
    const t = this.d.now();
    this.peerTurns = this.peerTurns.filter((p) => t - p.at < HOUR);
    const mine = this.peerTurns.filter((p) => p.botId === to).length;
    const account = this.peerTurns.filter((p) => t - p.at < TEN_MIN).length;
    if (mine >= LIMITS.peerTurnsPerBotPerHour || account >= LIMITS.accountPeerTurnsPer10Min) return false;
    this.peerTurns.push({ botId: to, at: t });
    return true;
  }

  /** Rate protection that never blocks work: over 30 peer turns per Bot per hour or 60 per account per 10 min → defer with backoff. */
  private admit(to: string): boolean {
    const t = this.d.now();
    this.peerTurns = this.peerTurns.filter((p) => t - p.at < HOUR);
    const mine = this.peerTurns.filter((p) => p.botId === to).length;
    const account = this.peerTurns.filter((p) => t - p.at < TEN_MIN).length;
    if (mine < LIMITS.peerTurnsPerBotPerHour && account < LIMITS.accountPeerTurnsPer10Min) {
      this.deferrals.delete(to);
      this.peerTurns.push({ botId: to, at: t });
      return true;
    }
    const def = this.deferrals.get(to) ?? { attempt: 0, timer: null };
    if (def.timer === null) {
      const steps = LIMITS.peerDeferBackoffMs;
      const ms = steps[Math.min(def.attempt, steps.length - 1)] as number;
      def.attempt += 1;
      def.timer = this.d.setTimer(() => { def.timer = null; this.schedule(to, false); }, ms);
    }
    this.deferrals.set(to, def);
    return false;
  }

  private pushInbox(to: string, item: InboxItem): void {
    const store = this.d.bots.require(to).store;
    store.setKv(INBOX_KEY, [...store.getKv<InboxItem[]>(INBOX_KEY, []), item].slice(-200));
  }

  /** Inbox fold for any turn: the newest ≤ 10 items / 3,000 chars, above the prompt; older ones are counted, not shown. */
  private fold(botId: string): ModelMessage | null {
    if (!this.d.bots.has(botId)) return null;
    const store = this.d.bots.require(botId).store;
    const items = store.getKv<InboxItem[]>(INBOX_KEY, []);
    if (!items.length) return null;
    store.deleteKv(INBOX_KEY);
    const lines: string[] = [];
    let chars = 0;
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k] as InboxItem;
      const line = `- ${it.fromName}: ${it.text.replace(/\s+/g, " ").trim()}`;
      if (lines.length >= LIMITS.inboxFoldItems || (lines.length && chars + line.length > LIMITS.inboxFoldChars)) break;
      lines.unshift(line.slice(0, LIMITS.inboxFoldChars));
      chars += line.length;
    }
    const more = items.length - lines.length;
    return { text: `Inbox (no reply needed):\n${lines.join("\n")}${more > 0 ? `\n(${more} more in your transcript)` : ""}` };
  }

  private armSweep(): void {
    this.sweepTimer = this.d.setTimer(() => { this.sweepExpired(); this.armSweep(); }, SWEEP_MS);
  }
}

/** ORIG-09 §09.5: a user message or routine fire starts a chain; peer wakes carry the sender's chain in their context. */
export function installChainTracking(runner: TurnRunner, chains: ChainStore): void {
  runner.addObserver({
    onTurnStart: (botId, slot) => {
      if (slot.context.chainId) return;
      // 0.1.4: a follow-up nudge roots as the turn that caused it (a routine's or an app's nudge is not a user chain).
      const src = slot.reviewSource ?? slot.source;
      const kind: ChainRootKind = src === "routine" ? "routine" : USER_ROOTS.has(src) ? "user" : "system";
      slot.context.chainId = chains.start(kind, botId).chainId;
    },
  });
}
