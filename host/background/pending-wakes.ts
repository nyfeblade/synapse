import { LIMITSC } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export type PendingKind = "subagent" | "shell";
export interface PendingWake { kind: PendingKind; botId: string; taskId: string; createdAt: number; quietOrigin?: { routineId: string; routineName: string } }
interface FileShape { version: 1; pending: PendingWake[] }

/** EVT-16: durable markers for background work that owes its Bot a revival. */
export class PendingWakes {
  private items: PendingWake[];

  constructor(private file: string, private now: () => number = Date.now) {
    this.items = readJson<FileShape>(file, { version: 1, pending: [] }).pending;
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, pending: this.items } satisfies FileShape);
  }

  list(): PendingWake[] { return [...this.items]; }
  forBot(botId: string): PendingWake[] { return this.items.filter((w) => w.botId === botId); }
  has(taskId: string): boolean { return this.items.some((w) => w.taskId === taskId); }

  add(w: Omit<PendingWake, "createdAt">): void {
    if (this.has(w.taskId)) return;
    this.items.push({ ...w, createdAt: this.now() });
    this.save();
  }

  remove(taskId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((w) => w.taskId !== taskId);
    if (this.items.length !== before) this.save();
  }

  dropBot(botId: string): void {
    this.items = this.items.filter((w) => w.botId !== botId);
    this.save();
  }

  prune(maxAgeMs: number = LIMITSC.pendingWakeMaxAgeMs): PendingWake[] {
    const cut = this.now() - maxAgeMs;
    const old = this.items.filter((w) => w.createdAt < cut);
    if (old.length) {
      this.items = this.items.filter((w) => w.createdAt >= cut);
      this.save();
    }
    return old;
  }
}
