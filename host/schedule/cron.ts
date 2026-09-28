import { STR } from "@synapse/shared";
import { ScheduleError, type CronSpec, type LocalTime } from "./types";

/** RTN-05 aliases. */
export const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW3 = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const bad = () => new ScheduleError(STR.scheduleInvalid);

function value(s: string | undefined, names: string[] | null, nameBase: number): number {
  if (s === undefined || s === "") throw bad();
  if (/^\d+$/.test(s)) return Number(s);
  const i = names ? names.indexOf(s.toLowerCase()) : -1;
  if (i < 0) throw bad();
  return i + nameBase;
}

function parseField(field: string, min: number, max: number, names: string[] | null = null, nameBase = 0): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2 || part === "") throw bad();
    const [range, stepText] = pieces as [string, string | undefined];
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw bad();
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw bad();
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const ends = range.split("-");
      if (ends.length > 2) throw bad();
      lo = value(ends[0], names, nameBase);
      hi = ends.length === 2 ? value(ends[1], names, nameBase) : stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw bad();
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** 5-field cron: lists, ranges, steps, 3-letter names; DOW 7 = 0 (RTN-05). Throws ScheduleError("Enter a valid schedule"). */
export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw bad();
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const dows = [...new Set(parseField(dow, 0, 7, DOW3, 0).map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);
  return {
    minutes: parseField(mi, 0, 59),
    hours: parseField(h, 0, 23),
    doms: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MON3, 1),
    dows,
    domStar: dom.startsWith("*"),
    dowStar: dow.startsWith("*"),
  };
}

/** Vixie semantics: if both day fields are restricted, a day matches when EITHER matches. */
export function cronMatches(c: CronSpec, t: LocalTime): boolean {
  if (!c.minutes.includes(t.mi) || !c.hours.includes(t.h) || !c.months.includes(t.mo)) return false;
  const domOk = c.doms.includes(t.d);
  const dowOk = c.dows.includes(t.dow);
  return c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
}

/** "8:00 AM", "12:00 PM", "12:30 AM". */
export function formatTime(h: number, mi: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
function uniformStep(xs: number[], minLen = 3): number | null {
  if (xs.length < minLen) return null;
  const s = (xs[1] as number) - (xs[0] as number);
  for (let i = 2; i < xs.length; i++) if ((xs[i] as number) - (xs[i - 1] as number) !== s) return null;
  return s;
}

/** RTN-05 describer prose; "Custom schedule" when no plain phrasing fits (the raw expression is in the tooltip, C4). */
export function describeCron(c: CronSpec): string {
  const allDoms = c.doms.length === 31;
  const allDows = c.dows.length === 7;
  const allMonths = c.months.length === 12;
  let day: string;
  let suffix: string;
  if (allDoms && allDows && allMonths) [day, suffix] = ["Every day", ""];
  else if (allDoms && allMonths && same(c.dows, [1, 2, 3, 4, 5])) [day, suffix] = ["Weekdays", " on weekdays"];
  else if (allDoms && allMonths && same(c.dows, [0, 6])) [day, suffix] = ["Weekends", " on weekends"];
  else if (allDoms && allMonths) {
    const names = joinAnd(c.dows.map((d) => DAY_NAMES[d] as string));
    [day, suffix] = [`Every ${names}`, ` on ${names}`];
  } else if (allDows && allMonths) {
    const days = `the ${joinAnd(c.doms.map(ordinal))} of every month`;
    [day, suffix] = [`On ${days}`, ` on ${days}`];
  } else if (allDows && c.months.length === 1 && c.doms.length === 1) {
    const date = `${MONTH_NAMES[(c.months[0] as number) - 1]} ${c.doms[0]}`;
    [day, suffix] = [`Every year on ${date}`, ` every year on ${date}`];
  } else return "Custom schedule";

  const allHours = c.hours.length === 24;
  if (c.minutes.length === 1) {
    const m = c.minutes[0] as number;
    if (c.hours.length === 1) return `${day} at ${formatTime(c.hours[0] as number, m)}`;
    if (allHours) return `${m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`}${suffix}`;
    const step = uniformStep(c.hours);
    if (step) {
      const first = formatTime(c.hours[0] as number, m);
      const last = formatTime(c.hours[c.hours.length - 1] as number, m);
      return `Every ${step === 1 ? "hour" : `${step} hours`}, ${first} – ${last}${suffix}`;
    }
    return `${day} at ${joinAnd(c.hours.map((h) => formatTime(h, m)))}`;
  }
  if (allHours && c.minutes[0] === 0) {
    const step = c.minutes.length === 60 ? 1 : uniformStep(c.minutes, 2);
    if (step && 60 % step === 0 && c.minutes.length === 60 / step) return `Every ${step === 1 ? "minute" : `${step} minutes`}${suffix}`;
  }
  return "Custom schedule";
}
