import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface AckObligation { botId: string; createdAtMs: number; lastSendAtMs: number; lastInterruptAtMs?: number; coalescedCount: number; redriveAttempts: number }
interface File { version: 1; pending: AckObligation[] }

/** OUT-08: one durable obligation per Bot, cleared only by a SendMessage from a turn holding the live ack token. */
export class AckLedger {
  private pendingMap = new Map<string, AckObligation>();

  constructor(private file: string, private now: () => number = Date.now) {
    for (const o of readJson<File>(file, { version: 1, pending: [] }).pending) this.pendingMap.set(o.botId, o);
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, pending: [...this.pendingMap.values()] } satisfies File, 0o600);
  }

  record(botId: string): AckObligation {
    const cur = this.pendingMap.get(botId);
    const next: AckObligation = cur
      ? { ...cur, coalescedCount: cur.coalescedCount + 1, redriveAttempts: 0 }
      : { botId, createdAtMs: this.now(), lastSendAtMs: 0, coalescedCount: 0, redriveAttempts: 0 };
    this.pendingMap.set(botId, next);
    this.save();
    return next;
  }

  get(botId: string): AckObligation | null {
    return this.pendingMap.get(botId) ?? null;
  }

  token(botId: string): string | null {
    const o = this.pendingMap.get(botId);
    return o ? String(o.createdAtMs) : null;
  }

  clear(botId: string, token: string): boolean {
    if (this.token(botId) !== token) return false;
    this.pendingMap.delete(botId);
    this.save();
    return true;
  }

  noteRedrive(botId: string): number {
    const o = this.pendingMap.get(botId);
    if (!o) return 0;
    o.redriveAttempts += 1;
    this.save();
    return o.redriveAttempts;
  }

  drop(botId: string): void {
    if (this.pendingMap.delete(botId)) this.save();
  }

  pending(): AckObligation[] {
    return [...this.pendingMap.values()];
  }
}
