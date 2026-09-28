import { LIMITS, STR, type WidgetSpec } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostWidgets } from "../chat/widgets";
import type { TrayService } from "../trays/trays";
import type { RoutineStore } from "./routine-store";

interface GuardState { nudgedAtMs?: number; cardEntryIds: string[]; pausedAutomationIds: string[]; snoozedUntil?: number; optedOut?: boolean }
const KEY = "automationSpendGuardState";
const FIRES = "routineFiresSinceView";
const LABEL: Record<string, string> = {
  keep: STR.spendGuardKeep, pause: STR.spendGuardPauseAll, optout: STR.spendGuardOptOut, resume: STR.resumeRoutines, "keep-paused": STR.keepThemPaused,
};

export interface SpendGuardDeps {
  bots: BotService;
  store: RoutineStore;
  /** The canonical Phase 2 widget service's host poster (controller ruling 1). */
  widgets: Pick<HostWidgets, "hostPost">;
  trays: TrayService;
  now(): number;
  onPauseAll(botId: string): void;
  onResumeAll(botId: string): void;
  wake?(botId: string, text: string): void;
}

/** RTN-20: idle-owner spend guard. */
export class SpendGuard {
  constructor(private d: SpendGuardDeps) {}

  private kv(botId: string) {
    return this.d.bots.require(botId).store;
  }
  private state(botId: string): GuardState {
    return this.kv(botId).getKv<GuardState>(KEY, { cardEntryIds: [], pausedAutomationIds: [] });
  }
  private save(botId: string, s: GuardState): void {
    this.kv(botId).setKv(KEY, s);
  }
  private idle(botId: string): boolean {
    const u = this.kv(botId).getKv<{ lastViewedAt: number }>("unreadState", { lastViewedAt: 0 });
    return this.d.now() - Math.max(u.lastViewedAt, this.kv(botId).getKv<number>("createdAt", 0)) >= LIMITS.spendGuardIdleMs;
  }

  check(botId: string): "ok" | "paused" {
    if (!this.d.bots.has(botId)) return "ok";
    const s = this.state(botId);
    const now = this.d.now();
    if (s.optedOut || (s.snoozedUntil ?? 0) > now || !this.idle(botId)) return "ok";
    if (s.nudgedAtMs !== undefined) {
      if (now - s.nudgedAtMs < LIMITS.spendGuardPauseAfterMs) return "ok";
      this.pauseAll(botId, true);
      return "paused";
    }
    const unread = this.kv(botId).getKv<{ unreadCount: number }>("unreadState", { unreadCount: 0 }).unreadCount;
    if (unread >= LIMITS.spendGuardUnread || this.kv(botId).getKv<number>(FIRES, 0) >= LIMITS.spendGuardFires) this.nudge(botId);
    return "ok";
  }

  noteFire(botId: string): void {
    if (this.d.bots.has(botId)) this.kv(botId).setKv(FIRES, this.kv(botId).getKv<number>(FIRES, 0) + 1);
  }

  onViewed(botId: string): void {
    if (!this.d.bots.has(botId)) return;
    this.kv(botId).setKv(FIRES, 0);
    const s = this.state(botId);
    if (s.nudgedAtMs !== undefined) {
      delete s.nudgedAtMs;
      this.save(botId, s);
    }
  }

  /** Hourly: an unanswered nudge older than 3 days pauses even if no routine fires in between. */
  tick(): void {
    const now = this.d.now();
    for (const botId of this.d.bots.ids()) {
      const s = this.state(botId);
      if (s.nudgedAtMs !== undefined && now - s.nudgedAtMs >= LIMITS.spendGuardPauseAfterMs && this.idle(botId) && !s.optedOut) this.pauseAll(botId, true);
    }
  }

  resumeAll(botId: string): void {
    const s = this.state(botId);
    for (const id of s.pausedAutomationIds) if (this.d.store.get(botId, id)) this.d.store.update(botId, id, { enabled: true });
    this.save(botId, { ...s, pausedAutomationIds: [] });
    for (const t of this.d.trays.list()) if (t.dedupeKey === `${botId}:spend-guard`) this.d.trays.dismiss(t.id);
    this.d.onResumeAll(botId);
  }

  private post(botId: string, spec: WidgetSpec): void {
    const entryId = this.d.widgets.hostPost(botId, spec, (v) => this.answer(botId, v));
    const s = this.state(botId);
    this.save(botId, { ...s, cardEntryIds: [...s.cardEntryIds, entryId].slice(-10) });
  }

  private nudge(botId: string): void {
    this.post(botId, {
      question: STR.spendGuardQuestion, hostKind: "spend-guard",
      options: [
        { label: STR.spendGuardKeep, value: "keep", style: "primary" },
        { label: STR.spendGuardPauseAll, value: "pause" },
        { label: STR.spendGuardOptOut, value: "optout" },
      ],
    });
    this.save(botId, { ...this.state(botId), nudgedAtMs: this.d.now() });
  }

  private pauseAll(botId: string, away: boolean): void {
    const ids = this.d.store.list(botId).filter((r) => r.def.enabled).map((r) => r.id);
    for (const id of ids) this.d.store.update(botId, id, { enabled: false });
    const s = this.state(botId);
    delete s.nudgedAtMs;
    this.save(botId, { ...s, pausedAutomationIds: [...new Set([...s.pausedAutomationIds, ...ids])] });
    if (away) {
      this.post(botId, {
        question: STR.spendGuardPausedPost, hostKind: "spend-guard-paused",
        options: [{ label: STR.resumeRoutines, value: "resume", style: "primary" }, { label: STR.keepThemPaused, value: "keep-paused" }],
      });
      this.d.trays.add({ botId, title: STR.trayRoutinesPausedAway, dedupeKey: `${botId}:spend-guard`, buttons: [{ label: STR.resumeRoutines, action: "resume-routines" }] });
    }
    this.d.onPauseAll(botId);
  }

  /** Public so the wiring can register it as the persistent `spend-guard` host kind (answers after a restart). */
  answer(botId: string, value: string): void {
    if (!this.d.bots.has(botId)) return;
    const s = this.state(botId);
    delete s.nudgedAtMs;
    if (value === "keep") s.snoozedUntil = this.d.now() + LIMITS.spendGuardSnoozeMs;
    if (value === "optout") s.optedOut = true;
    this.save(botId, s);
    if (value === "pause") this.pauseAll(botId, false);
    if (value === "resume") this.resumeAll(botId);
    const label = LABEL[value] ?? value;
    // EVT-02 wake #21: tell the Bot what the app already did.
    this.d.wake?.(botId, `<system_reminder>The user answered your question about routines. They chose to "${label}", and the app has ALREADY applied that. Acknowledge in one short line.</system_reminder>`);
  }
}
