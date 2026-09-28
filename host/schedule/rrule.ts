import { STR } from "@synapse/shared";
import { DAY_NAMES, MONTH_NAMES, formatTime, joinAnd, ordinal } from "./cron";
import { ScheduleError, type RRuleSpec } from "./types";
import { instantOf, localParts } from "./zone";

const RR = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ALLOWED = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL", "X-DTSTART"]);
const bad = () => new ScheduleError(STR.scheduleInvalid);

type Day = { y: number; mo: number; d: number };
type Occ = { day: number; h: number; mi: number };
const dayNum = (x: Day) => Math.floor(Date.UTC(x.y, x.mo - 1, x.d) / 86_400_000);
const fromNum = (n: number): Day & { dow: number } => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
};
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const monday = (n: number) => n - ((fromNum(n).dow + 6) % 7);

function ints(v: string, lo: number, hi: number, allowNeg: boolean): number[] {
  const out = v.split(",").map((x) => {
    if (!/^[+-]?\d+$/.test(x)) throw bad();
    const n = Number(x);
    if (n === 0 && lo > 0) throw bad();
    if (allowNeg ? Math.abs(n) < lo || Math.abs(n) > hi : n < lo || n > hi) throw bad();
    return n;
  });
  return [...new Set(out)];
}

/** Parses the ORIG-03 RRULE subset. DTSTART comes from X-DTSTART, or is the first matching local time after nowMs (so saving never runs it). */
export function parseRRule(expr: string, tz: string, nowMs: number): RRuleSpec {
  const body = expr.trim().replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const kv of body.split(";")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    if (i <= 0) throw bad();
    const k = kv.slice(0, i).toUpperCase();
    if (!ALLOWED.has(k) || parts.has(k)) throw bad();
    parts.set(k, k === "X-DTSTART" ? kv.slice(i + 1) : kv.slice(i + 1).toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") throw bad();
  if (!parts.has("BYHOUR") || !parts.has("BYMINUTE")) throw bad();
  const interval = parts.has("INTERVAL") ? (ints(parts.get("INTERVAL") as string, 1, 1000, false)[0] as number) : 1;
  const byDay = (parts.get("BYDAY") ?? "").split(",").filter(Boolean).map((x) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
    if (!m) throw bad();
    const n = m[1] ? Number(m[1]) : 0;
    if (n !== 0 && (Math.abs(n) > 5 || (freq !== "MONTHLY" && freq !== "YEARLY"))) throw bad();
    return { n, dow: RR.indexOf(m[2] as string) };
  });
  const rule: RRuleSpec = {
    freq, interval, byDay,
    byMonthDay: parts.has("BYMONTHDAY") ? ints(parts.get("BYMONTHDAY") as string, 1, 31, true) : [],
    byMonth: parts.has("BYMONTH") ? ints(parts.get("BYMONTH") as string, 1, 12, false) : [],
    bySetPos: parts.has("BYSETPOS") ? ints(parts.get("BYSETPOS") as string, 1, 366, true) : [],
    byHour: ints(parts.get("BYHOUR") as string, 0, 23, false).sort((a, b) => a - b),
    byMinute: ints(parts.get("BYMINUTE") as string, 0, 59, false).sort((a, b) => a - b),
    count: parts.has("COUNT") ? (ints(parts.get("COUNT") as string, 1, 100_000, false)[0] as number) : null,
    until: null,
    dtstart: { ...localParts(nowMs, tz), h: 0, mi: 0 },
  };
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(until);
    if (!m) throw bad();
    rule.until = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  }
  const x = parts.get("X-DTSTART");
  if (x !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(x);
    if (!m) throw bad();
    const day = { y: +m[1]!, mo: +m[2]!, d: +m[3]! };
    rule.dtstart = { ...day, h: +m[4]!, mi: +m[5]!, dow: fromNum(dayNum(day)).dow };
    return rule;
  }
  const today = dayNum(localParts(nowMs, tz));
  for (let n = today; n <= today + 400; n++) {
    const day = fromNum(n);
    const probe: RRuleSpec = { ...rule, dtstart: { ...day, h: 0, mi: 0 } };
    for (const t of rruleOccurrencesOnDay(probe, day)) {
      if (instantOf({ ...day, h: t.h, mi: t.mi }, tz) > nowMs) {
        rule.dtstart = { ...day, h: t.h, mi: t.mi };
        return rule;
      }
    }
  }
  throw bad();
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Stored form: RRULE:…;X-DTSTART=<local ISO> (ORIG-03 §03.4); part order is fixed so the text is stable. */
export function formatRRule(r: RRuleSpec): string {
  const p = [`FREQ=${r.freq}`];
  if (r.interval !== 1) p.push(`INTERVAL=${r.interval}`);
  if (r.byMonth.length) p.push(`BYMONTH=${r.byMonth.join(",")}`);
  if (r.byMonthDay.length) p.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.byDay.length) p.push(`BYDAY=${r.byDay.map((b) => `${b.n || ""}${RR[b.dow]}`).join(",")}`);
  if (r.bySetPos.length) p.push(`BYSETPOS=${r.bySetPos.join(",")}`);
  p.push(`BYHOUR=${r.byHour.join(",")}`, `BYMINUTE=${r.byMinute.join(",")}`);
  if (r.count !== null) p.push(`COUNT=${r.count}`);
  if (r.until !== null) {
    const u = new Date(r.until);
    p.push(`UNTIL=${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`);
  }
  const s = r.dtstart;
  p.push(`X-DTSTART=${s.y}-${pad(s.mo)}-${pad(s.d)}T${pad(s.h)}:${pad(s.mi)}`);
  return `RRULE:${p.join(";")}`;
}

function monthDays(r: RRuleSpec, y: number, mo: number): number[] {
  const dim = daysIn(y, mo);
  const first = dayNum({ y, mo, d: 1 });
  const all = Array.from({ length: dim }, (_, i) => first + i);
  const byMd = r.byMonthDay.length
    ? new Set(r.byMonthDay.map((d) => first + (d > 0 ? d - 1 : dim + d)))
    : null;
  let byDay: Set<number> | null = null;
  if (r.byDay.length) {
    byDay = new Set();
    for (const b of r.byDay) {
      const hits = all.filter((n) => fromNum(n).dow === b.dow);
      if (b.n === 0) hits.forEach((n) => byDay!.add(n));
      else {
        const hit = b.n > 0 ? hits[b.n - 1] : hits[hits.length + b.n];
        if (hit !== undefined) byDay.add(hit);
      }
    }
  }
  if (!byMd && !byDay) return all.filter((n) => fromNum(n).d === r.dtstart.d);
  return all.filter((n) => (!byMd || byMd.has(n)) && (!byDay || byDay.has(n)));
}

const memo = new WeakMap<RRuleSpec, Map<string, Occ[]>>();

/** All occurrences in the period (day, week, month or year) that contains `n`, after BYSETPOS. */
function periodOccs(r: RRuleSpec, n: number): Occ[] {
  const day = fromNum(n);
  const k = r.freq === "DAILY" ? `d${n}` : r.freq === "WEEKLY" ? `w${monday(n)}` : r.freq === "MONTHLY" ? `m${day.y}-${day.mo}` : `y${day.y}`;
  let cache = memo.get(r);
  if (!cache) memo.set(r, (cache = new Map()));
  const hit = cache.get(k);
  if (hit) return hit;
  let days: number[];
  if (r.freq === "DAILY") days = [n];
  else if (r.freq === "WEEKLY") {
    const dows = r.byDay.length ? r.byDay.map((b) => b.dow) : [r.dtstart.dow];
    days = Array.from({ length: 7 }, (_, i) => monday(n) + i).filter((x) => dows.includes(fromNum(x).dow));
  } else if (r.freq === "MONTHLY") days = monthDays(r, day.y, day.mo);
  else days = (r.byMonth.length ? r.byMonth : [r.dtstart.mo]).flatMap((mo) => monthDays(r, day.y, mo));
  if (r.freq === "DAILY") {
    const d = fromNum(n);
    const dim = daysIn(d.y, d.mo);
    if (r.byDay.length && !r.byDay.some((b) => b.dow === d.dow)) days = [];
    if (r.byMonthDay.length && !r.byMonthDay.some((x) => (x > 0 ? x : dim + x + 1) === d.d)) days = [];
  }
  if (r.byMonth.length && r.freq !== "YEARLY") days = days.filter((x) => r.byMonth.includes(fromNum(x).mo));
  let occs: Occ[] = days.sort((a, b) => a - b).flatMap((d) => r.byHour.flatMap((h) => r.byMinute.map((mi) => ({ day: d, h, mi }))));
  if (r.bySetPos.length) {
    const picked = r.bySetPos.map((p) => (p > 0 ? occs[p - 1] : occs[occs.length + p])).filter((o): o is Occ => o !== undefined);
    occs = [...new Set(picked)].sort((a, b) => a.day - b.day || a.h - b.h || a.mi - b.mi);
  }
  cache.set(k, occs);
  return occs;
}

function intervalOk(r: RRuleSpec, n: number): boolean {
  const s = dayNum(r.dtstart);
  const d = fromNum(n);
  const idx =
    r.freq === "DAILY" ? n - s
    : r.freq === "WEEKLY" ? (monday(n) - monday(s)) / 7
    : r.freq === "MONTHLY" ? d.y * 12 + d.mo - (r.dtstart.y * 12 + r.dtstart.mo)
    : d.y - r.dtstart.y;
  return idx >= 0 && idx % r.interval === 0;
}

/** True when the rule has an occurrence on this local calendar day (ignores COUNT/UNTIL, which need instants). */
export function rruleDayMatches(r: RRuleSpec, day: { y: number; mo: number; d: number }): boolean {
  const n = dayNum(day);
  if (n < dayNum(r.dtstart) || !intervalOk(r, n)) return false;
  return periodOccs(r, n).some((o) => o.day === n);
}

/** Local times of the rule's occurrences on this day, sorted; on the DTSTART day only times at or after DTSTART. */
export function rruleOccurrencesOnDay(r: RRuleSpec, day: { y: number; mo: number; d: number }): { h: number; mi: number }[] {
  if (!rruleDayMatches(r, day)) return [];
  const n = dayNum(day);
  const floor = n === dayNum(r.dtstart) ? r.dtstart.h * 60 + r.dtstart.mi : -1;
  return periodOccs(r, n).filter((o) => o.day === n && o.h * 60 + o.mi >= floor).map((o) => ({ h: o.h, mi: o.mi }));
}

const ORDW: Record<string, string> = { "1": "First", "2": "Second", "3": "Third", "4": "Fourth", "5": "Fifth", "-1": "Last", "-2": "Second-to-last" };
const WEEKDAYS = [1, 2, 3, 4, 5];

/** ORIG-03 §03.4 describer phrases. */
export function describeRRule(r: RRuleSpec): string {
  const times = r.byHour.flatMap((h) => r.byMinute.map((mi) => formatTime(h, mi)));
  const at = ` at ${joinAnd(times)}`;
  const noFilters = !r.byDay.length && !r.byMonthDay.length && !r.byMonth.length && !r.bySetPos.length;
  if (r.freq === "DAILY" && noFilters) {
    return r.interval === 1 ? `Every day${at}` : r.interval === 2 ? `Every other day${at}` : `Every ${r.interval} days${at}`;
  }
  if (r.freq === "WEEKLY" && !r.byMonthDay.length && !r.byMonth.length && !r.bySetPos.length) {
    const names = joinAnd((r.byDay.length ? r.byDay.map((b) => b.dow) : [r.dtstart.dow]).map((d) => DAY_NAMES[d] as string));
    return r.interval === 1 ? `Every ${names}${at}` : r.interval === 2 ? `Every other ${names}${at}` : `Every ${r.interval} weeks on ${names}${at}`;
  }
  if (r.freq === "MONTHLY" && !r.byMonth.length) {
    const each = r.interval === 1 ? "each month" : r.interval === 2 ? "every other month" : `every ${r.interval} months`;
    const dows = r.byDay.map((b) => b.dow).sort((a, b) => a - b);
    const plainDays = r.byDay.every((b) => b.n === 0);
    if (plainDays && dows.join() === WEEKDAYS.join() && r.bySetPos.length === 1 && !r.byMonthDay.length && ORDW[String(r.bySetPos[0])]) {
      return `${ORDW[String(r.bySetPos[0])]} weekday of ${each}${at}`;
    }
    if (!r.bySetPos.length && !r.byMonthDay.length && r.byDay.length && r.byDay.every((b) => b.n !== 0 && ORDW[String(b.n)])) {
      const parts = r.byDay.map((b) => `${ORDW[String(b.n)]} ${DAY_NAMES[b.dow]}`);
      return `${joinAnd(parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))))} of ${each}${at}`;
    }
    if (!r.bySetPos.length && !r.byDay.length && r.byMonthDay.length) {
      if (r.byMonthDay.length === 1 && r.byMonthDay[0] === -1) return `Last day of ${each}${at}`;
      if (r.byMonthDay.every((d) => d > 0)) return `On the ${joinAnd(r.byMonthDay.map(ordinal))} of ${each}${at}`;
    }
    if (noFilters) return `On the ${ordinal(r.dtstart.d)} of ${each}${at}`;
  }
  if (r.freq === "YEARLY" && !r.byDay.length && !r.bySetPos.length && r.byMonth.length <= 1 && r.byMonthDay.length <= 1 && (r.byMonthDay[0] ?? 1) > 0) {
    const mo = r.byMonth[0] ?? r.dtstart.mo;
    const d = r.byMonthDay[0] ?? r.dtstart.d;
    return `Every year on ${MONTH_NAMES[mo - 1]} ${d}${at}`;
  }
  return "Custom schedule";
}
