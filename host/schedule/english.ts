import { onceExpr } from "./schedule";
import { instantOf, isValidZone, localParts } from "./zone";

/** ORIG-03 §03.2: a small deterministic grammar for common phrasings. Returns null when it doesn't understand (→ model fallback). */

const DOW: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const RR = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const ORD: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 };
const CITY: Record<string, string> = {
  tokyo: "Asia/Tokyo", london: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin", "new york": "America/New_York",
  "los angeles": "America/Los_Angeles", "san francisco": "America/Los_Angeles", chicago: "America/Chicago", denver: "America/Denver",
  sydney: "Australia/Sydney", singapore: "Asia/Singapore", "hong kong": "Asia/Hong_Kong", mumbai: "Asia/Kolkata", india: "Asia/Kolkata",
  eastern: "America/New_York", pacific: "America/Los_Angeles", central: "America/Chicago", mountain: "America/Denver", utc: "UTC", gmt: "UTC",
};

interface Ambiguity { test: RegExp; onlyWithoutTime: boolean; why: string; question: string }
const HAS_TIME = /\d|\bnoon\b|\bmidnight\b/;
const AMBIGUITIES: Ambiguity[] = [
  { test: /\b(tomorrow|today|tonight|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/, onlyWithoutTime: false, why: "it names a single date, and routines repeat", question: "Should it repeat every day at that time, or on some other schedule?" },
  { test: /\b(twice|three times|a couple (?:of )?times|several times)\b/, onlyWithoutTime: false, why: "it says how many times but not when", question: "At which times should it run?" },
  { test: /\bevery few\b|\bhour or two\b|\bcouple of hours\b/, onlyWithoutTime: false, why: "the interval isn't a number", question: "How many hours apart should the runs be?" },
  { test: /\b(regularly|sometimes|occasionally|often|now and then|from time to time)\b/, onlyWithoutTime: false, why: "it doesn't say how often", question: "How often should it run, and at what time?" },
  { test: /^(?:weekly|every week|once a week)$/, onlyWithoutTime: false, why: "it leaves out the day and the time", question: "Which day of the week, and at what time?" },
  { test: /^every other week$/, onlyWithoutTime: false, why: "it leaves out the day, the time and which week to start", question: "Which day of the week should it run, at what time, and starting this week or next?" },
  { test: /^(?:monthly|every month|once a month)$/, onlyWithoutTime: false, why: "it leaves out the day and the time", question: "Which day of the month, and at what time?" },
  { test: /\b(morning|afternoon|evening|night|lunch|breakfast|dinner|end of (?:the )?day)\b/, onlyWithoutTime: true, why: "it names a part of the day, not a time", question: "Which exact time should it run, for example 8:00 AM?" },
  {
    test: /^(?:every |each |on )?(?:day|daily|weekdays?|weekends?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:(?:,| and|, and) (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*)$|^(?:on )?the \d{1,2}(?:st|nd|rd|th)?(?: of (?:every|each|the) month)?$/,
    onlyWithoutTime: false, why: "it leaves out the time of day", question: "What time of day should it run?",
  },
  { test: /^at (?:noon|midnight|\d{1,2}(?::\d{2})? ?(?:[ap]m)?)$/, onlyWithoutTime: false, why: "it gives a time but not how often", question: "How often should it run: every day, on weekdays, or something else?" },
];

/** The "why" half of STR.scheduleAmbiguous for a question this grammar (or the model) produced. */
export function whyFor(question: string): string {
  return AMBIGUITIES.find((a) => a.question === question)?.why ?? "the wording can be read more than one way";
}

function parseTime(raw: string): { h: number; mi: number } | null {
  const s = raw.trim();
  if (s === "noon") return { h: 12, mi: 0 };
  if (s === "midnight") return { h: 0, mi: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = m[3] === "am" ? h % 12 : (h % 12) + 12;
  } else if (h > 23) return null;
  return { h, mi };
}

function parseTimes(raw: string): { hours: number[]; minute: number } | null {
  const ts = raw.split(/\s*(?:,\s*and|,|\band\b)\s*/).filter(Boolean).map(parseTime);
  if (!ts.length || ts.some((t) => !t)) return null;
  const minute = (ts[0] as { mi: number }).mi;
  if (ts.some((t) => t!.mi !== minute)) return null;
  return { hours: [...new Set(ts.map((t) => t!.h))].sort((a, b) => a - b), minute };
}

function dowOf(word: string): number | undefined {
  return DOW[word] ?? DOW[word.replace(/s$/, "")];
}

function parseDays(raw: string): string | null {
  const s = raw.replace(/^(?:every|each|on) /, "").trim();
  if (["day", "days", "daily"].includes(s)) return "*";
  if (/^weekdays?$/.test(s)) return "1-5";
  if (/^(?:weekends?|weekend days)$/.test(s)) return "0,6";
  const ds = s.split(/\s*(?:,\s*and|,|\band\b|&)\s*/).filter(Boolean).map(dowOf);
  if (!ds.length || ds.some((d) => d === undefined)) return null;
  return [...new Set(ds as number[])].sort((a, b) => a - b).join(",");
}

function rangeHours(from: string, to: string): [number, number] | null {
  const a = parseTime(from);
  const b = parseTime(to);
  if (!a || !b) return null;
  let end = b.h;
  if (!/[ap]m/.test(to) && end <= a.h && end < 12) end += 12;
  return end > a.h ? [a.h, end] : null;
}

function rr(freq: string, o: { interval?: number; byMonthDay?: string; byDay?: string; bySetPos?: string }, t: { h: number; mi: number }): string {
  const p = [`FREQ=${freq}`];
  if (o.interval && o.interval !== 1) p.push(`INTERVAL=${o.interval}`);
  if (o.byMonthDay) p.push(`BYMONTHDAY=${o.byMonthDay}`);
  if (o.byDay) p.push(`BYDAY=${o.byDay}`);
  if (o.bySetPos) p.push(`BYSETPOS=${o.bySetPos}`);
  p.push(`BYHOUR=${t.h}`, `BYMINUTE=${t.mi}`);
  return `RRULE:${p.join(";")}`;
}

function grammar(input: string): string | null {
  let t = input;
  if (t === "every minute") return "* * * * *";
  let m = /^every (?:(\d+) )?minutes?$/.exec(t);
  if (m) {
    const n = Number(m[1] ?? 1);
    if (n < 1) return null;
    if (n < 60 && 60 % n === 0) return n === 1 ? "* * * * *" : `*/${n} * * * *`;
    if (n % 60 === 0 && 24 % (n / 60) === 0) return n === 60 ? "0 * * * *" : `0 */${n / 60} * * *`;
    return `@every ${n}m`;
  }
  m = /^every (?:(\d+) )?hours?(?: at :(\d{2}))?(?: from (.+?) to (.+?))?(?: on (.+))?$/.exec(t);
  if (m) {
    const n = Number(m[1] ?? 1);
    const minute = m[2] ? Number(m[2]) : 0;
    const dow = m[5] ? parseDays(m[5]) : "*";
    if (n < 1 || minute > 59 || dow === null) return null;
    let hours: string;
    if (m[3] && m[4]) {
      const r = rangeHours(m[3], m[4]);
      if (!r) return null;
      hours = n === 1 ? `${r[0]}-${r[1]}` : `${r[0]}-${r[1]}/${n}`;
    } else if (n === 1) hours = "*";
    else if (24 % n === 0) hours = `*/${n}`;
    else if (!m[2] && !m[5]) return `@every ${n}h`;
    else return null;
    return `${minute} ${hours} * * ${dow}`;
  }
  m = /^at (.+?) ((?:every|on|daily)\b.*)$/.exec(t);
  if (m) t = `${m[2]} at ${m[1]}`;
  m = /^every (other|\d+) days? at (.+)$/.exec(t);
  if (m) {
    const n = m[1] === "other" ? 2 : Number(m[1]);
    const tm = parseTime(m[2] as string);
    if (!tm || n < 1) return null;
    return n === 1 ? `${tm.mi} ${tm.h} * * *` : rr("DAILY", { interval: n }, tm);
  }
  m = /^every other ([a-z]+) at (.+)$/.exec(t) ?? /^every (\d+) weeks? on ([a-z]+) at (.+)$/.exec(t);
  if (m) {
    const other = m.length === 3;
    const dow = dowOf(m[other ? 1 : 2] as string);
    const tm = parseTime(m[other ? 2 : 3] as string);
    const n = other ? 2 : Number(m[1]);
    if (dow === undefined || !tm || n < 1) return null;
    return rr("WEEKLY", { interval: n, byDay: RR[dow] }, tm);
  }
  m = /^(?:every year on|every|each) ([a-z]+) (\d{1,2})(?:st|nd|rd|th)? at (.+)$/.exec(t);
  if (m && MONTHS[m[1] as string]) {
    const d = Number(m[2]);
    const tm = parseTime(m[3] as string);
    if (!tm || d < 1 || d > 31) return null;
    return `${tm.mi} ${tm.h} ${d} ${MONTHS[m[1] as string]} *`;
  }
  m = /^(?:on )?(?:the )?(first|second|third|fourth|last|1st|2nd|3rd|4th) ([a-z]+) of (?:every|each|the) month at (.+)$/.exec(t);
  if (m) {
    const n = ORD[m[1] as string] as number;
    const tm = parseTime(m[3] as string);
    if (!tm) return null;
    if (m[2] === "day") return n === -1 ? rr("MONTHLY", { byMonthDay: "-1" }, tm) : `${tm.mi} ${tm.h} ${n} * *`;
    if (m[2] === "weekday") return rr("MONTHLY", { byDay: "MO,TU,WE,TH,FR", bySetPos: String(n) }, tm);
    const dow = dowOf(m[2] as string);
    return dow === undefined ? null : rr("MONTHLY", { byDay: `${n}${RR[dow]}` }, tm);
  }
  m = /^(?:monthly )?(?:on )?(?:the )?(\d{1,2}(?:st|nd|rd|th)?(?:(?:,|, and| and) (?:the )?\d{1,2}(?:st|nd|rd|th)?)*) of (?:every|each|the) month at (.+)$/.exec(t);
  if (m) {
    const doms = [...new Set((m[1] as string).match(/\d{1,2}/g)!.map(Number))].sort((a, b) => a - b);
    const ts = parseTimes(m[2] as string);
    if (!ts || doms.some((d) => d < 1 || d > 31)) return null;
    return `${ts.minute} ${ts.hours.join(",")} ${doms.join(",")} * *`;
  }
  m = /^(.+?) at (.+)$/.exec(t);
  if (m) {
    const dow = parseDays(m[1] as string);
    const ts = parseTimes(m[2] as string);
    if (dow && ts) return `${ts.minute} ${ts.hours.join(",")} * * ${dow}`;
  }
  return null;
}

function extractZone(text: string): { rest: string; zone: string | null } {
  const iana = /^(.*?)\s+in\s+([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/.exec(text);
  if (iana && isValidZone(iana[2] as string)) return { rest: iana[1] as string, zone: iana[2] as string };
  const low = text.toLowerCase();
  for (const [city, zone] of Object.entries(CITY)) {
    const suffixes = [` in ${city} time`, ` ${city} time`, ` in ${city}`, ...(zone === "UTC" ? [` ${city}`] : [])];
    const hit = suffixes.find((s) => low.endsWith(s));
    if (hit) return { rest: text.slice(0, text.length - hit.length), zone };
  }
  return { rest: text, zone: null };
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\ba\.m\./g, "am").replace(/\bp\.m\./g, "pm").replace(/ ?o'clock\b/g, "").replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
}

const ONE_UNIT: Record<string, number> = { minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

/** One-shot runs: "in 2 hours", "in a day", "once at 5pm", "once tomorrow at 9am", "once on 2026-10-01 at 9am". */
function oneShot(t: string, tz: string, nowMs: number): string | null {
  let m = /^in (\d+|an?|one) (minute|min|hour|hr|day|week)s?$/.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[1] as string) ? Number(m[1]) : 1;
    if (n < 1) return null;
    return onceExpr(nowMs + n * (ONE_UNIT[m[2] as string] as number));
  }
  m = /^once (?:(today|tomorrow|on (\d{4})-(\d{2})-(\d{2})) )?at (.+)$/.exec(t);
  if (!m) return null;
  const tm = parseTime(m[5] as string);
  if (!tm) return null;
  const l = localParts(nowMs, tz);
  const day = (offset: number) => {
    const d = new Date(Date.UTC(l.y, l.mo - 1, l.d + offset));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  if (m[2]) return onceExpr(instantOf({ y: Number(m[2]), mo: Number(m[3]), d: Number(m[4]), ...tm }, tz));
  if (m[1] === "tomorrow") return onceExpr(instantOf({ ...day(1), ...tm }, tz));
  const today = instantOf({ ...day(0), ...tm }, tz);
  if (m[1] === "today" || today > nowMs) return onceExpr(today);
  return onceExpr(instantOf({ ...day(1), ...tm }, tz));
}

/** `o` gives the zone and time a one-shot ("in 2 hours") is anchored to. */
export function parseEnglish(text: string, o: { tz: string; nowMs: number }): { schedule: string } | { ambiguity: string } | null {
  const { rest, zone } = extractZone(text.trim());
  const t = normalizeText(rest);
  const once = oneShot(t, zone ?? o.tz, o.nowMs);
  if (once) return { schedule: once };
  const g = grammar(t);
  if (g) return { schedule: zone && !g.startsWith("@every") ? `CRON_TZ=${zone} ${g}` : g };
  const a = AMBIGUITIES.find((x) => x.test.test(t) && !(x.onlyWithoutTime && HAS_TIME.test(t)));
  return a ? { ambiguity: a.question } : null;
}
