import type { EmailInMeta } from "@synapse/shared";
import { bodyOf, type GmailPart } from "../../google/tools";
import { log } from "../../util/log";
import type { GoogleGet } from "./gmail-history";

/**
 * 4.3 Email in. The owner forwards (or sends) an email to `<their address>+<tag>@…`, or puts the Gmail label
 * `Synapse/<Bot>` on one, and that Bot gets a task. See docs/superpowers/specs/2026-09-30-email-in-design.md.
 *
 * The one security question: is this the owner? "From" can be forged, so the proof is Gmail's own SENT label, which
 * Google puts only on mail the account itself sent: the message is From one of the owner's connected addresses and
 * that account's Sent folder holds it. Anything else is outside content and never a task.
 */

export interface GmailRaw { id: string; threadId?: string; labelIds?: string[]; payload?: GmailPart & { headers?: { name: string; value: string }[] } }
export interface EmailInAccount { id: string; email: string | null }
export interface EmailInBot { id: string; name: string; tag: string }
/** A file from the email, stored through the chat attachment path. */
export interface EmailInFile { name: string; bytes: Buffer }
export interface EmailTask { key: string; text: string; email: EmailInMeta; files: EmailInFile[] }

export interface EmailInDeps {
  accounts(): EmailInAccount[];
  get(accountId: string): GoogleGet | null;
  /** Bots with Email in on (and their tags). */
  bots(): EmailInBot[];
  /** The Bot has Google on with this account granted (4.3b). */
  allowed(botId: string, accountId: string): boolean;
  deliver(botId: string, task: EmailTask): void;
  /** A message routed to this Bot that isn't provably the owner's: at most a quiet notice. */
  notice(botId: string, from: string): void;
  /** A routed message that couldn't be read (a Gmail error): the owner is told, since nothing retries it. */
  failed(botId: string): void;
}

const MAX_TAG = 30;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const QUOTED_MAX = 16_000;
/** The owner's own words on an emailed task: a note, not a document. */
export const OWNER_MAX = 2_000;
const SEEN_MAX = 500;

/** A Bot's tag from its name: lowercase letters, digits and dashes, unique among `taken`. */
export function emailInTag(name: string, taken: ReadonlySet<string>): string {
  const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_TAG - 3) || "bot");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `me@gmail.com` + `scout` → `me+scout@gmail.com`. */
export function plusAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

const GMAIL = new Set(["gmail.com", "googlemail.com"]);
/** An address for comparing: lowercase; for Gmail, dots in the name don't count. */
function canon(addr: string): { local: string; domain: string } | null {
  const m = /^([^@\s<>]+)@([^@\s<>]+)$/.exec(addr.trim().toLowerCase());
  if (!m) return null;
  const domain = m[2] === "googlemail.com" ? "gmail.com" : m[2]!;
  return { local: GMAIL.has(domain) ? m[1]!.replace(/\./g, "") : m[1]!, domain };
}

export function sameAddress(a: string, b: string): boolean {
  const x = canon(a);
  const y = canon(b);
  return !!x && !!y && x.local === y.local && x.domain === y.domain;
}

/** The tag of `addr` when it is `account`'s plus address, else null. */
export function plusTagOf(addr: string, account: string): string | null {
  const x = canon(addr);
  const y = canon(account);
  if (!x || !y || x.domain !== y.domain) return null;
  const plus = x.local.indexOf("+");
  if (plus < 0 || x.local.slice(0, plus) !== y.local) return null;
  return x.local.slice(plus + 1) || null;
}

/** The bare addresses in a header value ("Dana <d@x>, e@y"). */
export function addressesIn(v: string): string[] {
  return (v.replace(/"[^"]*"/g, "").match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/g) ?? []).map((s) => s.toLowerCase());
}

/**
 * Bot sends can't route mail to a Bot: true when a connector call names one of the owner's plus addresses anywhere,
 * or puts on (or makes) a `Synapse/…` label: a label or filter tool with a `Synapse/` value or a Gmail label id.
 * (A Bot's own send from the owner's account would carry SENT, the proof this feature trusts.)
 */
export function touchesEmailIn(tool: string, input: unknown, ownerEmails: readonly string[]): boolean {
  const labelTool = /label|filter/i.test(tool);
  let hit = false;
  const walk = (v: unknown, key: string): void => {
    if (hit) return;
    if (typeof v === "string") {
      if ((labelTool || /label/i.test(key)) && (/synapse\s*\//i.test(v) || (labelTool && /^Label_\w+$/.test(v.trim())))) hit = true;
      for (const a of v.match(/[^\s<>(),;:"'\\[\]{}]+@[^\s<>(),;:"'\\[\]{}]+/g) ?? []) if (ownerEmails.some((o) => plusTagOf(a, o) !== null)) hit = true;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input, "");
  return hit;
}

const MARKERS: RegExp[] = [
  /^-{2,}\s*forwarded message\s*-{2,}/i,
  /^begin forwarded message:?/i,
  /^-{2,}\s*original message\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^>/,
  // Localised forward and original-message lines.
  /^-{2,}\s*(weitergeleitete nachricht|ursprüngliche nachricht|message transféré|message d'origine|mensaje reenviado|mensaje original|messaggio inoltrato|messaggio originale|doorgestuurd bericht|oorspronkelijk bericht|vidarebefordrat meddelande|ursprungligt meddelande|mensagem encaminhada|mensagem original)\s*-{2,}/i,
];

/** Reply and forward subject prefixes, in the languages mail clients use. */
const REPLY_SUBJECT = /^\s*(fwd?|fw|re|aw|wg|tr|rv|sv|vs|vb|antw|doorst|rif|r|i|enc|pd|ynt|ilt|odp|pd|vá|továbbítás|перес|отв|回复|转发|答复|轉寄|回覆|返信|転送)\s*(\[\d+\])?\s*[:：]/i;
/** A header line of a forwarded or quoted message, in English and the common localised forms. */
const HEADER_LINE = /^\s*[*_]*\s*(from|sent|date|subject|to|cc|von|gesendet|datum|betreff|an|de|envoyé|objet|à|para|enviado|fecha|asunto|da|inviato|data|oggetto|a|van|verzonden|onderwerp|aan|från|skickat|ämne|till|fra|sendt|emne|til|od|wysłano|temat|do|assunto|от|отправлено|тема|кому|差出人|送信日時|件名|宛先|发件人|发送时间|主题|收件人|寄件者|主旨)\s*[*_]*\s*[:：]\s*\S/i;
/** Signs of quoted-printable text pasted from another message (=3D, =E2=80=99, soft line breaks). */
const QP = /=\r?\n|content-transfer-encoding:\s*quoted-printable/i;
const qpCodes = (t: string) => (t.match(/=[0-9A-F]{2}/g) ?? []).length;

/** The body (or the owner's part of it) looks like it carries someone else's message. */
export function looksForeign(text: string): boolean {
  return text.split(/\r?\n/).some((l) => HEADER_LINE.test(l)) || QP.test(text) || qpCodes(text) >= 3 || /-{2,}\s*original message\s*-{2,}/i.test(text);
}

/** A whole message attached (Outlook and Gmail's "forward as attachment"). */
export function hasAttachedMessage(p: GmailPart | undefined): boolean {
  if (!p) return false;
  if (p.mimeType?.toLowerCase() === "message/rfc822" || /\.eml$/i.test(p.filename ?? "")) return true;
  return (p.parts ?? []).some(hasAttachedMessage);
}

/**
 * Concern 3, fail closed: the owner's words are what they wrote above a known forward or quote marker. With no
 * marker, ANY sign of someone else's content (a Fwd/Re subject, header lines, quoted-printable, an attached message,
 * a reply to mail the owner didn't send) makes the whole body outside content and the owner's words empty. Header
 * lines or quoted-printable in the owner's own part empty it too.
 */
export function ownerWords(body: string, signs: { subject: string; attachedMessage: boolean; foreignReply: boolean }): { owner: string; quoted: string; withheld: boolean } {
  const split = splitForward(body);
  const marker = split.quoted.length > 0;
  const foreign = looksForeign(split.owner) || (!marker && (REPLY_SUBJECT.test(signs.subject) || signs.attachedMessage || signs.foreignReply));
  if (foreign) return { owner: "", quoted: body.replace(/\r\n/g, "\n").trim(), withheld: true };
  return { owner: split.owner.slice(0, OWNER_MAX), quoted: split.quoted, withheld: false };
}

/**
 * The owner's own words are only what they wrote above the forward or the quote. Everything from the first marker
 * on (a forwarded message, "On … wrote:", a quoted `>` line) is outside content.
 */
export function splitForward(body: string): { owner: string; quoted: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    // "On Mon, Sep 14, 2026 at 9:12 AM Dana <d@x> wrote:" (Gmail wraps it over two or three lines sometimes).
    const next = [1, 2].map((k) => (lines[i + k] ?? "").trim());
    const wrote = /^on\s/i.test(l) && [l, `${l} ${next[0]}`, `${l} ${next[0]} ${next[1]}`].some((t) => /\bwrote:\s*$/i.test(t));
    if (wrote || MARKERS.some((m) => m.test(l))) { cut = i; break; }
  }
  return { owner: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim() };
}

const hdr = (m: GmailRaw, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export class EmailIn {
  private seen: string[] = [];
  private labels = new Map<string, { at: number; names: Map<string, string> }>();

  constructor(private d: EmailInDeps & { now(): number }) {}

  /** Any Bot has Email in on: the per-account polls keep running (and look at label changes) for it. */
  active(): boolean {
    return this.d.bots().length > 0;
  }

  private async labelNames(accountId: string, ids: string[]): Promise<string[]> {
    const user = ids.filter((l) => l.startsWith("Label_"));
    if (!user.length) return [];
    let cache = this.labels.get(accountId);
    if (!cache || (user.some((l) => !cache!.names.has(l)) && this.d.now() - cache.at > 60_000)) {
      const g = this.d.get(accountId);
      if (!g) return [];
      const r = await g<{ labels?: { id: string; name: string }[] }>("/users/me/labels");
      cache = { at: this.d.now(), names: new Map((r.labels ?? []).map((l) => [l.id, l.name])) };
      this.labels.set(accountId, cache);
    }
    return user.map((l) => cache!.names.get(l) ?? "").filter(Boolean);
  }

  /** Which Bot this message is for, and how (its plus address on this account, or its label). */
  private async route(acc: EmailInAccount, m: GmailRaw, bots: EmailInBot[]): Promise<{ bot: EmailInBot; via: string } | null> {
    for (const a of ["To", "Cc", "Delivered-To"].flatMap((h) => addressesIn(hdr(m, h)))) {
      const tag = plusTagOf(a, acc.email!);
      const bot = tag ? bots.find((b) => b.tag === tag) : undefined;
      if (bot) return { bot, via: plusAddress(acc.email!, bot.tag) };
    }
    for (const name of await this.labelNames(acc.id, m.labelIds ?? [])) {
      const want = /^synapse\/(.+)$/i.exec(name.trim())?.[1]?.trim().toLowerCase();
      const bot = want ? bots.find((b) => b.tag === want || b.name.trim().toLowerCase() === want) : undefined;
      if (bot) return { bot, via: name };
    }
    return null;
  }

  /**
   * The proof: From is one of the owner's connected addresses, and that account sent it (SENT on this very message
   * when it's the same account; the same Message-ID in the other account's Sent folder otherwise).
   */
  async ownerSent(acc: EmailInAccount, m: GmailRaw): Promise<boolean> {
    const from = addressesIn(hdr(m, "From"));
    if (from.length !== 1) return false;
    const sender = this.d.accounts().find((a) => a.email && sameAddress(a.email, from[0]!));
    if (!sender) return false;
    if (sender.id === acc.id) return (m.labelIds ?? []).includes("SENT");
    const mid = hdr(m, "Message-ID").trim();
    if (!/^<[^<>\s"]{3,900}>$/.test(mid)) return false;
    const g = this.d.get(sender.id);
    if (!g) return false;
    const list = await g<{ messages?: { id: string }[] }>("/users/me/messages", { q: `rfc822msgid:${mid.slice(1, -1)}`, labelIds: "SENT", maxResults: 5 });
    for (const x of (list.messages ?? []).slice(0, 5)) {
      const s = await g<GmailRaw>(`/users/me/messages/${encodeURIComponent(x.id)}`, { format: "metadata" });
      if ((s.labelIds ?? []).includes("SENT") && hdr(s, "Message-ID").trim() === mid && addressesIn(hdr(s, "From")).some((f) => sameAddress(f, sender.email!))) return true;
    }
    return false;
  }

  /** In-Reply-To / References name a message the owner didn't send (not in any connected account's Sent). */
  private async foreignReply(m: GmailRaw): Promise<boolean> {
    const ids = [...new Set(`${hdr(m, "In-Reply-To")} ${hdr(m, "References")}`.match(/<[^<>\s"]{3,900}>/g) ?? [])].slice(-5);
    for (const id of ids) {
      let own = false;
      for (const a of this.d.accounts()) {
        const g = a.email ? this.d.get(a.id) : null;
        if (!g) continue;
        const list = await g<{ messages?: { id: string }[] }>("/users/me/messages", { q: `rfc822msgid:${id.slice(1, -1)}`, labelIds: "SENT", maxResults: 1 });
        for (const x of list.messages ?? []) {
          const s = await g<GmailRaw>(`/users/me/messages/${encodeURIComponent(x.id)}`, { format: "metadata" });
          if ((s.labelIds ?? []).includes("SENT") && addressesIn(hdr(s, "From")).some((f) => sameAddress(f, a.email!))) own = true;
        }
        if (own) break;
      }
      if (!own) return true;
    }
    return false;
  }

  /** One new (or newly labelled) message in `acc`'s mailbox. Errors are logged, never thrown into the poll. */
  async consider(acc: EmailInAccount, m: GmailRaw): Promise<void> {
    const at: { botId: string | null; key: string | null } = { botId: null, key: null };
    try {
      await this.handle(acc, m, at);
    } catch (e) {
      log.warn("email in: message skipped", { account: acc.id, error: String((e as Error).message ?? e).slice(0, 200) });
      if (at.key) this.seen = this.seen.filter((k) => k !== at.key); // labelling it again tries again
      if (at.botId) this.d.failed(at.botId);
    }
  }

  private async handle(acc: EmailInAccount, m: GmailRaw, at: { botId: string | null; key: string | null }): Promise<void> {
    if (!acc.email || (m.labelIds ?? []).some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH")) return;
    const bots = this.d.bots();
    if (!bots.length) return;
    const r = await this.route(acc, m, bots);
    if (!r) return;
    // 4.3b: the task arrives on an account this Bot may use, or not at all.
    if (!this.d.allowed(r.bot.id, acc.id)) return;
    const key = `${r.bot.id}|${hdr(m, "Message-ID").trim() || `${acc.id}:${m.id}`}`;
    if (this.seen.includes(key)) return;
    this.seen.push(key);
    at.botId = r.bot.id;
    at.key = key;
    if (this.seen.length > SEEN_MAX) this.seen.splice(0, this.seen.length - SEEN_MAX);
    if (!(await this.ownerSent(acc, m))) {
      const from = addressesIn(hdr(m, "From"))[0] ?? "an unknown sender";
      log.info(`email in: not from the owner, no task bot=${r.bot.id} account=${acc.id}`);
      this.d.notice(r.bot.id, from);
      return;
    }
    const g = this.d.get(acc.id);
    if (!g) return;
    const full = await g<GmailRaw>(`/users/me/messages/${encodeURIComponent(m.id)}`, { format: "full" });
    const body = bodyOf(full.payload);
    const { owner, quoted, withheld } = ownerWords(body.text, {
      subject: hdr(full, "Subject") || hdr(m, "Subject"),
      attachedMessage: hasAttachedMessage(full.payload),
      foreignReply: await this.foreignReply(full),
    });
    const files: EmailInFile[] = [];
    for (const idRow of body.attachmentIds.slice(0, MAX_FILES)) {
      const [, attId = "", name = "", size = "0"] = /^([^:]*):(.*):(\d+)$/.exec(idRow) ?? [];
      if (!attId || !name || Number(size) > MAX_FILE_BYTES) continue;
      try {
        const a = await g<{ data?: string }>(`/users/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(attId)}`);
        if (a.data) files.push({ name, bytes: Buffer.from(a.data.replace(/-/g, "+").replace(/_/g, "/"), "base64") });
      } catch { /* named in the block, not attached */ }
    }
    this.d.deliver(r.bot.id, {
      key,
      text: owner,
      email: {
        account: acc.email, via: r.via, subject: hdr(full, "Subject") || hdr(m, "Subject"), gmailId: m.id, threadId: m.threadId ?? full.threadId ?? m.id,
        from: addressesIn(hdr(m, "From"))[0]!, quoted: quoted.slice(0, QUOTED_MAX), attachments: body.attachments.slice(0, 20),
        ...(withheld ? { withheld: true } : {}),
      },
      files,
    });
  }
}
