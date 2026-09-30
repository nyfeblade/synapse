import { LIMITS_SCHED } from "@synapse/shared";
import { log } from "../../util/log";
import type { MailMessage } from "./query";

/** A GET against a Google API base (the built-in connector's GoogleApi, host-side token). Throws with `.status` on HTTP errors. */
export type GoogleGet = <T>(path: string, query?: Record<string, string | number | undefined>) => Promise<T>;

interface HistoryPage { historyId?: string; nextPageToken?: string; history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[]; labelsAdded?: { message: { id: string; labelIds?: string[] }; labelIds?: string[] }[] }[] }
interface GmailHeader { name: string; value: string }
interface GmailPart { filename?: string; parts?: GmailPart[] }
export interface GmailMessage { id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: { headers?: GmailHeader[]; parts?: GmailPart[] } }

const SKIP = new Set(["DRAFT", "SENT", "SPAM", "TRASH"]);
/** 4.3 Email in also looks at mail the owner sent (their own forward is in Sent), never at drafts, spam or trash. */
const SKIP_RAW = new Set(["DRAFT", "SPAM", "TRASH"]);
const MAX_PAGES = 5;

function filenames(parts: GmailPart[] | undefined): string[] {
  return (parts ?? []).flatMap((p) => [...(p.filename ? [p.filename] : []), ...filenames(p.parts)]);
}

export function toMailMessage(m: GmailMessage, now: number): MailMessage {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const labels = m.labelIds ?? [];
  const date = Number(m.internalDate) || Date.parse(h("Date")) || now;
  return {
    id: m.id, messageId: h("Message-ID") || m.id, from: h("From"), to: h("To").split(",").map((s) => s.trim()).filter(Boolean),
    subject: h("Subject"), date, text: m.snippet ?? "", unread: labels.includes("UNREAD"),
    folder: labels.includes("INBOX") ? "INBOX" : (labels[0] ?? "INBOX"), labels, attachments: filenames(m.payload?.parts),
  };
}

/**
 * New mail through the built-in Google connector, polled with Gmail history ids (users.history.list). An idle poll is
 * one small API request and no model call; a new message costs one metadata fetch. Matching is done in code by the caller.
 * An expired history id (404) re-baselines rather than replaying the mailbox.
 */
export class GmailHistoryWatch {
  private historyId: string | null = null;
  private timer: unknown = null;
  private fails = 0;

  constructor(private d: {
    source(): GoogleGet | null;
    onMessage(m: MailMessage): void;
    /** A subscribed query uses has:attachment, so the message's part list is needed (format=full). */
    needsAttachments(): boolean;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    everyMs?: number;
    onFailures?(n: number): void;
    /** 4.3 Email in: every new message (Sent included) and every message that gained a user label, as Gmail returns it.
     *  Only while it returns true; the mail triggers' own path is unchanged. */
    emailIn?(): boolean;
    onRaw?(m: GmailMessage): Promise<void>;
  }) {}

  consecutiveFailures(): number { return this.fails; }

  start(): void {
    this.timer = this.d.setTimer(() => {
      void this.pollOnce()
        .then(() => this.noteFails(0))
        .catch((e) => { this.noteFails(this.fails + 1); log.warn("gmail history poll failed", { error: String((e as Error).message ?? e).slice(0, 200) }); })
        .finally(() => { if (this.timer) this.start(); });
    }, this.d.everyMs ?? LIMITS_SCHED.gmailPollMs);
  }

  stop(): void {
    if (this.timer) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  private noteFails(n: number): void {
    if (this.fails === n) return;
    this.fails = n;
    this.d.onFailures?.(n);
  }

  /** Returns how many new messages were delivered. */
  async pollOnce(): Promise<number> {
    const get = this.d.source();
    if (!get) return 0;
    if (!this.historyId) {
      const p = await get<{ historyId?: string }>("/users/me/profile");
      this.historyId = p.historyId ?? null;
      return 0;
    }
    const ids: string[] = [];
    // 4.3: messages only Email in wants (Sent, or a label added later), fetched once and handed only to it.
    const rawOnly = new Set<string>();
    const inOn = !!this.d.onRaw && (this.d.emailIn?.() ?? false);
    let latest = this.historyId;
    let pageToken: string | undefined;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        // With Email in on, every history type (label changes too); otherwise just new mail, as before.
        const page = await get<HistoryPage>("/users/me/history", { startHistoryId: this.historyId, historyTypes: inOn ? undefined : "messageAdded", pageToken });
        for (const h of page.history ?? []) {
          for (const a of h.messagesAdded ?? []) {
            const labels = a.message.labelIds ?? [];
            if (ids.includes(a.message.id)) continue;
            if (!labels.some((l) => SKIP.has(l))) { ids.push(a.message.id); rawOnly.delete(a.message.id); }
            else if (inOn && !labels.some((l) => SKIP_RAW.has(l))) rawOnly.add(a.message.id);
          }
          if (inOn) for (const a of h.labelsAdded ?? []) if ((a.labelIds ?? []).some((l) => l.startsWith("Label_")) && !ids.includes(a.message.id)) rawOnly.add(a.message.id);
        }
        if (page.historyId) latest = page.historyId;
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        // The id aged out (Gmail keeps about a week): start again from now instead of replaying the mailbox.
        this.historyId = (await get<{ historyId?: string }>("/users/me/profile")).historyId ?? null;
        return 0;
      }
      throw e;
    }
    this.historyId = latest;
    const format = this.d.needsAttachments() ? "full" : "metadata";
    let n = 0;
    for (const id of [...ids.slice(0, LIMITS_SCHED.gmailFetchMax), ...[...rawOnly].slice(0, LIMITS_SCHED.gmailFetchMax)]) {
      try {
        const m = await get<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}`, { format });
        if (!rawOnly.has(id)) { this.d.onMessage(toMailMessage(m, this.d.now())); n++; }
        if (inOn) await this.d.onRaw!(m);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e; // deleted since: skip
      }
    }
    return n;
  }
}
