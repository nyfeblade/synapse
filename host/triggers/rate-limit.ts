/** Token bucket: `burst` capacity, refilled at `perMin` per minute (ORIG-04 §04.2). */
export class TokenBucket {
  private b = new Map<string, { tokens: number; at: number }>();

  constructor(private perMin: number, private burst: number, private now: () => number = Date.now) {}

  take(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const perMs = this.perMin / 60_000;
    const s = this.b.get(key) ?? { tokens: this.burst, at: t };
    s.tokens = Math.min(this.burst, s.tokens + (t - s.at) * perMs);
    s.at = t;
    this.b.set(key, s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - s.tokens) / perMs / 1000)) };
  }
}
