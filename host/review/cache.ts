import { LIMITS } from "@synapse/shared";
import { createHash } from "node:crypto";
import type { ReviewOutcome } from "./types";

interface Entry { outcome: ReviewOutcome; at: number; tier: number; epoch: number }

/** ORIG-01 §01.8: 60 s for any verdict; tier ≤ 1 allows live until the next user message (max 30 min); LRU 512; errors never cached. */
export class VerdictCache {
  private m = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  key(parts: (string | number)[]): string {
    return createHash("sha256").update(parts.join("␟")).digest("hex");
  }

  get(key: string, userMessageEpoch: number): ReviewOutcome | null {
    const e = this.m.get(key);
    if (!e) return null;
    const age = this.now() - e.at;
    const lowTierAllow = e.outcome.kind === "allow" && e.tier <= 1;
    const valid = age <= LIMITS.verdictCacheTtlMs || (lowTierAllow && e.epoch === userMessageEpoch && age <= LIMITS.verdictCacheLowTierMaxMs);
    if (!valid) {
      this.m.delete(key);
      return null;
    }
    this.m.delete(key);
    this.m.set(key, e);
    return e.outcome;
  }

  set(key: string, outcome: ReviewOutcome, tier: number, userMessageEpoch: number): void {
    if (outcome.kind === "error" || outcome.kind === "degraded") return;
    this.m.delete(key);
    this.m.set(key, { outcome, at: this.now(), tier, epoch: userMessageEpoch });
    while (this.m.size > LIMITS.verdictCacheSize) this.m.delete(this.m.keys().next().value as string);
  }

  clear(): void {
    this.m.clear();
  }
}
