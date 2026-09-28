import { tzOffsetMs } from "./week";

const HOUR = 3_600_000;

/** Local midnight (in `tz`) of the day holding `ms`. */
export function dayStartMs(ms: number, tz: string): number {
  const off = tzOffsetMs(ms, tz);
  const l = new Date(ms + off);
  const midnightAsUtc = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  return midnightAsUtc - tzOffsetMs(midnightAsUtc - off, tz);
}

/** Local 00:00 on the 1st of the month holding `ms`. */
export function monthStartMs(ms: number, tz: string): number {
  const off = tzOffsetMs(ms, tz);
  const l = new Date(ms + off);
  const firstAsUtc = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1);
  return firstAsUtc - tzOffsetMs(firstAsUtc - off, tz);
}

/** The next local midnight after the day holding `ms` (23, 24 or 25 hours later across DST). */
export function nextDayStartMs(ms: number, tz: string): number {
  return dayStartMs(dayStartMs(ms, tz) + 36 * HOUR, tz);
}

export function nextMonthStartMs(ms: number, tz: string): number {
  return monthStartMs(monthStartMs(ms, tz) + 40 * 24 * HOUR, tz);
}

export function periodStartMs(period: "day" | "month", ms: number, tz: string): number {
  return period === "day" ? dayStartMs(ms, tz) : monthStartMs(ms, tz);
}

export function periodEndMs(period: "day" | "month", ms: number, tz: string): number {
  return period === "day" ? nextDayStartMs(ms, tz) : nextMonthStartMs(ms, tz);
}

/** Local day starts from the day holding `from` up to (not including) `to`. */
export function dayStarts(from: number, to: number, tz: string): number[] {
  const out: number[] = [];
  for (let d = dayStartMs(from, tz); d < to; d = nextDayStartMs(d, tz)) out.push(d);
  return out;
}
