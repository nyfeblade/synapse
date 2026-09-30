/**
 * Bug 415 (security review of bug 410, M1): what outside content each Bot has read, kept whole for detection.
 *
 * The turn slot's `untrusted` list keeps the last 10 tool outputs, each cut at 4,000 characters, and dies with the
 * turn. The Full-auto intent check needs everything read since the owner's message, across nudges, ack-redrives
 * and new turns, with nothing clipped — so this log keeps, per Bot and per read, only what the checks use: the
 * email addresses, the links and sites, 8-word shingle hashes (to see a body copying what was read), and a short
 * head for the reviewer's excerpts. No whole texts are stored.
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export const LINKISH = /https?:\/\/[^\s"'<>)\]]+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|io|net|org|dev|app|site|co|us|uk|me|ai|xyz|info|biz|link|ly)\b/gi;
const SHINGLE = 8;
const HEAD = 1_500;
/** Kept this long: the intent check looks back at most 30 minutes, with room for a slow turn. */
const KEEP_MS = 2 * 60 * 60_000;
const MAX_READS = 200;

export interface OutsideRead { at: number; emails: Set<string>; links: Set<string>; shingles: Set<number>; head: string }
export interface OutsideView { any: boolean; emails: Set<string>; links: Set<string>; shingles: Set<number>; heads: string[] }

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** The 8-word shingles of a text (lowercased words and numbers), hashed. */
export function shingles(text: string): Set<number> {
  const w = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set<number>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(hash(w.slice(i, i + SHINGLE).join(" ")));
  return out;
}

export const linksIn = (text: string): string[] => (text.match(LINKISH) ?? []).map((l) => l.toLowerCase().replace(/[.,;:!?]+$/, ""));
export const emailsIn = (text: string): string[] => (text.match(EMAIL) ?? []).map((e) => e.toLowerCase());

export class OutsideLog {
  private reads = new Map<string, OutsideRead[]>();

  /** `lite`: shell output (bug 419) — only its addresses and links; no shingles and no excerpt for the reviewer. */
  record(botId: string, text: string, at: number, o: { lite?: boolean } = {}): void {
    if (!text) return;
    const emails = new Set(emailsIn(text));
    const links = new Set(linksIn(text));
    if (o.lite && !emails.size && !links.size) return;
    const list = (this.reads.get(botId) ?? []).filter((r) => at - r.at <= KEEP_MS);
    list.push({ at, emails, links, shingles: o.lite ? new Set() : shingles(text), head: o.lite ? "" : text.slice(0, HEAD) });
    this.reads.set(botId, list.slice(-MAX_READS));
  }

  /** Everything read at or after `since`. */
  since(botId: string, since: number): OutsideView {
    const list = (this.reads.get(botId) ?? []).filter((r) => r.at >= since);
    const v: OutsideView = { any: list.length > 0, emails: new Set(), links: new Set(), shingles: new Set(), heads: list.filter((r) => r.head).slice(-3).map((r) => r.head) };
    for (const r of list) {
      r.emails.forEach((x) => v.emails.add(x));
      r.links.forEach((x) => v.links.add(x));
      r.shingles.forEach((x) => v.shingles.add(x));
    }
    return v;
  }

  forget(botId: string): void {
    this.reads.delete(botId);
  }
}

/** One log for the host: the PostToolUse path writes it, the approval gate reads it. */
export const outsideLog = new OutsideLog();
