import { HEALTH_LIMITS, STR_HEALTH } from "@synapse/shared";

export interface WorkFinishedEvent { botId: string; name: string; summary: string; telegram: boolean }
export interface WorkNotice { botId: string; title: string; body: string; kind: "finished"; telegram: string | null }

/**
 * 4.4: the work-finished notification, decided here like every other macOS notification (Decision 6). The host has
 * already applied Settings → Work finished and skipped heartbeats and silent wakes; this adds the focus rule (never
 * for the chat the owner is looking at) and turns a burst into one notification, at most one every 10 seconds.
 */
export class WorkNotifier {
  private pending: WorkFinishedEvent[] = [];
  private timer: unknown = null;
  private lastSent = -Infinity;
  private focused = true;
  private activeBot: string | null = null;

  constructor(private o: { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void; notify(n: WorkNotice): void }) {}

  setFocused(f: boolean): void { this.focused = f; }
  setActiveBot(id: string | null): void { this.activeBot = id; }
  /** A deleted Bot. */
  remove(id: string): void {
    this.pending = this.pending.filter((p) => p.botId !== id);
    if (this.activeBot === id) this.activeBot = null;
  }

  private watching(botId: string): boolean { return this.focused && this.activeBot === botId; }

  onFinished(e: WorkFinishedEvent): void {
    if (this.watching(e.botId)) return;
    this.pending = [...this.pending.filter((p) => p.botId !== e.botId), e];
    if (this.timer !== null) return;
    const wait = Math.max(HEALTH_LIMITS.workCoalesceMs, this.lastSent + HEALTH_LIMITS.workMinGapMs - this.o.now());
    this.timer = this.o.setTimer(() => { this.timer = null; this.flush(); }, wait);
  }

  private flush(): void {
    // The owner may have opened the chat in the meantime.
    const list = this.pending.splice(0).filter((p) => !this.watching(p.botId));
    if (!list.length) return;
    this.lastSent = this.o.now();
    const tg = list.filter((p) => p.telegram).map((p) => STR_HEALTH.workFinished(p.name, p.summary));
    const telegram = tg.length ? tg.join("\n") : null;
    if (list.length === 1) {
      const p = list[0]!;
      this.o.notify({ botId: p.botId, title: STR_HEALTH.workFinishedTitle(p.name), body: p.summary, kind: "finished", telegram });
      return;
    }
    // A burst: one notification; a click opens the newest.
    this.o.notify({ botId: list.at(-1)!.botId, title: STR_HEALTH.workFinishedMany(list.length), body: list.map((p) => p.name).join(", "), kind: "finished", telegram });
  }
}
