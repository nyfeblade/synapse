/**
 * Supervises the coordinator utility process — the only path between the renderer and the host
 * (GatewayClient, SSE, the VNC proxy, every renderer command). Node kills a utility process on an
 * unhandled rejection, and without this the app went mute for the rest of its life: every command
 * answered NOT_CONNECTED, the connection state froze, and "Try again" posted into a dead process.
 */
export interface CoordinatorProcess {
  on(event: "message", cb: (m: never) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  on(event: "error", cb: (e: unknown) => void): void;
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): void;
}

export interface CoordinatorHostDeps {
  fork(): CoordinatorProcess;
  /** Coordinator → main messages (notifications, badge). */
  onMessage(m: { type: string; botId?: string; title?: string; body?: string; count?: number; id?: number; req?: unknown; nonce?: string }): void;
  /** A fresh process is up: re-wire the renderer MessagePort into it. Called before the replay. */
  onRespawn(): void;
  /** Called once per death, with the number of restarts so far. */
  onDeath?(attempt: number): void;
  setTimer?(fn: () => void, ms: number): unknown;
  now?(): number;
  backoffMs?: number[];
}

const BACKOFF_MS = [500, 1000, 2000, 5000, 15_000];
/** A process that lived this long counts as healthy, so the next death starts the backoff over. */
const HEALTHY_MS = 60_000;

export class CoordinatorHost {
  private proc: CoordinatorProcess;
  private stopped = false;
  private attempt = 0;
  private startedAt: number;
  /** The last `connect` payload, replayed into a fresh process so it reconnects to the host by itself. */
  private lastConnect: unknown = null;
  private dying = false;

  constructor(private d: CoordinatorHostDeps) {
    this.startedAt = this.now();
    this.proc = this.spawn();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private spawn(): CoordinatorProcess {
    const p = this.d.fork();
    this.dying = false;
    p.on("message", (m) => this.d.onMessage(m));
    // Both fire for one death on some paths, so `dying` keeps it to a single restart.
    p.on("exit", () => this.died());
    p.on("error", () => this.died());
    return p;
  }

  private died(): void {
    if (this.stopped || this.dying) return;
    this.dying = true;
    if (this.now() - this.startedAt >= HEALTHY_MS) this.attempt = 0;
    const backoff = this.d.backoffMs ?? BACKOFF_MS;
    const wait = backoff[Math.min(this.attempt, backoff.length - 1)]!;
    this.attempt += 1;
    this.d.onDeath?.(this.attempt);
    const timer = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    timer(() => this.restart(), wait);
  }

  private restart(): void {
    if (this.stopped) return;
    this.startedAt = this.now();
    this.proc = this.spawn();
    this.d.onRespawn();
    if (this.lastConnect) this.proc.postMessage(this.lastConnect);
  }

  postMessage(message: unknown, transfer?: unknown[]): void {
    if ((message as { type?: string } | null)?.type === "connect") this.lastConnect = message;
    this.proc.postMessage(message, transfer);
  }

  kill(): void {
    this.stopped = true;
    this.proc.kill();
  }
}
