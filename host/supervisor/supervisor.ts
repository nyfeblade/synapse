import { LIMITS } from "@synapse/shared";
import type { Lane, ProcState, SupervisedBrain } from "../brain/types";
import type { Caps } from "./caps";

export interface Lease { botId: string; lane: Lane; brain: SupervisedBrain; grantedAt: number; release(): void }

export interface SupervisorOptions {
  caps: Caps;
  brainFactory(botId: string): SupervisedBrain;
  now?: () => number;
  onPreempt?(botId: string): void;
  onCrashBackoff?(botId: string): void;
  onStall?(botId: string): void;
  /** TTFT war room: a live ceiling on idle warm processes (1 while a voice call is live); min'd with caps.maxWarm. */
  warmLimit?(): number;
  /** TTFT war room: warm CLI processes outside the Supervisor that count against the same budget (the reviewer's prewarm pool). */
  externalWarm?(): number;
}

interface Waiter { botId: string; lane: Lane; acceptedAtMs: number; enqueuedAt: number; preempted: boolean; resolve(l: Lease): void; reject(e: Error): void }

const LANE_RANK: Record<Lane, number> = { user: 0, agent: 1, background: 2 };
const NOT_LIVE: ProcState[] = ["cold", "crashed"];

export class Supervisor {
  private brains = new Map<string, SupervisedBrain>();
  private leases = new Map<string, Lease>();
  private queue: Waiter[] = [];
  private crashTimes = new Map<string, number[]>();
  private backoffUntil = new Map<string, number>();
  private rssOf: ((pid: number) => number) | null = null;
  private pumping = false;
  private again = false;
  private stopped = false;
  private now: () => number;

  constructor(private o: SupervisorOptions) {
    this.now = o.now ?? Date.now;
  }

  setRssSampler(fn: (pid: number) => number): void {
    this.rssOf = fn;
  }

  /** §16.1: creating a Bot registers nothing but this lazy, cold brain object. */
  brainFor(botId: string): SupervisedBrain {
    let b = this.brains.get(botId);
    if (!b) {
      if (botId.startsWith("child:")) throw new Error(`Unknown child ${botId}`);
      b = this.o.brainFactory(botId);
      b.onStateChange((s) => {
        if (s === "crashed") this.noteCrash(botId);
        void this.pump();
      });
      this.brains.set(botId, b);
    }
    return b;
  }

  counts(): { live: number; running: number; queued: number } {
    return { live: this.liveCount(), running: this.leases.size, queued: this.queue.length };
  }

  /** §16.5: a child (subagent/coding agent) arrives with its brain already built; it is supervised like any Bot under `child:<id>`. */
  adopt(key: string, brain: SupervisedBrain): void {
    if (this.brains.has(key)) throw new Error(`Supervisor already has ${key}`);
    brain.onStateChange((s) => {
      if (s === "crashed") this.noteCrash(key);
      void this.pump();
    });
    this.brains.set(key, brain);
  }

  acquire(botId: string, lane: Lane, acceptedAtMs: number): Promise<Lease> {
    if (this.stopped) return Promise.reject(new Error("Supervisor is shutting down"));
    return new Promise((resolve, reject) => {
      this.queue.push({ botId, lane, acceptedAtMs, enqueuedAt: this.now(), preempted: false, resolve, reject });
      this.queue.sort((a, b) => LANE_RANK[a.lane] - LANE_RANK[b.lane] || a.acceptedAtMs - b.acceptedAtMs);
      void this.pump();
    });
  }

  private liveCount(): number {
    let n = 0;
    for (const [id, b] of this.brains) if (!NOT_LIVE.includes(b.procState) || this.leases.has(id)) n++;
    return n;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        for (const w of [...this.queue]) {
          const r = await this.tryAdmit(w);
          if (r === "admitted") this.queue.splice(this.queue.indexOf(w), 1);
          else if (r === "blocked") break;
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  private async tryAdmit(w: Waiter): Promise<"admitted" | "blocked" | "skip"> {
    if ((this.backoffUntil.get(w.botId) ?? 0) > this.now()) return "skip";
    if (this.leases.has(w.botId)) return "skip";
    if (this.leases.size >= this.o.caps.maxRunning) return "blocked";
    const b = this.brainFor(w.botId);
    if (NOT_LIVE.includes(b.procState) && this.liveCount() >= this.o.caps.maxLive) {
      const victim = this.lruIdle(w.botId);
      if (!victim) return "blocked";
      await victim.cool("evicted (LRU)");
      if (this.liveCount() >= this.o.caps.maxLive) return "blocked";
    }
    const lease: Lease = {
      botId: w.botId, lane: w.lane, brain: b, grantedAt: this.now(),
      release: () => {
        if (this.leases.get(w.botId) !== lease) return;
        this.leases.delete(w.botId);
        void this.pump();
      },
    };
    this.leases.set(w.botId, lease);
    w.resolve(lease);
    return "admitted";
  }

  private lruIdle(exceptBotId: string): SupervisedBrain | null {
    let best: SupervisedBrain | null = null;
    for (const [id, b] of this.brains) {
      if (id === exceptBotId || this.leases.has(id) || b.procState !== "warm_idle") continue;
      if (!best || b.lastActiveAt < best.lastActiveAt) best = b;
    }
    return best;
  }

  private noteCrash(botId: string): void {
    const t = this.now();
    const list = (this.crashTimes.get(botId) ?? []).filter((x) => t - x < LIMITS.crashWindowMs);
    list.push(t);
    if (list.length >= LIMITS.crashesForBackoff) {
      this.backoffUntil.set(botId, t + LIMITS.crashBackoffMs);
      this.crashTimes.set(botId, []);
      this.o.onCrashBackoff?.(botId);
    } else this.crashTimes.set(botId, list);
  }

  /** Called every second by the host: idle cooling, user preemption, stalls, RSS limits, backoff expiry. */
  async tick(): Promise<void> {
    const t = this.now();
    for (const [id, b] of this.brains) {
      if (b.procState === "warm_idle" && !this.leases.has(id) && t - b.lastActiveAt >= this.o.caps.warmIdleMs) await b.cool("idle");
      if (b.procState === "running" && !b.toolInFlight) {
        const silentFromStart = b.lastEventAt < b.turnStartedAt && t - b.turnStartedAt > LIMITS.firstEventStallMs;
        const silentMidTurn = b.lastEventAt >= b.turnStartedAt && t - b.lastEventAt > LIMITS.midTurnStallMs;
        if (silentFromStart || silentMidTurn) {
          this.o.onStall?.(id);
          await b.interrupt("stall");
        }
      }
      if (this.rssOf && b.pid !== null) {
        const rss = this.rssOf(b.pid);
        if (rss > LIMITS.rssKillBytes) {
          await b.interrupt("rss limit");
          await b.cool("rss > 3 GB", true);
        } else if (rss > LIMITS.rssCoolBytes && b.procState === "warm_idle") await b.cool("rss > 2 GB");
      }
    }
    await this.enforceWarmCap();
    const head = this.queue.find((w) => w.lane === "user");
    if (head && !head.preempted && t - head.enqueuedAt >= this.o.caps.userPreemptAfterMs) {
      const bg = [...this.leases.values()].filter((l) => l.lane === "background").sort((a, b) => b.grantedAt - a.grantedAt)[0];
      if (bg) {
        head.preempted = true;
        this.o.onPreempt?.(bg.botId);
      }
    }
    await this.pump();
  }

  /** TTFT war room: idle warm Bot processes allowed right now (voice calls and the reviewer's prewarm pool take from it). */
  private warmBudget(): number | undefined {
    const max = this.o.caps.maxWarm;
    if (max === undefined) return undefined;
    const cap = this.o.warmLimit ? Math.min(max, this.o.warmLimit()) : max;
    return Math.max(0, cap - (this.o.externalWarm?.() ?? 0));
  }

  /**
   * TTFT war room: at most warmBudget() idle warm processes; the least recently used beyond it cool (RAM). Re-read
   * after every cool: cool() awaits the CLI's exit, and meanwhile a turn can lease a Bot that was idle when this
   * started — that one must never be cooled mid-turn (review fix round 1, blocking 1).
   */
  private async enforceWarmCap(): Promise<void> {
    const tried = new Set<string>(); // a cool that leaves the process warm is not retried in this pass
    for (;;) {
      const budget = this.warmBudget();
      if (budget === undefined) return;
      const idle = [...this.brains].filter(([id, b]) => b.procState === "warm_idle" && !this.leases.has(id)).sort(([, a], [, b]) => a.lastActiveAt - b.lastActiveAt);
      const victim = idle.find(([id]) => !tried.has(id));
      if (idle.length <= budget || !victim) return;
      tried.add(victim[0]);
      await victim[1].cool("warm cap");
    }
  }

  async forget(botId: string): Promise<void> {
    this.queue = this.queue.filter((w) => {
      if (w.botId !== botId) return true;
      w.reject(new Error("Bot deleted"));
      return false;
    });
    const b = this.brains.get(botId);
    if (b) {
      await b.interrupt("bot deleted");
      await b.dispose();
      this.brains.delete(botId);
    }
    this.leases.delete(botId);
  }

  /** §16.9 steps 3–4: interrupt everything, close inputs, force-kill at 4.5 s. Markers are written by the runner first. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const w of this.queue.splice(0)) w.reject(new Error("Supervisor is shutting down"));
    const all = [...this.brains.values()];
    await Promise.race([Promise.all(all.map((b) => b.interrupt("shutdown"))), new Promise((r) => setTimeout(r, 3000))]);
    await Promise.race([Promise.all(all.map((b) => b.cool("shutdown"))), new Promise((r) => setTimeout(r, 1500))]);
    await Promise.all(all.filter((b) => b.procState !== "cold").map((b) => b.cool("shutdown", true)));
  }
}
