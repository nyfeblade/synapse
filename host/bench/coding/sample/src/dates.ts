/** Calendar dates as "YYYY-MM-DD" strings, always UTC. No times of day anywhere in this library. */
export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateError";
  }
}

/** Parses "YYYY-MM-DD" to UTC midnight in ms. Rejects impossible dates like 2025-02-30. */
export function parseDate(text: ISODate): number {
  const m = ISO_RE.exec(text);
  if (!m) throw new DateError(`not an ISO date: "${text}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new DateError(`no such date: "${text}"`);
  }
  return ms;
}

export function isValidDate(text: string): boolean {
  try {
    parseDate(text);
    return true;
  } catch {
    return false;
  }
}

export function formatDate(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) throw new DateError(`days must be an integer, got ${days}`);
  return formatDate(parseDate(date) + days * DAY_MS);
}

/**
 * Whole days from `a` to `b` (b minus a). The same day is 0; the next day is 1; a `b` before `a`
 * is negative.
 */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS) + 1;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return parseDate(a) - parseDate(b);
}

export function isWeekend(date: ISODate): boolean {
  const dow = new Date(parseDate(date)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Adds `n` business days (Mon-Fri). Starting on a weekend counts from the next Monday. */
export function addBusinessDays(date: ISODate, n: number): ISODate {
  if (!Number.isInteger(n) || n < 0) throw new DateError(`n must be a non-negative integer, got ${n}`);
  let d = date;
  while (isWeekend(d)) d = addDays(d, 1);
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left--;
  }
  return d;
}

export function endOfMonth(date: ISODate): ISODate {
  const ms = parseDate(date);
  const dt = new Date(ms);
  return formatDate(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0));
}

export function maxDate(...dates: ISODate[]): ISODate {
  if (dates.length === 0) throw new DateError("maxDate needs at least one date");
  return dates.reduce((a, b) => (compareDates(a, b) >= 0 ? a : b));
}
