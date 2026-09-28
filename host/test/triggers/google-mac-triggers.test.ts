import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDef } from "@synapse/shared";
import type { OneShotModel } from "../../helper-model/one-shot";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import { CalendarTriggers } from "../../triggers/calendar-triggers";
import { EmailTriggers, GOOGLE_MAIL_ACCOUNT } from "../../triggers/email/email-triggers";
import { GmailHistoryWatch, type GoogleGet } from "../../triggers/email/gmail-history";
import type { MailboxStore } from "../../triggers/email/mailboxes";
import type { MailMessage } from "../../triggers/email/query";
import type { EventQueue } from "../../triggers/event-queue";
import { MacFolderWatch } from "../../triggers/mac-folder";
import type { TriggerEvent } from "../../triggers/types";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 8, 21, 12)); });
afterEach(() => vi.useRealTimers());
const timers = { setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };

/** A Gmail API stand-in: history since an id, message metadata; counts every request. */
function fakeGmail() {
  const msgs: { id: string; labelIds: string[]; from: string; subject: string }[] = [];
  let history = 100;
  const calls: string[] = [];
  const get: GoogleGet = async <T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    calls.push(path);
    if (path === "/users/me/profile") return { historyId: String(history) } as T;
    if (path === "/users/me/history") {
      const since = Number(query.startHistoryId);
      const added = msgs.map((m, i) => ({ h: 101 + i, m })).filter((x) => x.h > since);
      return { historyId: String(history), history: added.map((x) => ({ id: String(x.h), messagesAdded: [{ message: { id: x.m.id, labelIds: x.m.labelIds } }] })) } as T;
    }
    const m = msgs.find((x) => path === `/users/me/messages/${x.id}`);
    if (!m) throw Object.assign(new Error("404"), { status: 404 });
    return { id: m.id, threadId: m.id, labelIds: m.labelIds, snippet: "hi", internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "To", value: "me@x.com" }] } } as T;
  };
  const add = (id: string, from: string, subject: string, labelIds = ["INBOX", "UNREAD"]) => { msgs.push({ id, labelIds, from, subject }); history = 100 + msgs.length; };
  return { get, add, calls };
}

describe("Gmail via the Google connector: history-id polling", () => {
  it("baselines, then fetches only new messages; an idle poll is one request and no model call", async () => {
    const g = fakeGmail();
    const got: MailMessage[] = [];
    const w = new GmailHistoryWatch({ source: () => g.get, onMessage: (m) => got.push(m), needsAttachments: () => false, now: () => Date.now(), ...timers });
    await w.pollOnce(); // baseline
    expect(g.calls).toEqual(["/users/me/profile"]);
    await w.pollOnce();
    expect(g.calls.slice(1)).toEqual(["/users/me/history"]);
    g.add("m1", "boss@acme.com", "Invoice due");
    g.add("m2", "news@list.com", "Weekly digest", ["CATEGORY_PROMOTIONS"]);
    await w.pollOnce();
    expect(got.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(got[0]).toMatchObject({ from: "boss@acme.com", subject: "Invoice due", folder: "INBOX", unread: true });
    await w.pollOnce();
    expect(got).toHaveLength(2);
  });

  it("an expired history id re-baselines instead of replaying the mailbox", async () => {
    const g = fakeGmail();
    let expired = false;
    const get: GoogleGet = async (p, q) => { if (expired && p === "/users/me/history") { expired = false; throw Object.assign(new Error("gone"), { status: 404 }); } return g.get(p, q); };
    const got: MailMessage[] = [];
    const w = new GmailHistoryWatch({ source: () => get, onMessage: (m) => got.push(m), needsAttachments: () => false, now: () => Date.now(), ...timers });
    await w.pollOnce();
    expired = true;
    g.add("m1", "a@b.c", "x");
    await w.pollOnce();
    expect(got).toEqual([]);
    g.add("m2", "a@b.c", "y");
    await w.pollOnce();
    expect(got.map((m) => m.id)).toEqual(["m2"]);
  });

  it("EmailTriggers routes the google account through history polling, filters in code, and never calls a model", async () => {
    const g = fakeGmail();
    const rec: RoutineRecord = { botId: "b1", id: "invoices", defHash: "h", def: { name: "Invoices", prompt: "p", enabled: true, createdAt: 0, trigger: { email: { account: GOOGLE_MAIL_ACCOUNT, query: "from:boss subject:invoice" } } } as RoutineDef };
    const store = { all: () => [rec], get: () => rec } as unknown as RoutineStore;
    const ingested: TriggerEvent[] = [];
    const queue = { ingest: (e: TriggerEvent) => { ingested.push(e); return []; } } as unknown as EventQueue;
    const model = { run: () => { throw new Error("no model call allowed"); } } as unknown as OneShotModel;
    const et = new EmailTriggers({ store, queue, mailboxes: {} as MailboxStore, model, now: () => Date.now(), ...timers, googleMail: () => g.get });
    et.sync();
    vi.advanceTimersByTime(60_000); await flush(); // baseline
    g.add("m1", "boss@acme.com", "Invoice 42");
    g.add("m2", "boss@acme.com", "Lunch?");
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested.map((e) => e.subject)).toEqual(["Invoice 42"]);
    expect(ingested[0]!.account).toBe(GOOGLE_MAIL_ACCOUNT);
    await et.stop();
  });
});

describe("calendar: an event starting in N minutes", () => {
  const T = Date.UTC(2026, 8, 21, 12, 0);
  const iso = (ms: number) => new Date(ms).toISOString();
  it("fires once per event occurrence at start − N minutes, filters titles in code, and catches up after a missed poll", async () => {
    const items = [
      { id: "e1", summary: "Design review", start: { dateTime: iso(T + 20 * 60_000) } },
      { id: "e2", summary: "Lunch", start: { dateTime: iso(T + 20 * 60_000) } },
      { id: "e3", summary: "All-day", start: { date: "2026-09-21" } },
    ];
    const calls: Record<string, string | number | undefined>[] = [];
    const get: GoogleGet = async <X>(_p: string, q: Record<string, string | number | undefined> = {}) => { calls.push(q); return { items } as X; };
    const rec: RoutineRecord = { botId: "b1", id: "prep", defHash: "h", def: { name: "Prep", prompt: "p", enabled: true, createdAt: 0, trigger: { calendar: { minutesBefore: 10, match: "review" } } } as RoutineDef };
    const store = { all: () => [rec] } as unknown as RoutineStore;
    const ingested: { ev: TriggerEvent; only?: { botId: string; routineId: string } }[] = [];
    const queue = { ingest: (ev: TriggerEvent, only?: { botId: string; routineId: string }) => { ingested.push({ ev, only }); return []; } } as unknown as EventQueue;
    const ct = new CalendarTriggers({ store, queue, source: () => get, now: () => Date.now(), ...timers });
    ct.sync();
    vi.advanceTimersByTime(60_000); await flush(); // 12:01, fires at 12:10
    expect(ingested).toEqual([]);
    vi.setSystemTime(T + 11 * 60_000); // the Mac slept through 12:10
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.ev).toMatchObject({ source: "calendar", subject: "Design review", eventId: `e1@${iso(T + 20 * 60_000)}` });
    expect(ingested[0]!.ev.raw).toMatchObject({ minutesBefore: 10, calendarId: "primary" });
    expect(ingested[0]!.only).toEqual({ botId: "b1", routineId: "prep" });
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested).toHaveLength(1);
    ct.stop();
  });

  it("does nothing (no request) without a calendar routine or without Google", async () => {
    let n = 0;
    const get: GoogleGet = async <X>() => { n++; return { items: [] } as X; };
    const ct = new CalendarTriggers({ store: { all: () => [] } as unknown as RoutineStore, queue: {} as EventQueue, source: () => get, now: () => Date.now(), ...timers });
    ct.sync();
    vi.advanceTimersByTime(5 * 60_000); await flush();
    expect(n).toBe(0);
  });
});

describe("Mac folder watch over the local bridge", () => {
  it("lists the folder each poll and emits created/deleted file events for mac: paths only while the Mac is reachable", async () => {
    let listing = "a.pdf\nold.txt";
    let up = true;
    const requests: string[] = [];
    const list = async (p: string) => { requests.push(p); return up ? listing : null; };
    const rec: RoutineRecord = { botId: "b1", id: "dl", defHash: "h", def: { name: "Downloads", prompt: "p", enabled: true, createdAt: 0, trigger: { file: { paths: ["mac:~/Downloads", "inbox"], events: ["created", "deleted"] } } } as RoutineDef };
    const ingested: TriggerEvent[] = [];
    const queue = { ingest: (e: TriggerEvent) => { ingested.push(e); return []; } } as unknown as EventQueue;
    const w = new MacFolderWatch({ store: { all: () => [rec] } as unknown as RoutineStore, queue, list, now: () => Date.now(), ...timers });
    w.sync();
    vi.advanceTimersByTime(60_000); await flush(); // baseline, nothing emitted
    expect(requests).toEqual(["~/Downloads"]);
    listing = "a.pdf\nnew.pdf\nsub/";
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested.map((e) => `${e.kind} ${e.path}`)).toEqual(["created mac:~/Downloads/new.pdf", "deleted mac:~/Downloads/old.txt"]);
    up = false;
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested).toHaveLength(2);
    w.stop();
  });
});
