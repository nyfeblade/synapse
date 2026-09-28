import fs from "node:fs";
import { STRO } from "@synapse/shared";

/**
 * bug-log 128: the Mac's disk once filled to 0 bytes free. Synapse checks the free space on launch and
 * every 10 minutes: under 15 GB the window shows a quiet banner (MacDiskBanner), under 5 GB a
 * notification goes out too, once per episode. The box's own free space (from the host's /health)
 * rides along for Settings → Diagnostics. A GB is Finder's (10^9 bytes), so the numbers match it.
 */
export const MAC_DISK_CHECK_MS = 10 * 60_000;
export const MAC_DISK_LOW_BYTES = 15e9;
export const MAC_DISK_CRITICAL_BYTES = 5e9;

export type MacDiskLevel = "ok" | "low" | "critical";
export interface MacDiskView { level: MacDiskLevel; freeBytes: number | null; totalBytes: number | null; boxFreeBytes: number | null; checkedAt: number }

export function macDiskLevel(free: number): MacDiskLevel {
  if (free < MAC_DISK_CRITICAL_BYTES) return "critical";
  if (free < MAC_DISK_LOW_BYTES) return "low";
  return "ok";
}

export interface MacDiskDeps {
  /** A path on the volume to watch (the user's home: where Synapse's data and backups live). */
  path: string;
  now(): number;
  statfs?(p: string): { free: number; total: number };
  notify(title: string, body: string): void;
  emit(view: MacDiskView): void;
  /** The box's free space from the host's /health, or null (not connected, older host). */
  boxFree(): Promise<number | null>;
  setInterval?(fn: () => void, ms: number): { unref?(): void };
}

export class MacDiskWatch {
  private last: MacDiskView = { level: "ok", freeBytes: null, totalBytes: null, boxFreeBytes: null, checkedAt: 0 };
  private notified = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private d: MacDiskDeps) {}

  private stat(): { free: number; total: number } {
    if (this.d.statfs) return this.d.statfs(this.d.path);
    const s = fs.statfsSync(this.d.path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }

  view(): MacDiskView { return this.last; }

  async check(): Promise<MacDiskView> {
    let free: number | null = null;
    let total: number | null = null;
    try { ({ free, total } = this.stat()); } catch { /* unknown: no banner rather than a wrong one */ }
    const boxFreeBytes = await this.d.boxFree().catch(() => null);
    const level = free === null ? "ok" : macDiskLevel(free);
    if (level === "critical" && !this.notified && free !== null) {
      this.notified = true;
      this.d.notify(STRO.macDiskTitle, STRO.macDiskLow(free));
    } else if (level !== "critical") this.notified = false;
    this.last = { level, freeBytes: free, totalBytes: total, boxFreeBytes, checkedAt: this.d.now() };
    this.d.emit(this.last);
    return this.last;
  }

  /** Resolves once the checks started so far have finished (tests). */
  idle(): Promise<unknown> { return this.pending; }

  /** Checks now (launch) and every 10 minutes. */
  start(): void {
    const run = () => { this.pending = this.check().catch(() => undefined); };
    run();
    const t = (this.d.setInterval ?? setInterval)(run, MAC_DISK_CHECK_MS);
    t.unref?.();
  }
}

/** Main-process wiring: `macDisk.status` for the renderer, `mac-disk` events on every check. */
export function registerMacDisk(o: Omit<MacDiskDeps, "now"> & { reg(name: string, fn: () => unknown): void }): MacDiskWatch {
  const w = new MacDiskWatch({ ...o, now: Date.now });
  o.reg("macDisk.status", () => w.view());
  w.start();
  return w;
}
