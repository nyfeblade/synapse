import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayError } from "../../gateway/errors";
import type { OneShotModel, OneShotRequest } from "../../helper-model/one-shot";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import { EmailTriggers, emailEvent } from "../../triggers/email/email-triggers";
import { ImapIdleWatcher, backoffMs, type ImapLike } from "../../triggers/email/imap-idle";
import { MailboxStore, emailHandlers } from "../../triggers/email/mailboxes";
import type { MailMessage } from "../../triggers/email/query";
import type { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";
import { tmpConfig } from "../helpers";

const flush = () => new Promise((r) => setImmediate(r));
const msg = (uid: number, over: Partial<MailMessage> = {}): MailMessage & { uid: number } => ({
  uid, id: String(uid), messageId: `<m${uid}@x>`, from: "boss@acme.com", to: ["me@x.com"], subject: `Mail ${uid}`, date: Date.now(), text: "hello", unread: true, folder: "INBOX", labels: [], attachments: [], ...over,
});

class FakeImap implements ImapLike {
  connects = 0; failConnects = 0; idleCalls = 0; stopIdles = 0; uidNext = 5;
  msgs: (MailMessage & { uid: number })[] = [];
  exists: (() => void) | null = null;
  closed: ((e?: Error) => void) | null = null;
  async connect() { this.connects++; if (this.failConnects > 0) { this.failConnects--; throw new Error("ECONNREFUSED"); } }
  async openFolder() { return { uidNext: this.uidNext }; }
  async fetchSince(uid: number) { return this.msgs.filter((m) => m.uid >= uid); }
  idle() { this.idleCalls++; return new Promise<unknown>(() => {}); }
  stopIdle() { this.stopIdles++; }
  onExists(cb: () => void) { this.exists = cb; }
  onClose(cb: (e?: Error) => void) { this.closed = cb; }
  async close() {}
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 8, 19, 12)); });
afterEach(() => vi.useRealTimers());

const timers = { setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };

describe("ImapIdleWatcher", () => {
  it("only new mail counts, fetches on exists, re-issues IDLE every 25 min, reconnects with backoff", async () => {
    const c = new FakeImap();
    const got: MailMessage[] = [];
    const w = new ImapIdleWatcher({ client: () => c, folder: "INBOX", onMessage: (m) => got.push(m), ...timers });
    c.msgs.push(msg(3));
    w.start();
    await flush();
    expect(c.idleCalls).toBe(1);
    c.msgs.push(msg(5));
    c.exists!();
    await flush();
    expect(got.map((m) => m.messageId)).toEqual(["<m5@x>"]);
    vi.advanceTimersByTime(25 * 60_000);
    expect(c.stopIdles).toBe(1);
    expect(c.idleCalls).toBe(2);

    c.failConnects = 2;
    c.msgs.push(msg(6));
    c.closed!(new Error("socket hang up"));
    vi.advanceTimersByTime(4999);
    expect(c.connects).toBe(1);
    vi.advanceTimersByTime(1); await flush();
    expect(c.connects).toBe(2);
    vi.advanceTimersByTime(10_000); await flush();
    expect(c.connects).toBe(3);
    vi.advanceTimersByTime(20_000); await flush(); await flush();
    expect(c.connects).toBe(4);
    expect(got.map((m) => m.messageId)).toEqual(["<m5@x>", "<m6@x>"]);
    await w.stop();
  });
  it("backoff doubles from 5 s and caps at 5 min", () => {
    expect([0, 1, 2, 3, 6, 10].map(backoffMs)).toEqual([5000, 10_000, 20_000, 40_000, 300_000, 300_000]);
  });

  it("counts consecutive connect failures and clears them on a successful reconnect (bug 51)", async () => {
    const c = new FakeImap();
    const seen: number[] = [];
    const w = new ImapIdleWatcher({ client: () => c, folder: "INBOX", onMessage: () => {}, onFailures: (n) => seen.push(n), ...timers });
    w.start();
    await flush();
    expect(w.consecutiveFailures()).toBe(0);
    c.failConnects = 2;
    c.closed!(new Error("socket hang up"));
    vi.advanceTimersByTime(5_000); await flush();
    vi.advanceTimersByTime(10_000); await flush();
    expect(w.consecutiveFailures()).toBe(3);
    expect(seen).toContain(3);
    vi.advanceTimersByTime(20_000); await flush();
    expect(w.consecutiveFailures()).toBe(0);
    expect(seen.at(-1)).toBe(0);
    await w.stop();
  });
});

describe("EmailTriggers and mailboxes", () => {
  it("stores mailbox secrets 0600 under connector-secrets and lists them without the password", () => {
    const cfg = tmpConfig();
    const m = new MailboxStore(cfg);
    let changed = 0;
    const h = emailHandlers(m, () => changed++);
    const res = h.addMailbox!({ id: "b1", label: "work", host: "imap.fastmail.com", port: 993, user: "me@x.com", appPassword: "app-pass" }) as { mailboxes: unknown };
    expect(res).toEqual({ mailboxes: [{ label: "work", host: "imap.fastmail.com", user: "me@x.com" }] });
    const file = `${cfg.hostPrivate}/connector-secrets/b1/imap-work.json`;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(m.secret("b1", "work")?.appPassword).toBe("app-pass");
    expect(changed).toBe(1);
    expect(() => m.add("b1", { label: "bad label", host: "h", port: 993, user: "u", appPassword: "p" })).toThrow("Mailbox label");
  });

  it("rejects unsafe bot ids the same way botDir() does, before touching the filesystem (finding: task-20 fix round 1)", () => {
    const cfg = tmpConfig();
    const m = new MailboxStore(cfg);
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
        return "";
      } catch (e) {
        return (e as GatewayError).code;
      }
    };
    const secret = { label: "work", host: "h", port: 993, user: "u", appPassword: "p" };
    for (const bad of ["../etc", "..", "", "a/b", "a\\b"]) {
      expect(codeOf(() => m.add(bad, secret))).toBe("INVALID_BOT_ID");
      expect(codeOf(() => m.list(bad))).toBe("INVALID_BOT_ID");
      expect(codeOf(() => m.secret(bad, "work"))).toBe("INVALID_BOT_ID");
    }
    // No file escaped connector-secrets/<validBotId>/ for the traversal attempt.
    expect(fs.existsSync(path.join(cfg.hostPrivate, "connector-secrets", "etc"))).toBe(false);
  });

  it("matches IMAP mail locally per routine and ingests with raw.query; a claude.ai Gmail routine never polls (synapse-public)", async () => {
    const cfg = tmpConfig();
    const mailboxes = new MailboxStore(cfg);
    mailboxes.add("b1", { label: "work", host: "h", port: 993, user: "u", appPassword: "p" });
    const recs: RoutineRecord[] = [
      { botId: "b1", id: "boss", defHash: "h", def: { name: "Boss", prompt: "p", trigger: { email: { account: "work", query: "from:boss" } }, enabled: true, createdAt: 0 } },
      { botId: "b1", id: "all", defHash: "h", def: { name: "All", prompt: "p", trigger: { email: { account: "work", query: "" } }, enabled: true, createdAt: 0 } },
      { botId: "b1", id: "gm", defHash: "h", def: { name: "Gm", prompt: "p", trigger: { email: { account: "claude-gmail", query: "is:unread" } }, enabled: true, createdAt: 0 } },
    ];
    const ingested: { ev: TriggerEvent; routineId: string }[] = [];
    const queue = { ingest: (ev: TriggerEvent, only: { routineId: string }) => { ingested.push({ ev, routineId: only.routineId }); return []; } } as unknown as EventQueue;
    const clients: FakeImap[] = [];
    let polls = 0;
    const model: OneShotModel = { run: async <T,>() => { polls++; return { messages: [] } as T; } };
    const et = new EmailTriggers({
      store: { all: () => recs } as unknown as RoutineStore, queue, mailboxes, model, now: () => Date.now(), ...timers,
      imapFactory: () => { const c = new FakeImap(); clients.push(c); return c; },
    });
    et.sync();
    await flush();
    expect(clients).toHaveLength(1); // one IDLE connection for both "work" routines
    clients[0]!.msgs.push(msg(5, { from: "Boss <boss@acme.com>" }), msg(6, { from: "news@list.com" }));
    clients[0]!.exists!();
    await flush();
    expect(ingested.map((i) => `${i.routineId}:${i.ev.eventId}`).sort()).toEqual(["all:<m5@x>", "all:<m6@x>", "boss:<m5@x>"]);
    expect(ingested.find((i) => i.routineId === "boss")!.ev).toMatchObject({ source: "email", account: "work", channel: "INBOX", raw: { query: "from:boss" } });
    vi.advanceTimersByTime(15 * 60_000); await flush();
    expect(polls).toBe(0); // no model call through a claude.ai connector
    await et.stop();
  });

  it("after N IMAP connect failures the mailbox is not reachable (bug 51)", async () => {
    const cfg = tmpConfig();
    const mailboxes = new MailboxStore(cfg);
    mailboxes.add("b1", { label: "work", host: "h", port: 993, user: "u", appPassword: "p" });
    const recs: RoutineRecord[] = [
      { botId: "b1", id: "boss", defHash: "h", def: { name: "Boss", prompt: "p", trigger: { email: { account: "work", query: "from:boss" } }, enabled: true, createdAt: 0 } },
    ];
    const et = new EmailTriggers({
      store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: () => [] } as unknown as EventQueue,
      mailboxes, model: null, now: () => Date.now(), ...timers,
      imapFactory: () => { const c = new FakeImap(); c.failConnects = 99; return c; },
    });
    et.sync();
    await flush();
    expect(et.mailboxReachable("b1", "work"), "the first refused connect is still a retry, not a row that claims it is down").toBe(true);
    vi.advanceTimersByTime(5_000); await flush();
    vi.advanceTimersByTime(10_000); await flush();
    expect(et.mailboxReachable("b1", "work")).toBe(false);
    await et.stop();
  });

  it("re-entering an unreachable mailbox's credentials reconnects with the new ones and clears the row (bug 51)", async () => {
    // The unreachable row tells the user to add the mailbox again under the same name. That action has
    // to actually work: a watcher that keeps retrying with the password it was built with never recovers.
    const cfg = tmpConfig();
    const mailboxes = new MailboxStore(cfg);
    mailboxes.add("b1", { label: "work", host: "h", port: 993, user: "u", appPassword: "wrong" });
    const recs: RoutineRecord[] = [
      { botId: "b1", id: "boss", defHash: "h", def: { name: "Boss", prompt: "p", trigger: { email: { account: "work", query: "from:boss" } }, enabled: true, createdAt: 0 } },
    ];
    const healthFor: string[][] = [];
    const et = new EmailTriggers({
      store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: () => [] } as unknown as EventQueue,
      mailboxes, model: null, now: () => Date.now(), ...timers,
      imapFactory: (s) => { const c = new FakeImap(); if (s.appPassword === "wrong") c.failConnects = 99; return c; },
      onHealthChange: (ids) => healthFor.push(ids),
    });
    et.sync();
    await flush();
    vi.advanceTimersByTime(5_000); await flush();
    vi.advanceTimersByTime(10_000); await flush();
    expect(et.mailboxReachable("b1", "work")).toBe(false);
    healthFor.length = 0;

    emailHandlers(mailboxes, () => et.sync()).addMailbox!({ id: "b1", label: "work", host: "h", port: 993, user: "u", appPassword: "right" });
    await flush(); await flush();
    expect(et.mailboxReachable("b1", "work"), "the fixed password was never tried: the row stays 'can't reach' forever").toBe(true);
    expect(healthFor, "the routine's row is not republished, so it keeps saying the mailbox is unreachable").toContainEqual(["b1"]);
    await et.stop();
  });

  it("an unchanged mailbox is not reconnected by an unrelated re-sync (must not fire)", async () => {
    const cfg = tmpConfig();
    const mailboxes = new MailboxStore(cfg);
    mailboxes.add("b1", { label: "work", host: "h", port: 993, user: "u", appPassword: "p" });
    const recs: RoutineRecord[] = [
      { botId: "b1", id: "boss", defHash: "h", def: { name: "Boss", prompt: "p", trigger: { email: { account: "work", query: "from:boss" } }, enabled: true, createdAt: 0 } },
    ];
    let made = 0;
    const et = new EmailTriggers({
      store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: () => [] } as unknown as EventQueue,
      mailboxes, model: null, now: () => Date.now(), ...timers,
      imapFactory: () => { made++; return new FakeImap(); },
    });
    et.sync(); await flush();
    et.sync(); await flush();
    expect(made, "every routine edit would drop and re-open a healthy IDLE connection").toBe(1);
    await et.stop();
  });

  it("formats the email_event block fields", () => {
    const ev = emailEvent(msg(9, { text: "a".repeat(1500), attachments: ["r.pdf"], date: Date.UTC(2026, 8, 19, 11) }), { account: "work", folder: "INBOX", queryText: "" });
    expect(ev.text).toBe(["from: boss@acme.com", "to: me@x.com", "subject: Mail 9", "date: 2026-09-19T11:00:00.000Z", `snippet: ${"a".repeat(1000)}`, "attachments: r.pdf"].join("\n"));
    expect(ev.occurredAt).toBe(Date.UTC(2026, 8, 19, 11));
  });
});
