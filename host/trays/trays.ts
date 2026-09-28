import { randomUUID } from "node:crypto";
import { LIMITS, STR, type Tray, type TrayButton } from "@synapse/shared";
import type { SseHub } from "../gateway/sse-hub";

export class TrayService {
  private trays: Tray[] = [];

  constructor(private hub: SseHub, private now: () => number = Date.now) {}

  add(t: { botId: string | null; title: string; detail?: string; requestId?: string; dedupeKey?: string; retry?: boolean; buttons?: TrayButton[] }): Tray {
    const existing = t.dedupeKey ? this.trays.find((x) => x.dedupeKey === t.dedupeKey) : undefined;
    if (existing) {
      existing.count += 1;
      existing.detail = t.detail ?? existing.detail;
      existing.requestId = t.requestId ?? existing.requestId;
      this.publish();
      return existing;
    }
    const tray: Tray = {
      id: randomUUID(), botId: t.botId, title: t.title, detail: t.detail ?? null, requestId: t.requestId ?? null,
      buttons: (t.buttons ?? (t.retry ? [{ label: STR.retry, action: "retry" }] : [])).slice(0, LIMITS.trayButtonsMax), dedupeKey: t.dedupeKey ?? null, count: 1, createdAt: this.now(),
    };
    this.trays = [...this.trays, tray].slice(-LIMITS.traysMax);
    this.publish();
    return tray;
  }

  get(id: string): Tray | undefined {
    return this.trays.find((t) => t.id === id);
  }

  dismiss(id: string): void {
    this.trays = this.trays.filter((t) => t.id !== id);
    this.publish();
  }

  clearForBot(botId: string): void {
    const before = this.trays.length;
    this.trays = this.trays.filter((t) => t.botId !== botId);
    if (this.trays.length !== before) this.publish();
  }

  clear(botId?: string): void {
    this.trays = botId ? this.trays.filter((t) => t.botId !== botId) : [];
    this.publish();
  }

  list(): Tray[] {
    return [...this.trays];
  }

  private publish(): void {
    this.hub.publish({ channel: "tray", payload: { trays: this.list() } });
  }
}
