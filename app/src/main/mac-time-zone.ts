import fs from "node:fs";

/**
 * 0.1.4 first-run: the Mac's time zone as it is NOW. /etc/localtime is the system's link to its zone file
 * (…/zoneinfo/America/New_York), changed by macOS the moment the zone changes; Intl in this long-running process
 * keeps the zone it started with, so it is only the fallback.
 */
export function macTimeZone(readlink: (p: string) => string = (p) => fs.readlinkSync(p)): string {
  try {
    const m = /zoneinfo\/(.+)$/.exec(readlink("/etc/localtime"));
    if (m) {
      new Intl.DateTimeFormat("en-US", { timeZone: m[1] }); // throws on a name ICU doesn't know
      return m[1]!;
    }
  } catch { /* not a link, or an unknown name: the fallback */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
