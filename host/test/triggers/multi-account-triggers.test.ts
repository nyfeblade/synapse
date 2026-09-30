import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDef, Trigger } from "@synapse/shared";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import { CalendarTriggers } from "../../triggers/calendar-triggers";
import { EmailTriggers, GOOGLE_MAIL_ACCOUNT } from "../../triggers/email/email-triggers";
import type { GoogleGet } from "../../triggers/email/gmail-history";
import type { MailboxStore } from "../../triggers/email/mailboxes";
import type { EventQueue } from "../../triggers/event-queue";
import { matchesTrigger } from "../../triggers/match";
import type { TriggerEvent } from "../../triggers/types";

// 4.3b: mail and calendar triggers watch every Google account a Bot is granted: one poll per account shared by every
// Bot, a routine may name one account, and the wake says which account.

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 8, 21, 12)); });
afterEach(() => vi.useRealTimers());
const timers = { setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };
const ACCOUNTS = [{ id: "g1", email: "me@example.com" }, { id: "g2", email: "work@acme.example" }];

/** One fake mailbox per account; counts requests per account. */
function gmails() {
  const boxes = new Map<string, { msgs: { id: string; from: string; subject: string }[]; calls: string[] }>();
  for (const a of ACCOUNTS) boxes.set(a.id, { msgs: [], calls: [] });
  const get = (acc: string): GoogleGet => async <T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    const b = boxes.get(acc)!;
    b.calls.push(path);
    const history = 100 + b.msgs.length;
    if (path === "/users/me/profile") return { historyId: String(history) } as T;
    if (path === "/users/me/history") {
      const added = b.msgs.map((m, i) => ({ h: 101 + i, m })).filter((x) => x.h > Number(query.startHistoryId));
      return { historyId: String(history), history: added.map((x) => ({ id: String(x.h), messagesAdded: [{ message: { id: x.m.id, labelIds: ["INBOX", "UNREAD"] } }] })) } as T;
    }
    const m = b.msgs.find((x) => path === `/users/me/messages/${x.id}`)!;
    return { id: m.id, threadId: m.id, labelIds: ["INBOX", "UNREAD"], snippet: "hi", internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }] } } as T;
  };
  return { get, add: (acc: string, id: string, from: string, subject: string) => boxes.get(acc)!.msgs.push({ id, from, subject }), calls: (acc: string) => boxes.get(acc)!.calls };
}
const routine = (botId: string, id: string, trigger: Trigger): RoutineRecord => ({ botId, id, defHash: "h", def: { name: id, prompt: "p", enabled: true, createdAt: 0, trigger } as RoutineDef });

describe("4.3b: mail triggers on every granted Google account", () => {
  it("one poll per account shared across Bots; each Bot hears only its granted accounts; a routine can name one; the wake names the account", async () => {
    const g = gmails();
    const grants: Record<string, string[]> = { b1: ["g1", "g2"], b2: ["g2"] };
    const recs = [
      routine("b1", "all", { email: { account: GOOGLE_MAIL_ACCOUNT, query: "subject:invoice" } }),
      routine("b1", "work-only", { email: { account: GOOGLE_MAIL_ACCOUNT, query: "subject:invoice", googleAccount: "WORK@acme.example" } }),
      routine("b2", "b2-all", { email: { account: GOOGLE_MAIL_ACCOUNT, query: "subject:invoice" } }),
    ];
    const ingested: { ev: TriggerEvent; only: { routineId: string } }[] = [];
    const queue = { ingest: (ev: TriggerEvent, only: { routineId: string }) => { ingested.push({ ev, only }); return []; } } as unknown as EventQueue;
    const et = new EmailTriggers({
      store: { all: () => recs } as unknown as RoutineStore, queue, mailboxes: {} as MailboxStore, model: null, now: () => Date.now(), ...timers,
      googleMail: (acc) => g.get(acc!), googleAccounts: () => ACCOUNTS, googleAllowed: (b, acc) => (grants[b] ?? []).includes(acc!),
    });
    et.sync();
    vi.advanceTimersByTime(60_000); await flush(); // baselines
    expect([g.calls("g1").length, g.calls("g2").length]).toEqual([1, 1]); // one poll each, for three routines
    g.add("g1", "m1", "boss@me.example", "Invoice personal");
    g.add("g2", "m2", "boss@acme.example", "Invoice work");
    vi.advanceTimersByTime(60_000); await flush();
    const got = ingested.map((x) => `${x.only.routineId}:${x.ev.subject}:${String(x.ev.raw.googleAccount)}`).sort();
    expect(got).toEqual(["all:Invoice personal:me@example.com", "all:Invoice work:work@acme.example", "b2-all:Invoice work:work@acme.example", "work-only:Invoice work:work@acme.example"]);
    expect(ingested[0]!.ev.text.split("\n")[0]).toMatch(/^account: /);
    // Un-ticking an account stops its routines at once, before any resync.
    grants.b1 = ["g1"];
    g.add("g2", "m3", "boss@acme.example", "Invoice again");
    vi.advanceTimersByTime(60_000); await flush();
    expect(ingested.filter((x) => x.ev.subject === "Invoice again").map((x) => x.only.routineId)).toEqual(["b2-all"]);
    await et.stop();
  });

  it("matching: a routine that names an account matches only that account's events", () => {
    const t: Trigger = { email: { account: GOOGLE_MAIL_ACCOUNT, query: "q", googleAccount: "work@acme.example" } };
    const ev = (googleAccount: string): TriggerEvent => ({ source: "email", eventId: "x", occurredAt: 10, account: GOOGLE_MAIL_ACCOUNT, channel: "INBOX", subject: "s", text: "", raw: { query: "q", googleAccount } } as TriggerEvent);
    expect(matchesTrigger(t, ev("work@acme.example"), { savedAt: 0 } as never)).toBe(true);
    expect(matchesTrigger(t, ev("me@example.com"), { savedAt: 0 } as never)).toBe(false);
  });
});

describe("4.3b: calendar triggers on every granted Google account", () => {
  it("reads each account's calendar once per poll and fires for the Bots it is granted to, naming the account", async () => {
    const T = Date.UTC(2026, 8, 21, 12, 0);
    const start = new Date(T + 15 * 60_000).toISOString();
    const reads: string[] = [];
    const source = (acc?: string): GoogleGet => async <X>() => { reads.push(acc!); return { items: [{ id: `e-${acc}`, summary: `Sync ${acc}`, start: { dateTime: start } }] } as X; };
    const grants: Record<string, string[]> = { b1: ["g1", "g2"], b2: ["g1"] };
    const recs = [routine("b1", "any", { calendar: { minutesBefore: 20 } }), routine("b1", "work", { calendar: { minutesBefore: 20, account: "work@acme.example" } }), routine("b2", "b2", { calendar: { minutesBefore: 20 } })];
    const ingested: { ev: TriggerEvent; only: { routineId: string } }[] = [];
    const queue = { ingest: (ev: TriggerEvent, only: { routineId: string }) => { ingested.push({ ev, only }); return []; } } as unknown as EventQueue;
    const ct = new CalendarTriggers({ store: { all: () => recs } as unknown as RoutineStore, queue, source, accounts: () => ACCOUNTS, allowed: (b, acc) => (grants[b] ?? []).includes(acc!), now: () => Date.now(), ...timers });
    ct.sync();
    vi.advanceTimersByTime(60_000); await flush();
    expect(reads.sort()).toEqual(["g1", "g2"]);
    expect(ingested.map((x) => `${x.only.routineId}:${String(x.ev.raw.account)}`).sort()).toEqual(["any:me@example.com", "any:work@acme.example", "b2:me@example.com", "work:work@acme.example"]);
    expect(ingested[0]!.ev.text.split("\n")[0]).toMatch(/^account: /);
    ct.stop();
  });
});
