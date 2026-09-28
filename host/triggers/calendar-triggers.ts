import { LIMITS, LIMITS_SCHED, type Trigger } from "@synapse/shared";
import type { RoutineStore } from "../routines/routine-store";
import { log } from "../util/log";
import type { GoogleGet } from "./email/gmail-history";
import { calendarTitleMatches } from "./match";
import type { EventQueue } from "./event-queue";
import type { TriggerEvent } from "./types";

type CalTrigger = Extract<Trigger, { calendar: unknown }>["calendar"];
interface Sub { botId: string; routineId: string; t: CalTrigger }
interface CalEvent { id: string; summary?: string; status?: string; start?: { dateTime?: string; date?: string }; location?: string; htmlLink?: string }

function calTriggersOf(t: Trigger): CalTrigger[] {
  if ("group" in t) return t.group.listeners.flatMap(calTriggersOf);
  return "calendar" in t ? [t.calendar] : [];
}

/** How far back a missed fire time still fires (the Mac slept through it) — never for an event that already started. */
const GRACE_MS = 30 * 60_000;

/**
 * "An event starts in N minutes" through the built-in Google connector. One events.list per calendar per poll, only while
 * a calendar routine exists; titles are matched in code (match.ts), so no model wakes unless an event qualifies. Each
 * (event, start time) fires once; a fire time missed while asleep fires on the next poll unless the event already began.
 */
export class CalendarTriggers {
  private subs: Sub[] = [];
  private timer: unknown = null;
  private fired = new Map<string, number>();
  /** Bug 115: consecutive failed events.list calls per calendar; RoutineHealth reads it through calendarReachable. */
  private fails = new Map<string, number>();
  /** Bug 115: a calendar crossed the failure threshold, or read again after it (phase4 re-checks the rows). */
  onHealthChange: ((botIds: string[]) => void) | undefined;

  constructor(private d: {
    store: RoutineStore;
    queue: EventQueue;
    source(): GoogleGet | null;
    /** Per-Bot scoping: only Bots with the Google connector turned on get calendar triggers. */
    allowed?(botId: string): boolean;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    everyMs?: number;
  }) {}

  /** Bug 115: false after LIMITS.imapFailHealthAfter failed polls of this calendar in a row. */
  calendarReachable(calendarId: string): boolean {
    return (this.fails.get(calendarId) ?? 0) < LIMITS.imapFailHealthAfter;
  }

  sync(): void {
    this.subs = this.d.store.all().filter((r) => r.def.enabled && r.def.trigger).flatMap((r) => calTriggersOf(r.def.trigger!).map((t) => ({ botId: r.botId, routineId: r.id, t })));
    const cals = new Set(this.subs.map((s) => s.t.calendarId ?? "primary"));
    for (const k of [...this.fails.keys()]) if (!cals.has(k)) this.fails.delete(k);
    if (this.subs.length && this.timer === null) this.arm();
    if (!this.subs.length) this.stop();
  }

  stop(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.timer = this.d.setTimer(() => {
      void this.pollOnce()
        .catch((e) => log.warn("calendar trigger poll crashed", { error: String((e as Error).message ?? e).slice(0, 200) }))
        .finally(() => { if (this.timer !== null && this.subs.length) this.arm(); else this.timer = null; });
    }, this.d.everyMs ?? LIMITS_SCHED.calendarPollMs);
  }

  async pollOnce(): Promise<number> {
    const get = this.d.source();
    if (!get || !this.subs.length) return 0;
    const now = this.d.now();
    const every = this.d.everyMs ?? LIMITS_SCHED.calendarPollMs;
    const byCal = new Map<string, Sub[]>();
    for (const s of this.subs.filter((x) => this.d.allowed?.(x.botId) !== false)) byCal.set(s.t.calendarId ?? "primary", [...(byCal.get(s.t.calendarId ?? "primary") ?? []), s]);
    let n = 0;
    for (const [calendarId, subs] of byCal) {
      const lead = Math.max(...subs.map((s) => s.t.minutesBefore)) * 60_000;
      let res: { items?: CalEvent[] };
      try {
        res = await get<{ items?: CalEvent[] }>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
          timeMin: new Date(now).toISOString(), timeMax: new Date(now + lead + 2 * every).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: 50,
        });
      } catch (e) {
        // Bug 115: retried next poll; after N in a row RoutineHealth says so on each routine's row, with a tray entry.
        this.noteFails(calendarId, subs, (this.fails.get(calendarId) ?? 0) + 1);
        log.warn("calendar trigger poll failed", { calendarId, routineIds: subs.map((s) => s.routineId), error: String((e as Error).message ?? e).slice(0, 200) });
        continue;
      }
      this.noteFails(calendarId, subs, 0);
      for (const e of res.items ?? []) {
        const startIso = e.start?.dateTime;
        if (!startIso || e.status === "cancelled") continue; // all-day events have no start time to count down to
        const start = Date.parse(startIso);
        if (!(start > now)) continue;
        for (const s of subs) {
          const at = start - s.t.minutesBefore * 60_000;
          if (at > now || now - at > GRACE_MS) continue;
          if (!calendarTitleMatches(s.t.match, e.summary)) continue; // in code: a non-matching event wakes nothing
          const key = `${s.botId}/${s.routineId}/${e.id}@${startIso}`;
          if (this.fired.has(key)) continue;
          this.fired.set(key, start);
          this.d.queue.ingest(this.event(e, startIso, calendarId, s.t.minutesBefore, now), { botId: s.botId, routineId: s.routineId });
          n++;
        }
      }
    }
    for (const [k, start] of this.fired) if (start < now - 86_400_000) this.fired.delete(k);
    return n;
  }

  private noteFails(calendarId: string, subs: Sub[], n: number): void {
    const before = this.fails.get(calendarId) ?? 0;
    if (n === 0) this.fails.delete(calendarId); else this.fails.set(calendarId, n);
    const was = before >= LIMITS.imapFailHealthAfter;
    if (was !== n >= LIMITS.imapFailHealthAfter) this.onHealthChange?.([...new Set(subs.map((s) => s.botId))]);
  }

  private event(e: CalEvent, startIso: string, calendarId: string, minutesBefore: number, now: number): TriggerEvent {
    const title = (e.summary ?? "(no title)").slice(0, 300);
    return {
      source: "calendar", eventId: `${e.id}@${startIso}`, occurredAt: now, subject: title, url: e.htmlLink,
      text: [`title: ${title}`, `starts: ${startIso}`, `in: ${minutesBefore} minutes`, ...(e.location ? [`location: ${e.location.slice(0, 200)}`] : [])].join("\n"),
      raw: { calendarId, minutesBefore, eventId: e.id, start: startIso },
    };
  }
}
