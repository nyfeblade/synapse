/** The message is always the user-facing text (RTN-06 / ORIG-03 copy from STR). */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** A wall-clock time in some zone. mo is 1–12, dow is 0–6 (Sunday = 0). */
export interface LocalTime { y: number; mo: number; d: number; h: number; mi: number; dow: number }

/** Sorted, de-duplicated field values. domStar/dowStar drive the Vixie OR rule (RTN-05). */
export interface CronSpec { minutes: number[]; hours: number[]; doms: number[]; months: number[]; dows: number[]; domStar: boolean; dowStar: boolean }

/** ORIG-03 §03.4 subset. byDay.n = 0 means "every such weekday"; ±1…5 is an ordinal. */
export interface RRuleSpec {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: { n: number; dow: number }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  byHour: number[];
  byMinute: number[];
  count: number | null;
  until: number | null;
  dtstart: LocalTime;
}

export type ParsedSchedule =
  | { kind: "cron"; cron: CronSpec; tz: string | null; expr: string }
  | { kind: "every"; everyMs: number; expr: string }
  | { kind: "rrule"; rule: RRuleSpec; tz: string | null; expr: string }
  /** A one-shot run ("in 2 hours", "once tomorrow at 9am"): stored as `@once <ISO UTC>`. */
  | { kind: "once"; atMs: number; expr: string };
