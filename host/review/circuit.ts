import { LIMITS } from "@synapse/shared";

/** ORIG-01 §01.10: 3 errors in 5 min → degraded for ≥10 min; probe every 2 min; success → healthy. */
export class CircuitBreaker {
  lastError: string | null = null;
  private errors: number[] = [];
  private mode: "healthy" | "degraded" = "healthy";
  private degradedAt = 0;
  private degradedUntil = 0;
  private lastProbeAt = 0;

  constructor(private now: () => number = Date.now) {}

  get state(): "healthy" | "degraded" | "probing" {
    return this.mode;
  }

  recordError(message = "error"): void {
    this.lastError = message;
    const t = this.now();
    if (this.mode === "degraded") {
      this.lastProbeAt = t;
      return;
    }
    this.errors = [...this.errors.filter((x) => t - x < LIMITS.circuitWindowMs), t];
    if (this.errors.length >= LIMITS.circuitErrors) this.enterDegraded();
  }

  recordSuccess(): void {
    this.mode = "healthy";
    this.errors = [];
  }

  enterDegraded(untilMs?: number): void {
    const t = this.now();
    this.mode = "degraded";
    this.degradedAt = t;
    this.degradedUntil = untilMs ?? t + LIMITS.degradedMinMs;
    this.lastProbeAt = t;
  }

  shouldProbe(): boolean {
    const t = this.now();
    if (this.mode !== "degraded" || t < this.degradedUntil) return false;
    return t - this.lastProbeAt >= LIMITS.probeEveryMs || this.lastProbeAt <= this.degradedAt;
  }
}
