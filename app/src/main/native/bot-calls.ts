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
 * macOS keeps active Focus / Do Not Disturb assertions in this file while one is on. "unknown" when it can't be
 * read: without Full Disk Access (the usual case for an app) the folder is closed to us, and a file that doesn't
 * parse proves nothing either.
 *
 * 0.1.4 first-run (code audit 1.2): unreadable used to count as OFF, so the app played its own ring through a
 * Focus. Unknown now rings quietly: no ring tone of the app's own while it isn't in front, and a notification with
 * sound that macOS itself holds back during a Focus.
 */
export type FocusState = "on" | "off" | "unknown";
export function focusState(home: string): FocusState {
  const dir = path.join(home, "Library/DoNotDisturb/DB");
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "Assertions.json"), "utf8")) as { data?: { storeAssertionRecords?: unknown[] }[] };
    return (j.data ?? []).some((d) => Array.isArray(d.storeAssertionRecords) && d.storeAssertionRecords.length > 0) ? "on" : "off";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    // No assertions file: off, but only when the folder itself can be read (else we simply can't see it).
    try { fs.readdirSync(dir); return "off"; } catch { return "unknown"; }
  }
}

/** True only when a Focus is known to be on. */
export function focusActive(home: string): boolean {
  return focusState(home) === "on";
}

/** `sound`: the app may play its own ring. False while the Focus state can't be read (macOS decides instead). */
export function ringPolicy(o: { quiet: QuietHours | null; focus: FocusState | boolean; now: Date }): { ring: true; sound: boolean } | { ring: false; why: string } {
  const focus: FocusState = o.focus === true ? "on" : o.focus === false ? "off" : o.focus;
  if (focus === "on") return { ring: false, why: "Focus is on" };
  if (inQuietHours(o.quiet, o.now)) return { ring: false, why: "quiet hours" };
  return { ring: true, sound: focus === "off" };
}
