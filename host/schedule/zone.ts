import type { LocalTime } from "./types";

const fmts = new Map<string, Intl.DateTimeFormat>();
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmts.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in an IANA zone. */
export function localParts(ms: number, tz: string): LocalTime {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(ms)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), dow: WD[p.weekday as string] as number };
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** The "(Zone)" label RTN-05 appends when a schedule pins a zone. */
export function zoneLabel(tz: string): string {
  return tz;
}

const key = (t: Omit<LocalTime, "dow">) => ((t.y * 100 + t.mo) * 100 + t.d) * 10_000 + t.h * 100 + t.mi;
const offsetAt = (ms: number, tz: string) => {
  const l = localParts(ms, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi) - Math.floor(ms / 60_000) * 60_000;
};

/**
 * The instant of a wall-clock time (ORIG-03 §03.5):
 * - a time that occurs twice (fall-back) → the first occurrence;
 * - a time that doesn't exist (spring-forward gap) → the first valid minute after the gap (02:30 → 03:00).
 */
export function instantOf(t: Omit<LocalTime, "dow">, tz: string): number {
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
  const want = key(t);
  const cands = [guess - offsetAt(guess - 86_400_000, tz), guess - offsetAt(guess + 86_400_000, tz), guess - offsetAt(guess, tz)];
  const hits = cands.filter((c) => key(localParts(c, tz)) === want);
  if (hits.length) return Math.min(...hits);
  // Gap: walk forward minute by minute from before the transition to the first local time at or after the wanted one.
  let c = Math.min(...cands) - 3 * 3_600_000;
  for (let i = 0; i < 12 * 60; i++, c += 60_000) if (key(localParts(c, tz)) >= want) return c;
  return Math.min(...cands);
}
