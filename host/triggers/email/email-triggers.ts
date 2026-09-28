import { LIMITS, type Trigger } from "@synapse/shared";
import type { OneShotModel } from "../../helper-model/one-shot";
import type { RoutineStore } from "../../routines/routine-store";
import { log } from "../../util/log";
import type { EventQueue } from "../event-queue";
import type { TriggerEvent } from "../types";
import { GmailHistoryWatch, type GoogleGet } from "./gmail-history";
import { ImapFlowClient, ImapIdleWatcher, type ImapLike } from "./imap-idle";
import type { MailboxSecret, MailboxStore } from "./mailboxes";
import { matchMail, parseMailQuery, type MailMessage, type MailQuery } from "./query";

/** The built-in Google connector's Gmail: history-id polling, filters in code, no model call. */
export const GOOGLE_MAIL_ACCOUNT = "google";

type EmailTrigger = Extract<Trigger, { email: unknown }>["email"];
interface Sub { botId: string; routineId: string; account: string; folder: string; queryText: string; query: MailQuery }

export interface EmailTriggerDeps {
  store: RoutineStore;
  queue: EventQueue;
  mailboxes: MailboxStore;
  model: OneShotModel | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  imapFactory?(s: MailboxSecret, folder: string): ImapLike;
  pollEveryMs?: number;
  onHealthChange?(botIds: string[]): void;
  /** The built-in Google connector's Gmail API (null while it isn't connected). */
  googleMail?(): GoogleGet | null;
  /** Per-Bot scoping: the Bot has the Google connector turned on (its mail triggers see nothing otherwise). */
  googleAllowed?(botId: string): boolean;
}

function emailTriggersOf(t: Trigger): EmailTrigger[] {
  if ("group" in t) return t.group.listeners.flatMap(emailTriggersOf);
  return "email" in t ? [t.email] : [];
}

export function emailEvent(m: MailMessage, sub: { account: string; folder: string; queryText: string }): TriggerEvent {
  const snippet = m.text.replace(/\s+/g, " ").trim().slice(0, 1000);
  const text = [`from: ${m.from}`, `to: ${m.to.join(", ")}`, `subject: ${m.subject}`, `date: ${new Date(m.date).toISOString()}`, `snippet: ${snippet}`, `attachments: ${m.attachments.join(", ") || "(none)"}`].join("\n");
  return {
    source: "email", eventId: m.messageId || m.id, occurredAt: m.date, actor: m.from, subject: m.subject, text, account: sub.account, channel: sub.folder,
    raw: { query: sub.queryText, folder: sub.folder, from: m.from, to: m.to, subject: m.subject, date: m.date, attachments: m.attachments },
  };
}

/**
 * ORIG-04 §04.5: one IDLE connection per (Bot, mailbox, folder), and the built-in Google connector's Gmail. (The
 * claude.ai Gmail connector poll is gone in synapse-public: claude.ai connectors need a Claude login, which Bots never have,
 * so a routine on that account has no mailbox and RoutineHealth says so on its row.)
 */
export class EmailTriggers {
  private idle = new Map<string, { watcher: ImapIdleWatcher; subs: Sub[]; secretKey: string }>();
  private google: { watch: GmailHistoryWatch; subs: Sub[] } | null = null;
  onHealthChange: ((botIds: string[]) => void) | undefined;

  constructor(private d: EmailTriggerDeps) {
    this.onHealthChange = d.onHealthChange;
  }

  mailboxReachable(botId: string, account: string): boolean {
    for (const [k, v] of this.idle) {
      if (!k.startsWith(`${botId}|${account}|`)) continue;
      if (v.watcher.consecutiveFailures() >= LIMITS.imapFailHealthAfter) return false;
    }
    if (account === GOOGLE_MAIL_ACCOUNT && this.google && this.google.watch.consecutiveFailures() >= LIMITS.imapFailHealthAfter) return false;
    return true;
  }

  private noteHealth(subs: Sub[], n: number): void {
    if (n === LIMITS.imapFailHealthAfter) {
      for (const s of subs) log.warn("email mailbox unreachable after retries", { botId: s.botId, routineId: s.routineId, account: s.account });
    }
    this.onHealthChange?.([...new Set(subs.map((s) => s.botId))]);
  }

  sync(): void {
    const wantIdle = new Map<string, Sub[]>();
    const wantGoogle: Sub[] = [];
    for (const r of this.d.store.all()) {
      if (!r.def.enabled || !r.def.trigger) continue;
      for (const e of emailTriggersOf(r.def.trigger)) {
        let query: MailQuery;
        // Skipping is right — an unparseable query cannot be subscribed — but the skip is invisible to the
        // user on its own (bug 44a): RoutineHealth turns the routine off and writes the reason on its row.
        try { query = parseMailQuery(e.query); } catch (err) { log.warn("email routine has an invalid query", { routineId: r.id, error: String(err) }); continue; }
        const sub: Sub = { botId: r.botId, routineId: r.id, account: e.account, folder: e.folder ?? "INBOX", queryText: e.query, query };
        if (e.account === GOOGLE_MAIL_ACCOUNT) wantGoogle.push(sub);
        else {
          const k = `${r.botId}|${e.account}|${sub.folder}`;
          wantIdle.set(k, [...(wantIdle.get(k) ?? []), sub]);
        }
      }
    }
    for (const [k, v] of this.idle) if (!wantIdle.has(k)) { void v.watcher.stop(); this.idle.delete(k); }
    for (const [k, subs] of wantIdle) {
      const first = subs[0]!;
      const secret = this.d.mailboxes.secret(first.botId, first.account);
      const cur = this.idle.get(k);
      const secretKey = secret ? JSON.stringify([secret.host, secret.port, secret.user, secret.appPassword]) : "";
      if (cur && cur.secretKey === secretKey) { cur.subs = subs; continue; }
      // Bug 51: the unreachable row tells the user to add the mailbox again with the right details. The
      // watcher was built around the old ones, so it is replaced rather than left retrying them forever.
      const replaced = cur !== undefined;
      if (cur) { void cur.watcher.stop(); this.idle.delete(k); }
      // RoutineHealth says this on the routine's own row (bug 44); the log carries the routine id so the two tie together.
      if (!secret) { log.warn("email routine names an unknown mailbox", { botId: first.botId, routineId: first.routineId, account: first.account }); continue; }
      const entry = { subs, secretKey, watcher: null as unknown as ImapIdleWatcher };
      entry.watcher = new ImapIdleWatcher({
        client: () => (this.d.imapFactory ?? ((s, f) => new ImapFlowClient(s, f)))(secret, first.folder),
        folder: first.folder, setTimer: this.d.setTimer, clearTimer: this.d.clearTimer,
        onMessage: (m) => { for (const s of entry.subs) if (this.d.googleAllowed?.(s.botId) !== false) this.deliver(s, m, true); },
        onFailures: (n) => this.noteHealth(entry.subs, n),
      });
      this.idle.set(k, entry);
      entry.watcher.start();
      if (replaced) this.onHealthChange?.([...new Set(subs.map((x) => x.botId))]); // the row stops saying "can't reach"
    }
    this.syncGoogle(wantGoogle);
  }

  /** One history watch for every google-account routine; each message is matched against every query in code. */
  private syncGoogle(subs: Sub[]): void {
    if (!subs.length || !this.d.googleMail) {
      this.google?.watch.stop();
      this.google = null;
      return;
    }
    if (this.google) { this.google.subs = subs; return; }
    const entry = { subs, watch: null as unknown as GmailHistoryWatch };
    entry.watch = new GmailHistoryWatch({
      source: () => this.d.googleMail?.() ?? null,
      onMessage: (m) => { for (const s of entry.subs) this.deliver(s, m, true); },
      needsAttachments: () => entry.subs.some((s) => s.query.groups.some((g) => g.some((t) => t.op === "has"))),
      now: this.d.now, setTimer: this.d.setTimer, clearTimer: this.d.clearTimer, everyMs: this.d.pollEveryMs,
      onFailures: (n) => this.noteHealth(entry.subs, n),
    });
    this.google = entry;
    entry.watch.start();
  }

  async stop(): Promise<void> {
    this.google?.watch.stop();
    this.google = null;
    await Promise.all([...this.idle.values()].map((v) => v.watcher.stop()));
    this.idle.clear();
  }

  private deliver(sub: Sub, m: MailMessage, matchLocally: boolean): void {
    if (matchLocally && !matchMail(sub.query, m, this.d.now())) return;
    this.d.queue.ingest(emailEvent(m, sub), { botId: sub.botId, routineId: sub.routineId });
  }
}
