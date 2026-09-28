const DAY = 86_400_000;

export function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}

/** USE-05/USE-06: the current weekly period — aligned to the weekly reset when known, else Monday 00:00 local. */
export function weekStartMs(nowMs: number, tz: string, weeklyResetAt: number | null): number {
  if (weeklyResetAt && weeklyResetAt > nowMs) return weeklyResetAt - 7 * DAY;
  const off = tzOffsetMs(nowMs, tz);
  const local = new Date(nowMs + off);
  const dow = (local.getUTCDay() + 6) % 7;
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
  return midnightLocalAsUtc - tzOffsetMs(midnightLocalAsUtc - off, tz);
}

/** rate_limit_event reports utilization 0–1 and resetsAt in seconds (phase0-findings #4); accept either unit. */
export function normalizeWindow(w: { utilization: number | null; resetsAt: number | null }): { pct: number | null; resetsAt: number | null } {
  const pct = w.utilization === null ? null : Math.round((w.utilization <= 1 ? w.utilization * 100 : w.utilization) * 10) / 10;
  const resetsAt = w.resetsAt === null ? null : w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt;
  return { pct, resetsAt };
}
