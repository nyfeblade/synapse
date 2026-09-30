import { createHash } from "node:crypto";
import fs from "node:fs";
import { writeFileAtomic } from "../atomic-file";

/**
 * Replies to feedback. Each private send gets a thread code from the website; the code stays here,
 * in feedback-threads.json (0600) in the app's data folder, and goes out only as a request header to
 * /api/feedback/thread. The renderer sees a short id derived from the code, never the code.
 */
export interface ThreadMessage { from: "you" | "synapse"; text: string; at: string | null }
interface Stored { code: string; issue: number | null; sentAt: number; seenReplies: number; status: "open" | "closed"; messages: ThreadMessage[]; checkedAt: number | null }
export interface ThreadView { id: string; sentAt: number; status: "open" | "closed"; messages: ThreadMessage[]; unread: number }

export const POLL_MS = 4 * 3600 * 1000;
export const ACTIVE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
/** "<issue number>.<secret>", as /api/feedback returns it. */
const CODE = /^[1-9]\d{0,9}\.[A-Za-z0-9_-]{22}$/;
/** A thread the server can't find this soon after sending is new, not gone. */
export const GRACE_MS = 7 * 24 * 3600 * 1000;
export const threadId = (code: string) => createHash("sha256").update(`id:${code}`).digest("hex").slice(0, 12);
const replies = (m: ThreadMessage[]) => m.filter((x) => x.from === "synapse").length;

export class ThreadStore {
  constructor(private file: string, private now: () => number = Date.now) {}

  private read(): Stored[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { v: 1; threads: Stored[] };
      return Array.isArray(j?.threads) ? j.threads.filter((t) => CODE.test(t.code)) : [];
    } catch { return []; }
  }
  private write(threads: Stored[]): void { writeFileAtomic(this.file, JSON.stringify({ v: 1, threads }), 0o600); }

  add(code: string, firstMessage: string): void {
    if (!CODE.test(code)) return;
    const threads = this.read().filter((t) => t.code !== code);
    threads.push({ code, issue: Number(code.split(".")[0]), sentAt: this.now(), seenReplies: 0, status: "open", messages: [{ from: "you", text: firstMessage, at: new Date(this.now()).toISOString() }], checkedAt: null });
    this.write(threads.slice(-100));
  }

  /** Open threads under 30 days old: the only ones polled. */
  active(): { id: string; code: string }[] {
    const t = this.now();
    return this.read().filter((x) => x.status === "open" && t - x.sentAt < ACTIVE_DAYS * DAY).map((x) => ({ id: threadId(x.code), code: x.code }));
  }

  codeFor(id: string): string | null { return this.read().find((t) => threadId(t.code) === id)?.code ?? null; }

  /** A fresh copy from the server. Returns how many replies are new since the last update. */
  update(code: string, v: { status: "open" | "closed"; messages: ThreadMessage[] }): number {
    const threads = this.read();
    const t = threads.find((x) => x.code === code);
    if (!t) return 0;
    const before = replies(t.messages);
    t.status = v.status === "closed" ? "closed" : "open";
    t.messages = v.messages.slice(0, 200).map((m) => ({ from: m.from === "synapse" ? "synapse" : "you", text: String(m.text ?? "").slice(0, 10_000), at: typeof m.at === "string" ? m.at : null }));
    t.checkedAt = this.now();
    this.write(threads);
    return Math.max(0, replies(t.messages) - before);
  }

  /**
   * The server doesn't know it. Within 7 days of sending that means "not yet" (try again later), so
   * nothing changes; after that the thread is closed and no longer checked.
   */
  notFound(code: string): void {
    const threads = this.read();
    const t = threads.find((x) => x.code === code);
    if (t && this.now() - t.sentAt >= GRACE_MS) { t.status = "closed"; this.write(threads); }
  }

  markSeen(): void {
    const threads = this.read();
    for (const t of threads) t.seenReplies = replies(t.messages);
    this.write(threads);
  }

  list(): ThreadView[] {
    return this.read().sort((a, b) => b.sentAt - a.sentAt).map((t) => ({ id: threadId(t.code), sentAt: t.sentAt, status: t.status, messages: t.messages, unread: Math.max(0, replies(t.messages) - t.seenReplies) }));
  }

  unread(): number { return this.list().reduce((n, t) => n + t.unread, 0); }
}

/**
 * The background check: once shortly after launch, then every 4 hours, and only while some thread
 * is open and under 30 days old. Timers are unref'd and never overlap.
 */
export function startThreadPolling(o: { store: ThreadStore; check(): Promise<void>; firstDelayMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }): { stop(): void; kick(): void } {
  const set = o.setTimer ?? setTimeout, clear = o.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    timer = null;
    if (stopped || !o.store.active().length) return;
    timer = set(async () => {
      timer = null;
      try { await o.check(); } catch { /* next time */ }
      schedule(POLL_MS);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule(o.firstDelayMs ?? 30_000);
  return {
    stop: () => { stopped = true; if (timer) clear(timer); timer = null; },
    /** A new thread: start the 4-hour check if it had stopped (nothing was open). */
    kick: () => { if (!stopped && !timer) schedule(POLL_MS); },
  };
}
