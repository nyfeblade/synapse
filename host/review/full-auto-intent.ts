import type { FullAutoResult } from "@synapse/shared";
import type { WakeSource } from "../brain/types";
import { emailsIn, linksIn, shingles, type OutsideView } from "./outside-log";
import type { OriginKind, RiskTarget } from "./types";

/**
 * Bug 410 — Full auto: an action the owner directly asked for runs with no card.
 *
 * The owner's words: "The bot asks for too many permissions even while on full auto." (typing "Add a google meet
 * with Uncle John to my calendar please. 3:45 PM ET." still raised a card), and bug 159: "If I give the bot full
 * auto, it should not give me approval cards for anything except deletion, sending money…".
 *
 * So in Full auto a SEND on one of a few known tools goes through two layers instead of straight to a card:
 *   (a) the deterministic floors in this file — any hit is a card, and the reviewer is never asked;
 *   (b) otherwise the reviewer model, told it is an intent check (ReviewRequest.fullAutoIntent). It allows only
 *       when the action clearly matches the owner's own latest message; anything else, or any doubt, is a card.
 * Bugs 412–418 (the security review, "fix first") hardened it: an allow-list of send tools, recipients resolved on
 * the host, whole-token name matching, a whole outside-content log, copied-content and per-message limits, and a
 * recent-request rule.
 */

/**
 * Bug 412 (M4): the only tools that can skip the card. Every other write — generic MCP tools, uploads, updates,
 * overwrites, anything unknown or added later — cards in Full auto exactly as before. Keep this short.
 */
const INTENT_TOOLS: Record<string, ReadonlySet<string>> = {
  google_write: new Set(["gmail_send", "calendar_create", "calendar_update"]),
  composio_write: new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "SLACK_SEND_MESSAGE", "SLACK_CHAT_POST_MESSAGE", "GOOGLECALENDAR_CREATE_EVENT"]),
};
/** Composio slugs whose real recipients must be looked up on the host (bug 413). */
export const RESOLVE_SLUGS: ReadonlySet<string> = new Set(["GMAIL_REPLY_TO_THREAD", "SLACK_SEND_MESSAGE", "SLACK_CHAT_POST_MESSAGE"]);

/** A SEND on an allow-listed tool is eligible; destruction, money, security and every other tool card. */
export function fullAutoIntentEligible(target: RiskTarget, fa: FullAutoResult | null): boolean {
  if (!fa?.ask || fa.category !== "send") return false;
  return INTENT_TOOLS[target.action]?.has(String(target.arguments.tool ?? "")) ?? false;
}

/**
 * Wakes that carry the owner's own words in the chat. Everything else (routines, webhooks, email and other
 * listeners, broadcasts, other Bots, group members, revivals, kickstart) is not the owner asking for this action.
 */
export const OWNER_SOURCES: ReadonlySet<WakeSource> = new Set<WakeSource>(["user", "reply-nudge", "closing-nudge", "ack-redrive", "widget-answer", "form-answer", "voice-delegate", "loop-continue"]);

export const BULK_VALUE = /^(all|everyone|everybody|@channel|@everyone|@here|\*)$/i;
export const RECIPIENT_KEY = /^(to|cc|bcc|recipients?|recipient_emails?|extra_recipients|attendees|guests|invitees|members|users|user_ids|emails|channels|participants|people)$/i;
/** Argument keys whose text is the message, not who gets it. */
const BODY_KEY = /^(body|message_body|text|markdown_text|subject|description|summary|content|html)$/i;
/** Bug 412: a destructive flag riding on a send (a TRASH/SPAM label, delete-after-send …). */
const DESTRUCTIVE_KEY = /(trash|spam|delete|remove|discard|archive|purge|destroy)/i;
const DESTRUCTIVE_VALUE = /^(trash|spam)$/i;
/** The host's own card facts and the draft it fetched (the draft's recipients ARE counted, below). */
/** 4.3b: `account` is the owner's own account the host resolved (who it is sent FROM, never a recipient). */
const HOST_KEYS = new Set(["card_facts", "content_hash", "draft_hash", "account"]);

/** 4.3b: the owner's own addresses (every connected account), lowercased. */
export type SelfAddrs = string | readonly string[] | null;
export const selfSet = (self: SelfAddrs): Set<string> => new Set((typeof self === "string" ? [self] : self ?? []).map((e) => e.toLowerCase()));

/** A calendar write (the built-in Google tool or a Composio calendar slug). */
const CALENDAR_TOOL = /(^|_)(calendar|googlecalendar|event|events|meeting)(_|$)/;
/** The owner explicitly asking for other people to hear about it. */
const INVITE_ASK = /\b(invit\w*|send (?:\w+ ){0,3}(?:an? )?(?:invite|invitation|it|this)|share (?:it|this)?\s*with|loop (?:\w+ )?in|let (?:\w+ ){1,3}know|notify|include (?:\w+ ){0,3}(?:as a guest|on the invite)|add (?:\w+ ){1,3}as (?:a )?guests?)\b/i;
/** Bug 416: the owner asking for something they read to be passed on. */
const FORWARD_ASK = /\b(forward\w*|pass (?:it |this |that )?(?:on|along)|quote|paste|copy|attach\w*|include (?:the|that|this|it)|send (?:him|her|them|it|this|that|the \w+|a copy))\b/i;

/** More than this many recipients (or items) is a bulk action, which always asks. */
export const FULL_AUTO_BULK_MAX = 5;
/** Bug 417 (M3): at most this many intent-allowed sends per owner message. */
export const FULL_AUTO_SENDS_PER_MESSAGE = 5;

/** Words that aren't a person's name: request words and role mailboxes (report@, notifications@, team@ …). */
const STOP = new Set(["add", "and", "the", "for", "with", "please", "meet", "meeting", "meetings", "google", "calendar", "email", "emails", "mail",
  "send", "invite", "call", "today", "tomorrow", "event", "reply", "draft", "message", "can", "you", "him", "her", "them", "his", "our", "your",
  "about", "this", "that", "from", "into", "onto", "set", "book", "schedule", "put", "make", "new", "next", "week", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "gmail", "com", "net", "org", "uncle", "aunt", "mom", "dad", "just",
  "report", "reports", "notification", "notifications", "notify", "info", "admin", "support", "team", "hello", "contact", "sales",
  "noreply", "billing", "security", "alerts", "alert", "news", "updates", "update", "service", "help", "digest", "notes", "office", "mailer"]);

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function walk(v: unknown, visit: (key: string | null, v: unknown) => void, key: string | null = null): void {
  visit(key, v);
  if (Array.isArray(v)) for (const x of v) walk(x, visit, key);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, visit, k);
}

/** The arguments the tool will run with (and the draft the host fetched), without host-added card text. */
function argsOf(target: RiskTarget): Record<string, unknown> {
  return Object.fromEntries(Object.entries(target.arguments).filter(([k]) => !HOST_KEYS.has(k)));
}

/** Every distinct address the send reaches: every address outside the message text, lowercased. */
export function recipientsOf(target: RiskTarget): string[] {
  const out: string[] = [];
  walk(argsOf(target), (k, v) => { if (typeof v === "string" && !(k && BODY_KEY.test(k))) out.push(...emailsIn(v)); });
  return [...new Set(out)];
}

/** The message text the send carries (body, text, the fetched draft's body …). */
function bodyOf(target: RiskTarget): string {
  const out: string[] = [];
  walk(argsOf(target), (k, v) => { if (typeof v === "string" && k && BODY_KEY.test(k)) out.push(v); });
  return out.join("\n");
}

/**
 * Bug 414 (H2): an address the owner named: written out in their message, their own address, or an address whose
 * name part has a WHOLE token equal to a name in their message ("Uncle John" → john.harper@…, john-harper7@…).
 * No substrings (johnevil@ is not John), no role words (report@, notifications@), no token shorter than 3.
 */
export function recipientLinked(email: string, userText: string, self: SelfAddrs): boolean {
  const e = email.toLowerCase();
  if (userText.toLowerCase().includes(e) || selfSet(self).has(e)) return true;
  return nameMatches(e, userText).length > 0;
}

/** The whole name tokens of an address (john.harper7@ → john, harper). */
const nameTokens = (email: string): string[] => (email.toLowerCase().split("@")[0] ?? "").split(/[._\-+0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));

/** The address's name tokens that are names in the owner's message. */
export function nameMatches(email: string, userText: string): string[] {
  const words = new Set((userText.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));
  return nameTokens(email).filter((t) => words.has(t));
}

/** Bug 412: a destructive flag riding on a send (a TRASH/SPAM label, delete-after-send, a cancelled event). */
export function hasDestructiveFlag(target: RiskTarget): boolean {
  const args = argsOf(target);
  let destructive = /"status":"cancel+ed"/i.test(JSON.stringify(args));
  walk(args, (k, v) => {
    if (k && DESTRUCTIVE_KEY.test(k) && v !== false && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) destructive = true;
    if (typeof v === "string" && DESTRUCTIVE_VALUE.test(v.trim())) destructive = true;
  });
  return destructive;
}

/** A bulk value on a recipient field (@channel, everyone, *) or an @channel mention anywhere. */
export function hasBulkValue(target: RiskTarget): boolean {
  let bulk = false;
  walk(argsOf(target), (k, v) => {
    if (typeof v === "string" && k && RECIPIENT_KEY.test(k) && BULK_VALUE.test(v.trim())) bulk = true;
    if (typeof v === "string" && /(^|\s)@(channel|everyone|here|all)\b/i.test(v)) bulk = true;
  });
  return bulk;
}

/**
 * Smarter approvals (follow-up 2): trust covers who a send goes to, not what outside content may carry. True when
 * the send's text copies what the Bot read (two or more 8-word shingles the owner didn't write themselves), or
 * carries a link or site only outside content named. No "forward" exemption here: a plan or a trusted recipient
 * never lets copied outside text through without a card.
 */
export function carriesOutside(target: RiskTarget, request: string, outside: OutsideView, self: SelfAddrs): boolean {
  if (!outside.any && !outside.links.size) return false;
  const lower = request.toLowerCase();
  const mine = shingles(request);
  let hits = 0;
  for (const h of shingles(bodyOf(target))) if (outside.shingles.has(h) && !mine.has(h) && ++hits >= 2) return true;
  const recipients = recipientsOf(target);
  const links = [...new Set(linksIn(JSON.stringify(argsOf(target))))].filter((u) => !recipients.some((r) => r.endsWith(u) || r.includes(`@${u}`)));
  const own = selfSet(self);
  return links.some((u) => outside.links.has(u) && !lower.includes(u) && !own.has(u));
}

export interface IntentFloorInput {
  target: RiskTarget;
  /** What woke the Bot (the turn's source, or the parent turn's for a subagent). */
  source: WakeSource | null;
  origin: OriginKind;
  /** The owner's current request: their messages since the Bot's last reply, within 30 minutes (bug 418). */
  userMessages: string[];
  /** Outside content (bug 415): shingles and heads since the owner's request; addresses and links from the whole
   *  kept log, before the request too (bug 421). */
  outside: OutsideView;
  /** The owner's own address(es): 4.3b, every connected account. */
  self: SelfAddrs;
  /** 4.3b: the account this send uses and the owner's accounts for its app (null: one account, nothing to choose). */
  account?: AccountChoice | null;
  /** Bug 413: recipients and channels resolved on the host; null = they couldn't be resolved. */
  resolved: { recipients: string[]; channels: { name: string; members: number }[] } | null;
  /** Bug 417: intent-allowed sends already made for this request. */
  sentForRequest: number;
  /** Bug 420: recipients the owner has sent mail to before (their Sent folder, checked on the host). */
  known?: ReadonlySet<string>;
}

/** Bug 440: argument keys that name who a send reaches (an address, a person, a channel). */
const WHO_KEY = /^(to|cc|bcc|recipients?|recipient_emails?|extra_recipients|to_emails?|to_address(es)?|email_address(es)?|attendees|guests|invitees|members|users|user_ids|emails|participants|people|channels)$/i;
/** Message sends: they always reach somebody, so a send the host can place nowhere is one it couldn't check. */
const MESSAGE_SEND = /(^|_)(gmail_send|send_email|reply_to_thread|send_message|post_message)$/;
export const UNRESOLVED_REASON = "Who this goes to couldn't be checked, so it needs your OK.";

/**
 * Bug 440: a recipient field holding something the host can't resolve: not an address (a name, a user id, a list the
 * host didn't look up), and not a channel the host found. Quoted display names ("Smith, John" <j@x>) are fine.
 */
export function unresolvedWho(target: RiskTarget, resolved: { channels: { name: string }[] }): boolean {
  const channels = new Set(resolved.channels.map((c) => c.name.toLowerCase().replace(/^#/, "")));
  let unresolved = false;
  walk(argsOf(target), (k, v) => {
    if (!k || !WHO_KEY.test(k) || unresolved) return;
    if (typeof v === "number") { unresolved = true; return; }
    if (typeof v !== "string") return;
    for (const part of v.replace(/"[^"]*"/g, '""').split(/[,;\n]/)) {
      const p = part.trim();
      if (!p || BULK_VALUE.test(p)) continue; // bulk values are their own card
      if (emailsIn(p).length) continue;
      if (/^channels$/i.test(k) && channels.has(p.toLowerCase().replace(/^#/, ""))) continue;
      unresolved = true;
    }
  });
  return unresolved;
}

/**
 * Bug 440: the host couldn't check who this send reaches: the lookup failed, a recipient field holds something it
 * can't resolve, or a message send it can place nowhere at all (no address, no channel). A calendar event with no
 * guests reaches nobody and is fine.
 */
export function unresolvedRecipient(target: RiskTarget, resolved: { recipients: string[]; channels: { name: string }[] } | null): boolean {
  if (!resolved || unresolvedWho(target, resolved)) return true;
  // A bulk value (@channel, everyone) is its own card, with its own line.
  if (!MESSAGE_SEND.test(snake(String(target.arguments.tool ?? ""))) || hasBulkValue(target)) return false;
  const recipients = new Set([...recipientsOf(target), ...resolved.recipients.map((r) => r.toLowerCase())]);
  return recipients.size === 0 && resolved.channels.length === 0;
}

/** Not the owner's own request (a routine, an app, another Bot, no message at all): the card keeps the classifier's line. */
export const NOT_ASKED = "";

/**
 * (a) The deterministic floors. A non-null answer is a card and the reviewer is not asked; a non-empty one is the
 * card's reason (NOT_ASKED keeps the classifier's own line, e.g. "This sends an email from your account.").
 */
export function fullAutoIntentFloor(i: IntentFloorInput): string | null {
  if (i.origin !== "user" || !i.source || !OWNER_SOURCES.has(i.source)) return NOT_ASKED;
  const request = i.userMessages.join("\n").trim();
  if (!request) return NOT_ASKED;
  // Bug 440: a recipient the host couldn't resolve (or a message send it can place nowhere) never reaches the reviewer.
  if (!i.resolved || unresolvedRecipient(i.target, i.resolved)) return UNRESOLVED_REASON;
  const lower = request.toLowerCase();
  const mine = selfSet(i.self);
  const tool = snake(String(i.target.arguments.tool ?? ""));
  const args = argsOf(i.target);

  // Bug 412: a destructive flag on an allow-listed send (a TRASH/SPAM label, delete-after-send, a cancelled event).
  if (hasDestructiveFlag(i.target)) return "This also deletes, trashes or cancels something, so it needs your OK.";

  // 4.3b: the account it sends from must be the one the owner named (or the only one this Bot can use).
  const acct = i.account ? accountFloor(i.account, request) : null;
  if (acct) return acct;

  if (i.sentForRequest >= FULL_AUTO_SENDS_PER_MESSAGE) return `This would be send number ${i.sentForRequest + 1} for one message from you, so it needs your OK.`;

  const recipients = [...new Set([...recipientsOf(i.target), ...i.resolved.recipients.map((r) => r.toLowerCase())])];
  const channels = i.resolved.channels;
  const named = (c: string) => new RegExp(`(^|[^\\w-])#?${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(lower);
  let bulk = recipients.length > FULL_AUTO_BULK_MAX;
  walk(args, (k, v) => {
    if (Array.isArray(v) && k && RECIPIENT_KEY.test(k) && v.length > FULL_AUTO_BULK_MAX) bulk = true;
    if (typeof v === "string" && k && RECIPIENT_KEY.test(k) && BULK_VALUE.test(v.trim())) bulk = true;
    if (typeof v === "string" && /(^|\s)@(channel|everyone|here|all)\b/i.test(v)) bulk = true;
  });
  if (channels.some((c) => c.members > FULL_AUTO_BULK_MAX && !named(c.name))) bulk = true;
  if (bulk) return `This reaches more than ${FULL_AUTO_BULK_MAX} people or items at once, so it needs your OK.`;
  const unnamedChannel = channels.find((c) => !named(c.name));
  if (unnamedChannel) return `This posts in #${unnamedChannel.name}, which you didn't name, so it needs your OK.`;

  // Bugs 414/415: a link, site or address that outside content read since your message named, and you didn't write.
  const own = (x: string) => lower.includes(x) || mine.has(x);
  const links = [...new Set(linksIn(JSON.stringify(args)))].filter((u) => !recipients.some((r) => r.endsWith(u) || r.includes(`@${u}`)));
  if (links.some((u) => i.outside.links.has(u) && !own(u))) return "Part of this came from an email, web page or file, not from you, so it needs your OK.";
  // Bug 420: someone the owner has mailed before, named in their message, is fine even when the Bot found the
  // address by searching — unless outside content also offered a DIFFERENT address for that name (the redirect trick).
  const redirect = (r: string) => nameMatches(r, request).some((t) => [...i.outside.emails].some((x) => x !== r && !own(x) && nameTokens(x).includes(t)));
  if (recipients.some((r) => !own(r) && redirect(r))) return "An email, web page or file offered a different address for this person, so it needs your OK.";
  const knownOk = (r: string) => (i.known?.has(r) ?? false) && nameMatches(r, request).length > 0;
  if (recipients.some((r) => i.outside.emails.has(r) && !own(r) && !knownOk(r))) return "This goes to an address an email, web page or file gave, not you, so it needs your OK.";

  // Bug 418: on a call, the address must be in the owner's own words.
  if (i.source === "voice-delegate" && recipients.some((r) => !own(r))) return "On a call, the address has to be one you said, so it needs your OK.";

  // The owner's correction (2026-09-29): "Sorry, I didn't want you to send him an invite … Do not send anything to
  // him." An event with guests emails them, so it is a message: it runs only when the owner explicitly asked to
  // invite, send or share. "Add a meeting with Uncle John" asks for an event on their own calendar, nothing more.
  const others = recipients.filter((r) => !mine.has(r));
  if (others.length && CALENDAR_TOOL.test(tool) && !INVITE_ASK.test(lower)) return "This would send a calendar invite, and you didn't ask to invite anyone, so it needs your OK.";
  // Bug 421: an address the owner didn't write out must be a known contact (mailed before) AND carry a name from
  // their message; a name match alone isn't enough.
  const unnamed = recipients.filter((r) => !own(r) && !knownOk(r));
  if (unnamed.length) return `This goes to ${unnamed.slice(0, 2).join(", ")}${unnamed.length > 2 ? " and others" : ""}, who you didn't mention, so it needs your OK.`;

  // Bug 416 (M2): the body copies text the Bot read (an invoice, an email) that the owner didn't ask to pass on.
  if (i.outside.any && others.length + channels.length > 0 && !FORWARD_ASK.test(lower)) {
    const mine = shingles(request);
    let hits = 0;
    for (const h of shingles(bodyOf(i.target))) if (i.outside.shingles.has(h) && !mine.has(h) && ++hits >= 2) break;
    if (hits >= 2) return "This passes on text from an email, web page or file you didn't ask to forward, so it needs your OK.";
  }
  return null;
}

/**
 * 4.3b: which of the owner's accounts a send uses. `used` is the label the host resolved (an address for Google),
 * `granted` the labels this Bot may use, `all` every account the owner has for this app.
 */
export interface AccountChoice { used: string; granted: readonly string[]; all: readonly string[] }

/** Mail providers whose domain says nothing about which account (gmail.com is everybody's). */
const GENERIC_DOMAINS = new Set(["gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "icloud", "me", "mac", "proton", "protonmail", "pm", "aol", "gmx", "fastmail", "hey", "zoho", "yandex", "mail"]);

/** The words that name one account: the whole label, its name tokens, and a work domain (work@acme.com → work, acme). */
function accountWords(label: string): string[] {
  const l = label.toLowerCase().trim();
  const [local = "", domain = ""] = l.includes("@") ? l.split("@") : [l, ""];
  const words = local.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  const org = domain.split(".")[0] ?? "";
  if (org.length >= 3 && !GENERIC_DOMAINS.has(org)) words.push(org);
  return [...new Set(words)];
}

/** The accounts the owner's request names: by the whole label, or by a word no other account of theirs carries. */
export function accountsNamed(all: readonly string[], request: string): string[] {
  const lower = request.toLowerCase();
  // Recipients' addresses aren't the owner naming their own account ("email dana@acme.com" isn't "from acme").
  const words = new Set((lower.replace(/[^\s<>(),;:"']+@[^\s<>(),;:"']+/g, " ").match(/[a-z0-9]+/g) ?? []));
  const byWord = new Map<string, string[]>();
  for (const a of all) for (const w of accountWords(a)) byWord.set(w, [...(byWord.get(w) ?? []), a]);
  return all.filter((a) => lower.includes(a.toLowerCase()) || accountWords(a).some((w) => words.has(w) && byWord.get(w)!.length === 1));
}

/**
 * 4.3b: outside content can't pick the account. A request that names an account must get that one; with more than
 * one account this Bot can use, a request that names none cards rather than letting the Bot's choice stand.
 */
export function accountFloor(c: AccountChoice, request: string): string | null {
  if (c.all.length <= 1) return null;
  const named = accountsNamed(c.all, request);
  const used = c.used.toLowerCase();
  if (named.length) return named.some((a) => a.toLowerCase() === used) ? null : `You asked for ${named[0]}, but this uses ${c.used}, so it needs your OK.`;
  if (c.granted.length > 1) return `You didn't say which account to use, and this uses ${c.used}, so it needs your OK.`;
  return null;
}
