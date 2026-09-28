import { LIMITS, STR } from "@synapse/shared";
import { occurrencesAfter } from "./schedule";
import { ScheduleError, type CronSpec, type ParsedSchedule } from "./types";

const fail = (): never => {
  throw new ScheduleError(STR.scheduleSpacing);
};

/** ORIG-03 §03.6 step 1: minute fields that put two runs < 5 min apart within an hour, or across the hour wrap. */
function staticCronTooClose(c: CronSpec): boolean {
  const m = c.minutes;
  for (let i = 1; i < m.length; i++) if ((m[i] as number) - (m[i - 1] as number) < 5) return true;
  const adjacentHours = c.hours.some((h) => c.hours.includes((h + 1) % 24));
  return adjacentHours && m.length > 1 && 60 - (m[m.length - 1] as number) + (m[0] as number) < 5;
}

function checkStream(times: Iterable<number>): void {
  let prev: number | null = null;
  let n = 0;
  for (const t of times) {
    if (prev !== null && t - prev < LIMITS.minScheduleSpacingMs) fail();
    prev = t;
    if (++n >= LIMITS.spacingCheckMaxOccurrences) return;
  }
}

/** RTN-06 / ORIG-03 §03.6: every pair of consecutive runs ≥ 300 s apart in UTC instants (catches DST-made pairs). */
export function checkSpacing(p: ParsedSchedule, tz: string, fromMs: number): void {
  if (p.kind === "every") {
    if (p.everyMs < LIMITS.minScheduleSpacingMs) fail();
    return;
  }
  if (p.kind === "cron" && staticCronTooClose(p.cron)) fail();
  checkStream(occurrencesAfter(p, fromMs, tz));
}

/** §03.6 step 3: a group of listeners checks the merged stream of its schedule members (equal instants fire once). */
export function checkGroupSpacing(ps: ParsedSchedule[], tz: string, fromMs: number): void {
  for (const p of ps) checkSpacing(p, tz, fromMs);
  const merged = new Set<number>();
  for (const p of ps) {
    let n = 0;
    for (const t of occurrencesAfter(p, fromMs, tz)) {
      merged.add(t);
      if (++n >= LIMITS.spacingCheckMaxOccurrences) break;
    }
  }
  checkStream([...merged].sort((a, b) => a - b));
}
