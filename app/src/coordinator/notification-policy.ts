import { LIMITS, STR, type BotSummary } from "@synapse/shared";

type Kind = "needs-you";
const cap = (s: string) => (s.length > LIMITS.notifyBodyMax ? `${s.slice(0, LIMITS.notifyBodyMax - 1)}…` : s);

/** NTF-01 / BOT-23, decided in the coordinator (Decision 6): needs-you and the dock badge. Only user-facing outcomes
 *  notify; bot-to-bot traffic has no path here. Work finished is work-notifier.ts. */
export class NotificationPolicy {
  private prev = new Map<string, BotSummary>();
  private last = new Map<string, number>();
  private focused = true;
  private based = false;
  private badgeCount = -1;

  constructor(private o: { now(): number; notify(n: { botId: string; title: string; body: string; kind: Kind; approvalId?: string }): void; badge(count: number): void }) {}

  setFocused(f: boolean): void {
    this.focused = f;
  }

  baseline(list: BotSummary[]): void {
    this.prev = new Map(list.map((b) => [b.id, b]));
    this.based = true;
    this.updateBadge();
  }

  update(b: BotSummary): void {
    const p = this.prev.get(b.id);
    this.prev.set(b.id, b);
    if (this.based) {
      const reasonChanged = b.awaiting && (!p?.awaiting || p.awaiting.reason !== b.awaiting.reason || p.awaiting.since !== b.awaiting.since);
      // Smarter approvals: a card's notification carries its id, so it can be answered from the notification.
      const approvalId = b.awaiting?.tabId === "auto-review" ? b.awaiting.approvalId : undefined;
      if (reasonChanged) this.fire(b, "needs-you", STR.needsYou(b.profile.name), b.awaiting!.reason || STR.waitingForInput, approvalId);
      // 4.4: "finished" is the host's work-finished event (owner tasks only, Settings → Work finished), coalesced by
      // the coordinator's WorkNotifier. A turn ending is no longer a notification by itself: heartbeats, other Bots'
      // messages and silent wakes end turns too.
    }
    this.updateBadge();
  }

  remove(id: string): void {
    this.prev.delete(id);
    this.updateBadge();
  }

  private fire(b: BotSummary, kind: Kind, title: string, body: string, approvalId?: string): void {
    if (this.focused || !b.settings.notifyOnAgentUpdates || b.settings.hiddenFromSidebar) return;
    const key = `${b.id}:${kind}`;
    const now = this.o.now();
    if (now - (this.last.get(key) ?? -Infinity) < LIMITS.notifyThrottleMs) return;
    this.last.set(key, now);
    this.o.notify({ botId: b.id, title, body: cap(body), kind, ...(approvalId ? { approvalId } : {}) });
  }

  private updateBadge(): void {
    const n = [...this.prev.values()].filter((b) => b.marker === "unread" || b.marker === "blocked").length;
    if (n !== this.badgeCount) { this.badgeCount = n; this.o.badge(n); }
  }
}
