import { matchBots, type NamedBot } from "./call-names";

/**
 * Bug 134: voice commands on a call, matched in code on the final transcript (no model call):
 * "call Nova", "add Nova", "bring in Nova", "get Nova on the call", "can you call Nova" add a Bot;
 * "hang up on Nova", "remove Nova", "drop Nova" take one off, and so do the polite forms people
 * actually use — "Nova, you can go", "thanks Nova, you're good" (bug 158). The utterance is never a turn.
 */
export interface CallCommand {
  kind: "add" | "remove";
  /** The name as heard ("Disc Saver"). */
  heard: string;
  /** The Bots it could mean, best first: 1 = do it; more = ask on screen; none = "I couldn't find…". */
  matches: string[];
  /** Phase 2 (bug 213): the other names in the same utterance ("bring in Scout and Otto"), each the same way. */
  also?: { heard: string; matches: string[] }[];
}

/** "Scout and Otto", "Scout, Otto and Cy", "Scout & Otto", "Scout plus Otto". */
const SPLIT = /\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+plus\s+/i;

/**
 * Every name in a command's capture, each matched in `pool(heard)`. The whole capture is tried as one
 * name first, so a Bot whose name has "and" in it is still one Bot. Null when any part isn't a Bot
 * ("call Nova and tell her I'm late" is a request, not a command).
 */
function namesOf(raw: string, pool: (heard: string) => string[]): { heard: string; matches: string[] }[] | null {
  const whole = cleanName(raw);
  if (whole) { const m = pool(whole); if (m.length) return [{ heard: whole, matches: m }]; }
  const parts = raw.split(SPLIT).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return whole ? [{ heard: whole, matches: [] }] : null;
  if (parts.length > 6) return null;
  const heard = parts.map(cleanName);
  if (heard.some((h) => !h)) return null;
  // Bug 213 (review): several names only when EVERY one is a Bot — "add the header and the footer" is
  // something to say to the Bot, never a call command. (A single unknown name is still a command.)
  const names = heard.map((h) => ({ heard: h!, matches: pool(h!) }));
  return names.every((n) => n.matches.length) ? names : null;
}
const command = (kind: CallCommand["kind"], names: { heard: string; matches: string[] }[]): CallCommand =>
  ({ kind, heard: names[0]!.heard, matches: names[0]!.matches, ...(names.length > 1 ? { also: names.slice(1) } : {}) });

const LEAD = String.raw`^(?:(?:ok(?:ay)?|hey|please|so|and|also|now|alright|right)[,\s]+)*(?:(?:can|could|would|will) you[,\s]+|let'?s[,\s]+|i want to[,\s]+|go ahead and[,\s]+)?(?:please[,\s]+)?`;
const TAIL = String.raw`(?:[,\s]+(?:in|on|here|in here|on the call|onto the call|into the call|to the call|to this call|on this call|too|as well|please|now|for me|up))*[.!?\s]*$`;
const ADD = new RegExp(`${LEAD}(?:call|add|bring in|bring|invite|loop in|patch in|conference in|dial in|dial)[,\\s]+(.+?)${TAIL}`, "i");
/** "get Nova on the call" / "get Nova in here": "get" needs the call named, or it's an ordinary request. */
const GET = new RegExp(`${LEAD}get[,\\s]+(.+?)[,\\s]+(?:on the call|onto the call|into the call|in here|on here|on)[,\\s]*(?:too|as well|please|now)?[.!?\\s]*$`, "i");
const REMOVE = new RegExp(`${LEAD}(?:hang up on|remove|drop|kick out|kick|disconnect|let go of)[,\\s]+(.+?)(?:[,\\s]+(?:from the call|off the call|from this call|please|now|for now))*[.!?\\s]*$`, "i");
/**
 * Bug 158: the way people actually let a teammate go — the name first, then a dismissal
 * ("Otto, you can go", "thanks Otto, you're good"). Only ever a command when the name really is a
 * Bot on the call: unlike the verb forms above, the words alone are ordinary English.
 */
const BYE = String.raw`(?:you(?:'|’)?re|you are|your)\s+(?:good|all good|all set|done|free to go|free)|you(?:'|’)?re? (?:can|may) (?:go|head off|head out|hop off|drop off|take off|jump off)|you can (?:go|head off|head out|hop off|drop off|take off|jump off)|you may go|that'?s (?:all|it)(?: for (?:you|now))?|that'?ll be all|we'?re (?:good|done|all set)(?: here)?`;
const DISMISS = new RegExp(
  String.raw`^(?:(?:ok(?:ay)?|hey|so|and|also|alright|right|thanks|thank you|cheers|great|perfect|lovely|nice)[,\s]+)*(.+?)[,\s]+(?:${BYE})(?:[,\s]+(?:for now|from here|thanks|thank you|please|now))*[.!?\s]*$`, "i");

/** A name is at most 3 words: "call the plumber tomorrow at five" is a request for the Bot, not a command. */
function cleanName(raw: string): string | null {
  const n = raw.replace(/^(?:the|a|an|our|my)\s+/i, "").replace(/\s+(?:bot|the bot)$/i, "").replace(/[.!?,]+$/g, "").trim();
  if (!n || n.split(/\s+/).length > 3 || /\b(?:me|you|us|them|him|her|it|back|later|tomorrow|today|someone|anyone|everyone)\b/i.test(n)) return null;
  return n;
}

/**
 * `all`: every Bot the user could add (real Bots, not groups or archived); `onCall`: the Bots on the call.
 * An add matches among Bots not on the call; a remove, among those on it.
 */
export function parseCallCommand(text: string, all: NamedBot[], onCall: string[]): CallCommand | null {
  const t = text.trim();
  if (t.length > 80) return null;
  const on = () => all.filter((b) => onCall.includes(b.id));
  const rm = REMOVE.exec(t);
  if (rm) {
    const names = namesOf(rm[1]!, (h) => matchBots(h, on()));
    return names ? command("remove", names) : null;
  }
  // "Otto, you can go" / "thanks Otto, you're good": a command only when the name is a Bot on the call,
  // so "the deploy, you're good" stays an ordinary thing to say to the Bot.
  const bye = DISMISS.exec(t);
  if (bye) {
    const heard = cleanName(bye[1]!);
    const matches = heard ? matchBots(heard, on()) : [];
    if (heard && matches.length) return { kind: "remove", heard, matches };
  }
  const add = GET.exec(t) ?? ADD.exec(t);
  if (!add) return null;
  // Already on the call (and nobody else by that name): nothing to add, but it's still a command.
  const names = namesOf(add[1]!, (h) => { const off = matchBots(h, all.filter((b) => !onCall.includes(b.id))); return off.length ? off : matchBots(h, on()); });
  return names ? command("add", names) : null;
}

const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The Bots a typed name means exactly: the full name, the first name, or the name without spaces. */
function exactly(h: string, all: NamedBot[]): string[] {
  const full = all.filter((b) => plain(b.name) === h);
  if (full.length) return full.map((b) => b.id);
  return all.filter((b) => { const n = plain(b.name); return n.split(" ")[0] === h || n.replace(/ /g, "") === h.replace(/ /g, ""); }).map((b) => b.id);
}

/**
 * Phase 2 (bug 213): the command palette's "call Nova and Scout" / "call nova scout" — the Bots to start
 * ONE call with, in the order typed (the first is the call's anchor). Names may be split by "and",
 * commas or just spaces; a run of words is read as the longest name that fits ("disk saver nova").
 * Typed, not heard, so names match exactly. Null unless every word is part of exactly one Bot's name.
 */
export function parseGroupCall(query: string, all: NamedBot[]): string[] | null {
  const m = /^\s*(?:call|ring|dial)\s+(.+?)\s*$/i.exec(query);
  if (!m) return null;
  const out: string[] = [];
  for (const part of m[1]!.split(SPLIT)) {
    const words = plain(part).split(" ").filter(Boolean);
    let i = 0;
    while (i < words.length) {
      let found: string | null = null;
      let len = 0;
      for (let k = Math.min(3, words.length - i); k >= 1 && !found; k--) {
        const ids = exactly(words.slice(i, i + k).join(" "), all);
        if (ids.length > 1) return null;
        if (ids.length === 1) { found = ids[0]!; len = k; }
      }
      if (!found) return null;
      if (!out.includes(found)) out.push(found);
      i += len;
    }
  }
  return out.length ? out : null;
}
