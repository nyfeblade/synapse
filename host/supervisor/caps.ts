import os from "node:os";
import { LIMITS } from "@synapse/shared";

/** `maxWarm`: most idle (warm_idle, unleased) processes kept; the least recently used beyond it cool. Absent = no cap beyond maxLive. */
export interface Caps { maxLive: number; maxRunning: number; warmIdleMs: number; userPreemptAfterMs: number; maxWarm?: number }

/** ORIG-16 §16.4: maxLive = clamp(floor(0.6 × (RAM − 1.5 GB) / rssP95), 2, 3 × vCPU); maxRunning = vCPU + 2. */
export function deriveCaps(ramBytes: number, vcpu: number, rssP95Bytes: number = LIMITS.rssP95InitialBytes): { maxLive: number; maxRunning: number } {
  const raw = Math.floor((0.6 * (ramBytes - 1.5 * 1024 ** 3)) / rssP95Bytes);
  return { maxLive: Math.min(Math.max(raw, 2), 3 * vcpu), maxRunning: vcpu + 2 };
}

/**
 * TTFT war room: warm sessions save ~1 s of CLI start-up per turn, but every idle warm CLI holds ~300–400 MB, and the
 * box VM's memory comes out of the Mac's (voice needs headroom). The idle pool gets ~10% of RAM past the host's
 * 1.5 GB, at the p95 per-process figure, clamped to 1…LIMITS.maxWarmIdle (3 on the 16 GB box).
 */
export function deriveMaxWarm(ramBytes: number, rssP95Bytes: number = LIMITS.rssP95InitialBytes): number {
  return Math.min(Math.max(Math.floor((0.1 * (ramBytes - 1.5 * 1024 ** 3)) / rssP95Bytes), 1), LIMITS.maxWarmIdle);
}

export function defaultCaps(): Caps {
  return { ...deriveCaps(os.totalmem(), os.availableParallelism()), warmIdleMs: LIMITS.warmIdleMs, userPreemptAfterMs: LIMITS.userPreemptAfterMs, maxWarm: deriveMaxWarm(os.totalmem()) };
}
