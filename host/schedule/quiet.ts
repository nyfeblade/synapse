import { STRS } from "@synapse/shared";
import { occurrencesAfter } from "./schedule";
import { ScheduleError, type ParsedSchedule } from "./types";
import { localParts } from "./zone";

/** Quiet hours as minutes after local midnight; `from > to` wraps midnight (22:00–07:00). */
export interface QuietHours { from: number; to: number }

function minutes(raw: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = m[3] === "am" ? h % 12 : (h % 12) + 12;
  } else if (h > 23) return null;
  return h * 60 + mi;
}

/** "22:00-07:00", "10pm-7am", "22:00 to 07:00". Throws ScheduleError with the user-facing text. */
export function parseQuietHours(s: string): QuietHours {
  const parts = s.trim().split(/\s*(?:-|–|—|\bto\b)\s*/i);
  const from = parts.length === 2 ? minutes(parts[0]!) : null;
  const to = parts.length === 2 ? minutes(parts[1]!) : null;
  if (from === null || to === null || from === to) throw new ScheduleError(STRS.quietHoursInvalid);
  return { from, to };
}

/**
 * Quiet hours written into a schedule: "every hour, quiet 22:00-07:00", "every 2 hours (quiet 10pm-7am)",
 * "hourly except 10pm-7am", "every hour not between 10pm and 7am". "quiet none" clears them.
 * Returns the schedule without the clause, and the clause's range (null = clear, undefined = none written).
 */
export function splitQuietClause(schedule: string): { schedule: string; quiet: string | null | undefined } {
  const m = /^(.*?)[\s,;]*\(?\s*(?:quiet(?: hours)?|except|not between)\s+(.+?)\)?\s*$/i.exec(schedule.trim());
  if (!m || !m[1]!.trim()) return { schedule, quiet: undefined };
  const range = m[2]!.trim();
  if (/^(?:none|off|no)$/i.test(range)) return { schedule: m[1]!.trim(), quiet: null };
  // "every day except weekends" is a schedule, not quiet hours: a quiet clause names clock times.
  if (!/\d/.test(range)) return { schedule, quiet: undefined };
  return { schedule: m[1]!.trim(), quiet: range.replace(/\s+and\s+/i, "-") };
}

/** The stored form: "22:00-07:00". */
export function formatQuietHours(q: QuietHours): string {
  const f = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  return `${f(q.from)}-${f(q.to)}`;
}

export function inQuietHours(ms: number, tz: string, q: QuietHours): boolean {
  const l = localParts(ms, tz);
  const m = l.h * 60 + l.mi;
  return q.from < q.to ? m >= q.from && m < q.to : m >= q.from || m < q.to;
}

/** A stored value that no longer parses means "no quiet hours" (the save path refuses bad ones). */
export function quietOf(stored: string | undefined): QuietHours | null {
  if (!stored) return null;
  try {
    return parseQuietHours(stored);
  } catch {
    return null;
  }
}

const MAX_SKIPS = 5000;

/** The next occurrence after `afterMs` that is not inside the quiet window (null if none within the search horizon). */
export function nextRunOutsideQuiet(p: ParsedSchedule, afterMs: number, tz: string, anchorMs: number | undefined, q: QuietHours | null): number | null {
  let n = 0;
  for (const t of occurrencesAfter(p, afterMs, tz, anchorMs)) {
    if (!q || !inQuietHours(t, tz, q)) return t;
    if (++n >= MAX_SKIPS) return null;
  }
  return null;
}
