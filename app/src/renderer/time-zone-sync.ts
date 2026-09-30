import { callQuiet } from "./bridge";
import { nativeCall } from "./native";

/**
 * 0.1.4 first-run (code audit 6.1 / 6.2): the host in the Bots' computer keeps the zone it started with, and
 * nothing told it the Mac's, so "Auto" showed the Mac's zone while routines ran in the box's, and a trip to another
 * zone left every routine on the old clock. While connected, the Mac's zone is sent to the host at once, then again
 * whenever it changes (checked when the window gains focus and once a minute; the host reschedules on a change).
 */
export function startTimeZoneSync(o: { read?(): Promise<string>; send?(zone: string): Promise<unknown>; everyMs?: number; win?: Pick<Window, "addEventListener" | "removeEventListener"> } = {}): () => void {
  const read = o.read ?? (() => nativeCall<{ zone: string }>("system.timeZone").then((r) => r.zone));
  const send = o.send ?? ((zone: string) => callQuiet("setMacTimeZone", { zone }));
  const win = o.win ?? window;
  let last: string | null = null;
  let stopped = false;
  const check = () => {
    void read().then((zone) => {
      if (stopped || !zone || zone === last) return;
      last = zone;
      return send(zone);
    }).catch(() => { last = null; }); // asked again on the next check
  };
  check();
  const t = setInterval(check, o.everyMs ?? 60_000);
  win.addEventListener("focus", check);
  return () => { stopped = true; clearInterval(t); win.removeEventListener("focus", check); };
}
