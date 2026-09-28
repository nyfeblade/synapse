import { LIMITS, type SendMessageEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { collectHiddenTurn } from "../runner/prompt-collector";
import type { TurnRunner } from "../runner/turn-runner";

type Platform = "slack" | "github";
const LABEL: Record<Platform, "Slack" | "GitHub"> = { slack: "Slack", github: "GitHub" };

export const listenerConnectedText = (platform: "Slack" | "GitHub", routineName: string) =>
  `[${platform} is connected now, so your routine "${routineName}" can run. First, use SendMessage to tell the user it's connected, then pick up where you left off.]`;

interface Watch { timer: unknown; until: number; entryId: string; routineName: string }

/** RTN-12: a connect card, then a 5 s poll for up to 15 min; on connect, wake #14 (listener-connected). */
export class ListenerConnectWatcher {
  private watches = new Map<string, Watch>();

  constructor(private d: {
    runner: TurnRunner; bots: BotService; acks: { record(botId: string): unknown; token(botId: string): string | null } | null;
    isConnected(botId: string, platform: Platform): boolean; refresh?(): Promise<void>;
    now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void;
  }) {}

  watch(botId: string, platform: Platform, routineName: string, routineId = ""): void {
    const k = `${botId}:${platform}`;
    if (this.watches.has(k) || this.d.isConnected(botId, platform)) return;
    const entryId = this.d.bots.auxEntryIds(botId, 1)[0]!;
    this.d.bots.appendEntry(botId, {
      kind: "send-message", id: entryId, requestId: `listener-${platform}`, createdAt: this.d.now(),
      message: { type: "card", card: { kind: "connect-listener", platform, routineId, routineName, connected: false } },
    });
    this.watches.set(k, { timer: null, until: this.d.now() + LIMITS.listenerWatchMs, entryId, routineName });
    this.arm(k, botId, platform);
  }

  private arm(k: string, botId: string, platform: Platform): void {
    const w = this.watches.get(k);
    if (!w) return;
    w.timer = this.d.setTimer(() => void this.check(k, botId, platform), LIMITS.listenerWatchPollMs);
  }

  private async check(k: string, botId: string, platform: Platform): Promise<void> {
    const w = this.watches.get(k);
    if (!w) return;
    await this.d.refresh?.().catch(() => {});
    if (this.d.isConnected(botId, platform)) {
      this.watches.delete(k);
      this.markCard(botId, w.entryId);
      this.d.acks?.record(botId);
      this.d.runner.enqueueWake(botId, {
        source: "listener-connected", lane: "background", silenceAllowed: false, ackToken: this.d.acks?.token(botId) ?? null,
        prompt: () => collectHiddenTurn(listenerConnectedText(LABEL[platform], w.routineName)),
      });
      return;
    }
    if (this.d.now() >= w.until) {
      this.watches.delete(k);
      return;
    }
    this.arm(k, botId, platform);
  }

  private markCard(botId: string, entryId: string): void {
    const e = this.d.bots.getEntry(botId, entryId) as SendMessageEntry | null;
    if (e?.message.type !== "card" || e.message.card.kind !== "connect-listener") return;
    this.d.bots.updateEntry(botId, { ...e, message: { ...e.message, card: { ...e.message.card, connected: true } } });
  }
}
