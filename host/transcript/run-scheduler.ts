import { LIMITS } from "@synapse/shared";
import type { Lane, WakeSource } from "../brain/types";
import { log } from "../util/log";

export interface RunTask {
  id: string;
  lane: Lane;
  source: WakeSource;
  acceptedAtMs: number;
  groupMember?: boolean;
  run(): Promise<void>;
}

export interface RunSchedulerOptions {
  onWatchdogInterrupt(task: RunTask): void;
  onEscape(task: RunTask): void;
  onIdle?(): void;
  /** Box maintenance (portable install): while true, no NEW run starts; queued runs wait (never dropped) and the one
   *  already running finishes. resume() starts the queue again. */
  hold?(): boolean;
  watchdogMs?: number;
  graceMs?: number;
}

/** EVT-03: three FIFO lanes, at most one active run; the scheduler never preempts, callers interrupt. */
export class RunScheduler {
  private queues: Record<Lane, RunTask[]> = { user: [], agent: [], background: [] };
  private current: RunTask | null = null;
  private token = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: RunSchedulerOptions) {}

  get active(): RunTask | null {
    return this.current;
  }

  pending(lane: Lane): readonly RunTask[] {
    return this.queues[lane];
  }

  /** A run is in flight right now (queued-but-held runs are not "running"). */
  running(): boolean {
    return this.current !== null;
  }

  /** Maintenance ended: start whatever was held. */
  resume(): void {
    this.kick();
  }

  isIdle(): boolean {
    return !this.current && this.queues.user.length + this.queues.agent.length + this.queues.background.length === 0;
  }

  enqueue(task: RunTask, opts: { head?: boolean } = {}): void {
    if (opts.head) this.queues[task.lane].unshift(task);
    else this.queues[task.lane].push(task);
    if (this.current && task.lane === "user") this.armWatchdog();
    this.kick();
  }

  drop(pred: (t: RunTask) => boolean): void {
    for (const lane of ["user", "agent", "background"] as const) this.queues[lane] = this.queues[lane].filter((t) => !pred(t));
  }

  private next(): RunTask | undefined {
    const u = this.queues.user;
    const i = u.findIndex((t) => !t.groupMember);
    if (i >= 0) return u.splice(i, 1)[0];
    return u.shift() ?? this.queues.agent.shift() ?? this.queues.background.shift();
  }

  private kick(): void {
    if (this.current) return;
    if (this.o.hold?.()) return;
    const t = this.next();
    if (!t) {
      this.disarm();
      this.o.onIdle?.();
      return;
    }
    this.current = t;
    const token = ++this.token;
    void t
      .run()
      .catch((e) => log.error("run task failed", { id: t.id, error: String(e) }))
      .finally(() => {
        if (this.token !== token) return; // a zombie that escaped the watchdog settled late (EVT-06)
        this.current = null;
        this.disarm();
        queueMicrotask(() => this.kick());
      });
    if (this.queues.user.length) this.armWatchdog();
  }

  private armWatchdog(): void {
    if (this.watchdog || !this.current) return;
    const task = this.current;
    this.watchdog = setTimeout(() => {
      this.o.onWatchdogInterrupt(task);
      this.grace = setTimeout(() => {
        if (this.current !== task) return;
        this.o.onEscape(task);
        this.token++;
        this.current = null;
        this.disarm();
        this.kick();
      }, this.o.graceMs ?? LIMITS.runWatchdogGraceMs);
    }, this.o.watchdogMs ?? LIMITS.runWatchdogMs);
  }

  private disarm(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.grace) clearTimeout(this.grace);
    this.watchdog = null;
    this.grace = null;
  }
}
