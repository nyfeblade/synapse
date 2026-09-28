import { LIMITS, STR } from "@synapse/shared";
import { ALIASES, cronMatches, describeCron, parseCron } from "./cron";
import { describeRRule, formatRRule, parseRRule, rruleOccurrencesOnDay } from "./rrule";
import { ScheduleError, type CronSpec, type ParsedSchedule } from "./types";
import { instantOf, isValidZone, localParts, zoneLabel } from "./zone";

const bad = () => new ScheduleError(STR.scheduleInvalid);
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses any stored or model-facing schedule (RTN-05, ORIG-03): 5-field cron, an alias, `@every <n>(s|m|h|d)`,
 * or `RRULE:…`, each with an optional `CRON_TZ=<IANA>` / `TZ=<IANA>` prefix. `o.tz` is the Bot's zone, used only to
 * anchor a new RRULE's DTSTART.
 */
export function parseSchedule(s: string, o: { tz: string; nowMs: number }): ParsedSchedule {
  let text = s.trim().replace(/\s+/g, " ");
  let tz: string | null = null;
  const pre = /^(?:CRON_TZ|TZ)=(\S+) (.+)$/i.exec(text);
  if (pre) {
    if (!isValidZone(pre[1] as string)) throw bad();
    tz = pre[1] as string;
    text = pre[2] as string;
  }
  const once = /^@once (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$/i.exec(text);
  if (once) {
    const atMs = Date.parse(once[1] as string);
    if (!Number.isFinite(atMs)) throw bad();
    return { kind: "once", atMs, expr: onceExpr(atMs) };
  }
  const every = /^@every (\d+)(s|m|h|d)$/i.exec(text);
  if (every) {
    const unit = (every[2] as string).toLowerCase();
    const everyMs = Number(every[1]) * (UNIT[unit] as number);
    if (everyMs <= 0) throw bad();
    return { kind: "every", everyMs, expr: `@every ${Number(every[1])}${unit}` }; // @every ignores zones (RTN-05)
  }
  if (/^RRULE:/i.test(text)) {
    const rule = parseRRule(text, tz ?? o.tz, o.nowMs);
    return { kind: "rrule", rule, tz, expr: formatRRule(rule) };
  }
  if (text.startsWith("@")) {
    const alias = ALIASES[text.toLowerCase()];
    if (!alias) throw bad();
    return { kind: "cron", cron: parseCron(alias), tz, expr: text.toLowerCase() };
  }
  return { kind: "cron", cron: parseCron(text), tz, expr: text };
}

/** The stored form of a one-shot: minute precision, UTC. */
export function onceExpr(atMs: number): string {
  return `@once ${new Date(Math.floor(atMs / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/** RTN-06: the Bot's zone unless the schedule pins one; @every has no zone. */
export function effectiveZone(p: ParsedSchedule, botTz: string): string {
  return (p.kind === "cron" || p.kind === "rrule") && p.tz ? p.tz : botTz;
}

type Day = { y: number; mo: number; d: number };
const dayNum = (x: Day) => Math.floor(Date.UTC(x.y, x.mo - 1, x.d) / 86_400_000);
const fromNum = (n: number): Day => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

function cronTimes(c: CronSpec, day: Day): { h: number; mi: number }[] {
  const dow = new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay();
  if (!cronMatches(c, { ...day, h: c.hours[0] as number, mi: c.minutes[0] as number, dow })) return [];
  return c.hours.flatMap((h) => c.minutes.map((mi) => ({ h, mi })));
}

/**
 * Occurrence instants strictly after `afterMs`, in order, never the same instant twice (RTN-07 search, ORIG-03 §03.5).
 * Cron and RRULE walk local calendar days (≤ 366) in the effective zone; `@every` steps from `anchorMs`.
 */
export function* occurrencesAfter(p: ParsedSchedule, afterMs: number, botTz: string, anchorMs?: number): Generator<number> {
  const horizon = afterMs + LIMITS.cronHorizonDays * 86_400_000;
  if (p.kind === "once") {
    if (p.atMs > afterMs) yield p.atMs;
    return;
  }
  if (p.kind === "every") {
    const a = anchorMs ?? afterMs;
    let t = a + Math.max(1, Math.floor((afterMs - a) / p.everyMs) + 1) * p.everyMs;
    for (; t <= horizon; t += p.everyMs) yield t;
    return;
  }
  const tz = effectiveZone(p, botTz);
  const start = dayNum(localParts(afterMs, tz));
  const first = p.kind === "rrule" && p.rule.count !== null ? Math.min(start, dayNum(p.rule.dtstart)) : start;
  let last = -Infinity;
  let counted = 0;
  for (let n = first; n <= start + LIMITS.cronHorizonDays; n++) {
    const day = fromNum(n);
    const times = p.kind === "cron" ? cronTimes(p.cron, day) : rruleOccurrencesOnDay(p.rule, day);
    const instants = [...new Set(times.map((t) => instantOf({ ...day, h: t.h, mi: t.mi }, tz)))].sort((a, b) => a - b);
    for (const t of instants) {
      if (p.kind === "rrule") {
        if (p.rule.until !== null && t > p.rule.until) return;
        if (p.rule.count !== null && ++counted > p.rule.count) return;
      }
      if (t > afterMs && t > last) {
        last = t;
        yield t;
      }
    }
  }
}

/** RTN-07: the next run strictly after `afterMs`, or null if none within 366 days. `tz` is the Bot's zone (a pinned zone wins). */
export function nextRunAfter(p: ParsedSchedule, afterMs: number, tz: string, anchorMs?: number): number | null {
  const it = occurrencesAfter(p, afterMs, tz, anchorMs).next();
  return it.done ? null : it.value;
}

export function nextRuns(p: ParsedSchedule, afterMs: number, tz: string, n: number): number[] {
  const out: number[] = [];
  for (const t of occurrencesAfter(p, afterMs, tz)) {
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

function describeEvery(ms: number): string {
  const [n, unit] = ms % 86_400_000 === 0 ? [ms / 86_400_000, "day"] : ms % 3_600_000 === 0 ? [ms / 3_600_000, "hour"] : ms % 60_000 === 0 ? [ms / 60_000, "minute"] : [ms / 1000, "second"];
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

function describeInstant(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(ms).map((x) => [x.type, x.value])) as Record<string, string>;
  return `${p.weekday} ${p.month} ${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** Plain-English description (RTN-05 / ORIG-03 §03.4), with "(Zone)" when the schedule pins a zone. */
export function describeSchedule(p: ParsedSchedule, botTz: string): string {
  if (p.kind === "every") return describeEvery(p.everyMs);
  if (p.kind === "once") return `Once, ${describeInstant(p.atMs, botTz)}`;
  const zone = p.tz ? ` (${zoneLabel(p.tz)})` : "";
  return `${p.kind === "cron" ? describeCron(p.cron) : describeRRule(p.rule)}${zone}`;
}

/** The raw expression for the C4 tooltip and the detail view: "CRON_TZ=America/New_York 0 8 * * *". */
export function rawSchedule(p: ParsedSchedule, botTz: string): string {
  if (p.kind === "every" || p.kind === "once") return p.expr;
  const body = p.kind === "rrule" ? p.expr.replace(/;X-DTSTART=[^;\s]*/, "") : p.expr;
  return `CRON_TZ=${effectiveZone(p, botTz)} ${body}`;
}
