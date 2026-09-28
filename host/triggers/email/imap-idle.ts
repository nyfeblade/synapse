import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { LIMITS } from "@synapse/shared";
import { log } from "../../util/log";
import type { MailboxSecret } from "./mailboxes";
import type { MailMessage } from "./query";

export interface ImapLike {
  connect(): Promise<void>;
  openFolder(folder: string): Promise<{ uidNext: number }>;
  fetchSince(uid: number): Promise<(MailMessage & { uid: number })[]>;
  idle(): Promise<unknown>;
  stopIdle(): void;
  onExists(cb: () => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

export const backoffMs = (attempt: number) => Math.min(LIMITS.imapBackoffMinMs * 2 ** attempt, LIMITS.imapBackoffMaxMs);

/** One IDLE connection (ORIG-04 §04.5): only mail after start counts; re-IDLE every 25 min; reconnect 5 s → 5 min. */
export class ImapIdleWatcher {
  private c: ImapLike | null = null;
  private lastUid: number | null = null;
  private attempt = 0;
  private fails = 0;
  private reissue: unknown = null;
  private retry: unknown = null;
  private stopped = false;
  private pulling = Promise.resolve();

  constructor(private d: { client(): ImapLike; folder: string; onMessage(m: MailMessage): void; onFailures?(n: number): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }) {}

  consecutiveFailures(): number { return this.fails; }

  private noteFails(n: number): void {
    if (this.fails === n) return;
    this.fails = n;
    this.d.onFailures?.(n);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reissue) this.d.clearTimer(this.reissue);
    if (this.retry) this.d.clearTimer(this.retry);
    const c = this.c;
    this.c = null;
    await c?.close().catch(() => {});
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const c = this.d.client();
    this.c = c;
    try {
      await c.connect();
      const { uidNext } = await c.openFolder(this.d.folder);
      if (this.lastUid === null) this.lastUid = uidNext - 1;
      this.attempt = 0;
      this.noteFails(0);
      c.onExists(() => this.pull(c));
      c.onClose((err) => this.lost(c, err));
      this.pull(c); // catch up on anything that arrived while disconnected
      this.idle(c);
    } catch (e) {
      this.lost(c, e as Error);
    }
  }

  private idle(c: ImapLike): void {
    void c.idle().catch(() => {});
    if (this.reissue) this.d.clearTimer(this.reissue);
    this.reissue = this.d.setTimer(() => {
      if (this.c !== c) return;
      c.stopIdle();
      this.idle(c);
    }, LIMITS.imapIdleReissueMs);
  }

  private pull(c: ImapLike): void {
    this.pulling = this.pulling.then(async () => {
      if (this.c !== c || this.lastUid === null) return;
      const msgs = await c.fetchSince(this.lastUid + 1);
      for (const m of msgs.sort((a, b) => a.uid - b.uid)) {
        if (m.uid <= this.lastUid) continue;
        this.lastUid = m.uid;
        const { uid: _uid, ...mail } = m;
        this.d.onMessage(mail);
      }
    }).catch((e) => log.warn("imap fetch failed", { error: String(e) }));
  }

  private lost(c: ImapLike, err?: Error): void {
    if (this.c !== c || this.stopped) return;
    this.c = null;
    if (this.reissue) this.d.clearTimer(this.reissue);
    void c.close().catch(() => {});
    this.noteFails(this.fails + 1);
    const delay = backoffMs(this.attempt++);
    log.warn("imap connection lost; reconnecting", { folder: this.d.folder, delayMs: delay, error: err ? String(err) : null });
    this.retry = this.d.setTimer(() => void this.connect(), delay);
  }
}

function attachmentsOf(node: MessageStructureObject | undefined): string[] {
  if (!node) return [];
  const own = node.disposition === "attachment" ? [String(node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment")] : [];
  return [...own, ...(node.childNodes ?? []).flatMap(attachmentsOf)];
}

/** The real client (imapflow 2.0.5). */
export class ImapFlowClient implements ImapLike {
  private c: ImapFlow;

  constructor(s: MailboxSecret, private folder: string) {
    this.c = new ImapFlow({ host: s.host, port: s.port, secure: s.port === 993, auth: { user: s.user, pass: s.appPassword }, logger: false });
  }
  async connect(): Promise<void> { await this.c.connect(); }
  async openFolder(folder: string): Promise<{ uidNext: number }> {
    this.folder = folder;
    const mb = await this.c.mailboxOpen(folder);
    return { uidNext: Number(mb.uidNext) };
  }
  async fetchSince(uid: number): Promise<(MailMessage & { uid: number })[]> {
    const out: (MailMessage & { uid: number })[] = [];
    for await (const msg of this.c.fetch(`${uid}:*`, { uid: true, envelope: true, flags: true, labels: true, bodyStructure: true, source: { maxLength: 16_384 } }, { uid: true })) {
      if (msg.uid < uid) continue;
      out.push(this.toMail(msg));
    }
    return out;
  }
  private toMail(msg: FetchMessageObject): MailMessage & { uid: number } {
    const env = msg.envelope;
    const addr = (a?: { name?: string; address?: string }) => (a ? (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? "") : "");
    const src = msg.source?.toString("utf8") ?? "";
    const sep = src.indexOf("\r\n\r\n");
    return {
      uid: msg.uid, id: String(msg.uid), messageId: env?.messageId ?? `uid-${msg.uid}`, from: addr(env?.from?.[0]), to: (env?.to ?? []).map((a) => a.address ?? ""),
      subject: env?.subject ?? "", date: env?.date ? new Date(env.date).getTime() : Date.now(), text: (sep >= 0 ? src.slice(sep + 4) : src).slice(0, 8192),
      unread: !msg.flags?.has("\\Seen"), folder: this.folder, labels: [...(msg.labels ?? [])], attachments: attachmentsOf(msg.bodyStructure),
    };
  }
  idle(): Promise<unknown> { return this.c.idle(); }
  stopIdle(): void { void this.c.noop().catch(() => {}); } // any command ends IDLE
  onExists(cb: () => void): void { this.c.on("exists", () => cb()); }
  onClose(cb: (err?: Error) => void): void {
    this.c.on("close", () => cb());
    this.c.on("error", (e: Error) => cb(e));
  }
  async close(): Promise<void> { await this.c.logout().catch(() => this.c.close()); }
}
