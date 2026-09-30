import { LIMITS, LIMITS_SCHED, type Trigger } from "@synapse/shared";
import type { RoutineStore } from "../routines/routine-store";
import { log } from "../util/log";
import type { GoogleGet } from "./email/gmail-history";
import type { GoogleAccountRef } from "./email/email-triggers";
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
    /** 4.3b: for one account (default: the first). */
    source(accountId?: string): GoogleGet | null;
    /** 4.3b: every connected Google account; each calendar is read once per account per poll, for every Bot. */
    accounts?(): GoogleAccountRef[];
    /** Per-Bot scoping: only Bots with the Google connector turned on get calendar triggers. 4.3b: with an account
     *  id, only Bots that account is granted to. */
    allowed?(botId: string, accountId?: string): boolean;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    everyMs?: number;
  }) {}

  /** Bug 115: false after LIMITS.imapFailHealthAfter failed polls of this calendar in a row (4.3b: on any account). */
  calendarReachable(calendarId: string): boolean {
    for (const [k, n] of this.fails) if ((k === calendarId || k.endsWith(`|${calendarId}`)) && n >= LIMITS.imapFailHealthAfter) return false;
    return true;
  }

  sync(): void {
    this.subs = this.d.store.all().filter((r) => r.def.enabled && r.def.trigger).flatMap((r) => calTriggersOf(r.def.trigger!).map((t) => ({ botId: r.botId, routineId: r.id, t })));
    const cals = new Set(this.subs.map((s) => s.t.calendarId ?? "primary"));
    for (const k of [...this.fails.keys()]) if (!cals.has(k.slice(k.lastIndexOf("|") + 1))) this.fails.delete(k);
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

  /**
   * 4.3b: every connected Google account in turn (one events.list per calendar per account per poll, shared by every
   * Bot), for the routines of the Bots that account is granted to; a routine naming an account hears only that one.
   */
  async pollOnce(): Promise<number> {
    if (!this.subs.length) return 0;
    let n = 0;
    for (const a of this.d.accounts?.() ?? [{ id: "", email: null }]) n += await this.pollAccount(a);
    for (const [k, start] of this.fired) if (start < this.d.now() - 86_400_000) this.fired.delete(k);
    return n;
  }

  private async pollAccount(a: GoogleAccountRef): Promise<number> {
    const get = this.d.source(a.id || undefined);
    if (!get) return 0;
    const now = this.d.now();
    const every = this.d.everyMs ?? LIMITS_SCHED.calendarPollMs;
    const byCal = new Map<string, Sub[]>();
    const mine = (x: Sub) => this.d.allowed?.(x.botId, a.id || undefined) !== false && (!x.t.account || (!!a.email && x.t.account.toLowerCase() === a.email.toLowerCase()));
    for (const s of this.subs.filter(mine)) byCal.set(s.t.calendarId ?? "primary", [...(byCal.get(s.t.calendarId ?? "primary") ?? []), s]);
    let n = 0;
    for (const [calendarId, subs] of byCal) {
      const failKey = a.id ? `${a.id}|${calendarId}` : calendarId;
      const lead = Math.max(...subs.map((s) => s.t.minutesBefore)) * 60_000;
      let res: { items?: CalEvent[] };
      try {
        res = await get<{ items?: CalEvent[] }>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
          timeMin: new Date(now).toISOString(), timeMax: new Date(now + lead + 2 * every).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: 50,
        });
      } catch (e) {
        // Bug 115: retried next poll; after N in a row RoutineHealth says so on each routine's row, with a tray entry.
        this.noteFails(failKey, subs, (this.fails.get(failKey) ?? 0) + 1);
        log.warn("calendar trigger poll failed", { calendarId, routineIds: subs.map((s) => s.routineId), error: String((e as Error).message ?? e).slice(0, 200) });
        continue;
      }
      this.noteFails(failKey, subs, 0);
      for (const e of res.items ?? []) {
        const startIso = e.start?.dateTime;
        if (!startIso || e.status === "cancelled") continue; // all-day events have no start time to count down to
        const start = Date.parse(startIso);
        if (!(start > now)) continue;
        for (const s of subs) {
          const at = start - s.t.minutesBefore * 60_000;
          if (at > now || now - at > GRACE_MS) continue;
          if (!calendarTitleMatches(s.t.match, e.summary)) continue; // in code: a non-matching event wakes nothing
          const key = `${s.botId}/${s.routineId}/${a.id}/${e.id}@${startIso}`;
          if (this.fired.has(key)) continue;
          this.fired.set(key, start);
          this.d.queue.ingest(this.event(e, startIso, calendarId, s.t.minutesBefore, now, a.email), { botId: s.botId, routineId: s.routineId });
          n++;
        }
      }
    }
    return n;
  }

  private noteFails(key: string, subs: Sub[], n: number): void {
    const before = this.fails.get(key) ?? 0;
    if (n === 0) this.fails.delete(key); else this.fails.set(key, n);
    const was = before >= LIMITS.imapFailHealthAfter;
    if (was !== n >= LIMITS.imapFailHealthAfter) this.onHealthChange?.([...new Set(subs.map((s) => s.botId))]);
  }

  private event(e: CalEvent, startIso: string, calendarId: string, minutesBefore: number, now: number, account: string | null): TriggerEvent {
    const title = (e.summary ?? "(no title)").slice(0, 300);
    return {
      source: "calendar", eventId: `${e.id}@${startIso}`, occurredAt: now, subject: title, url: e.htmlLink,
      // 4.3b: the wake says which of the owner's Google accounts the event is on.
      text: [...(account ? [`account: ${account}`] : []), `title: ${title}`, `starts: ${startIso}`, `in: ${minutesBefore} minutes`, ...(e.location ? [`location: ${e.location.slice(0, 200)}`] : [])].join("\n"),
      raw: { calendarId, minutesBefore, eventId: e.id, start: startIso, ...(account ? { account } : {}) },
    };
  }
}
