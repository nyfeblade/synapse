import { LIMITS5 } from "@synapse/shared";
import type { LadderLike } from "../phase5/types";
import { fillTemplate, loadPrompt } from "../prompts";
import type { SettledTurn, TurnObserver } from "../runner/observers";
import type { HiddenSpec } from "../runner/turn-runner";
import { formatLocal, type FollowupStore } from "./store";

export interface HeartbeatDeps {
  store: FollowupStore; botIds(): string[]; optedIn(botId: string): boolean; tz(): string; now(): number;
  isIdle(botId: string): boolean; ladder(): LadderLike; enqueueHidden(botId: string, spec: HiddenSpec): void;
}

export class Heartbeat implements TurnObserver {
  private lastActivity = new Map<string, number>();
  private sentByDay = new Map<string, number>(); // "<botId>|<local date>" and "*|<local date>"
  /** Fix round 1 finding 2: turn-runner.ts's execute() skips notifySettled entirely on a
   *  lease-acquisition failure or an uncaught error in runTurn (its early returns at the
   *  `!lease` check and the `!result` check), so onSettled below is not guaranteed to ever
   *  fire for a Bot woken here. Each entry is timestamped so tick() can drop it on its own
   *  after LIMITS5.followupPendingTimeoutMs even without onSettled, instead of blocking the
   *  Bot from ever being woken again for the process's lifetime. */
  private pending = new Map<string, { ids: string[]; setAt: number }>();
  private lastUserActive = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: HeartbeatDeps) {}

  noteUserActive(): void { this.lastUserActive = this.d.now(); }

  start(): void {
    this.timer = setInterval(() => this.tick(), LIMITS5.followupHeartbeatMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** ORIG-11 §11.2: wake a Bot only when every gate holds. Returns the Bots woken. */
  tick(): string[] {
    const now = this.d.now();
    const tz = this.d.tz();
    const local = formatLocal(now, tz);
    const hour = Number(local.slice(11, 13));
    const day = local.slice(0, 10);
    if (hour < LIMITS5.followupWindowStartHour || hour >= LIMITS5.followupWindowEndHour) return [];
    if (now - this.lastUserActive > LIMITS5.followupActiveOwnerMs) return [];
    if (!this.d.ladder().allowsBackground("followups")) return [];
    if ((this.sentByDay.get(`*|${day}`) ?? 0) >= LIMITS5.followupPerAccountPerDay) return [];
    const woke: string[] = [];
    for (const botId of this.d.botIds()) {
      const inFlight = this.pending.get(botId);
      if (inFlight && now - inFlight.setAt < LIMITS5.followupPendingTimeoutMs) continue;
      if (inFlight) this.pending.delete(botId); // stale: onSettled never fired (error/no-lease); allow re-wake
      if (!this.d.optedIn(botId)) continue;
      const due = this.d.store.due(botId);
      if (!due.length) continue;
      if (!this.d.isIdle(botId) || now - (this.lastActivity.get(botId) ?? 0) < LIMITS5.followupQuietMs) continue;
      if ((this.sentByDay.get(`${botId}|${day}`) ?? 0) >= LIMITS5.followupPerBotPerDay) continue;
      this.pending.set(botId, { ids: due.map((f) => f.id), setAt: now });
      this.d.enqueueHidden(botId, {
        source: "heartbeat", lane: "background", silenceAllowed: true,
        text: fillTemplate(loadPrompt("wakes/heartbeat.md"), { followups: due.map((f) => `- (id ${f.id}, due ${formatLocal(f.dueAt, tz)}) ${f.what}`).join("\n") }),
      });
      woke.push(botId);
    }
    return woke;
  }

  onSettled(t: SettledTurn): void {
    this.lastActivity.set(t.botId, t.endedAt);
    if (t.source !== "heartbeat") return;
    const ids = this.pending.get(t.botId)?.ids ?? [];
    this.pending.delete(t.botId);
    const stillOpen = this.d.store.open(t.botId).filter((f) => ids.includes(f.id)).map((f) => f.id);
    if (stillOpen.length) this.d.store.attempt(t.botId, stillOpen);
    if (t.sentTexts.length) {
      const day = formatLocal(t.endedAt, this.d.tz()).slice(0, 10);
      for (const k of [`${t.botId}|${day}`, `*|${day}`]) this.sentByDay.set(k, (this.sentByDay.get(k) ?? 0) + 1);
    }
  }
}
