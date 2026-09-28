import fs from "node:fs";
import path from "node:path";

/** A Bot calling the user: whether the Mac may ring now. The host owns permission and the rate limit. */
export interface QuietHours { start: string; end: string }
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00" };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validQuietHours(q: unknown): q is QuietHours {
  const v = q as QuietHours | null;
  return !!v && typeof v === "object" && typeof v.start === "string" && typeof v.end === "string" && HHMM.test(v.start) && HHMM.test(v.end);
}
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** [start, end) in local time; a window that wraps midnight (22:00–08:00) works; start = end is empty. */
export function inQuietHours(q: QuietHours | null, now: Date): boolean {
  if (!q || !validQuietHours(q)) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const s = minutes(q.start), e = minutes(q.end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Best effort: macOS keeps active Focus / Do Not Disturb assertions in this file while one is on (on
 * some versions it is absent entirely, or unreadable without Full Disk Access). Unreadable = off: the
 * notification itself is still silenced by macOS when a Focus is on.
 */
export function focusActive(home: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "Library/DoNotDisturb/DB/Assertions.json"), "utf8")) as { data?: { storeAssertionRecords?: unknown[] }[] };
    return (j.data ?? []).some((d) => Array.isArray(d.storeAssertionRecords) && d.storeAssertionRecords.length > 0);
  } catch {
    return false;
  }
}

export function ringPolicy(o: { quiet: QuietHours | null; focus: boolean; now: Date }): { ring: true } | { ring: false; why: string } {
  if (o.focus) return { ring: false, why: "Focus is on" };
  if (inQuietHours(o.quiet, o.now)) return { ring: false, why: "quiet hours" };
  return { ring: true };
}
