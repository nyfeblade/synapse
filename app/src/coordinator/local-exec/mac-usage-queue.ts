import fs from "node:fs";
import path from "node:path";
import type { MacUsageReport } from "./mac-key-proxy";

interface Item { report: MacUsageReport; attempts: number }
interface OnDisk { v: 1; items: Item[] }

/** Waits between retries: 2 s, 4 s, 8 s … capped at 10 minutes. */
const backoff = (attempts: number) => Math.min(10 * 60_000, 1000 * 2 ** Math.max(1, attempts));
/** Enough for a long offline stretch of Mac runs; past it the oldest reports go (and say so). */
const MAX_ITEMS = 500;

/**
 * Re-review fix E: the Mac key proxy's usage reports (recordMacUsage) are not dropped when the host can't take them.
 * A failed report waits in a small bounded queue, persisted in the app's data folder (0600; numbers and a Bot id only,
 * never a key), and is retried with backoff, also after a restart. A report is removed only once the host took it.
 */
export class MacUsageQueue {
  private items: Item[];
  private timer = false;
  private flushing: Promise<void> | null = null;

  constructor(private o: {
    file: string;
    send(r: MacUsageReport): Promise<unknown>;
    /** setTimeout by default (unref'd); tests drive it by hand. */
    schedule?(fn: () => Promise<void>, ms: number): void;
    max?: number;
    log?(s: string): void;
  }) {
    this.items = this.load();
    if (this.items.length) this.later(backoff(1));
  }

  /** Send now; on failure keep it for a retry. */
  async report(r: MacUsageReport): Promise<void> {
    if (!this.items.length) {
      try { await this.o.send(r); return; } catch { /* queued below */ }
    }
    this.items.push({ report: r, attempts: 1 });
    const max = this.o.max ?? MAX_ITEMS;
    if (this.items.length > max) {
      const dropped = this.items.splice(0, this.items.length - max);
      this.o.log?.(`local-exec: ${dropped.length} claude usage report(s) on this Mac were dropped (the queue is full)`);
    }
    this.save();
    this.later(backoff(1));
  }

  /** Sends what is waiting, oldest first; stops at the first failure and waits longer. */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        while (this.items.length) {
          const it = this.items[0]!;
          try {
            await this.o.send(it.report);
          } catch {
            it.attempts++;
            this.save();
            this.later(backoff(it.attempts));
            return;
          }
          this.items.shift();
          this.save();
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private later(ms: number): void {
    if (this.timer) return;
    this.timer = true;
    const run = async () => { this.timer = false; await this.flush(); };
    if (this.o.schedule) this.o.schedule(run, ms);
    else setTimeout(() => void run(), ms).unref?.();
  }

  private load(): Item[] {
    try {
      const d = JSON.parse(fs.readFileSync(this.o.file, "utf8")) as Partial<OnDisk>;
      return Array.isArray(d.items) ? d.items.filter((x) => x && typeof x.report?.botId === "string" && x.report.usage) : [];
    } catch { return []; }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items } satisfies OnDisk), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.o.file);
    } catch (e) {
      this.o.log?.(`local-exec: the claude usage queue couldn't be saved (${(e as Error).message})`);
    }
  }
}
