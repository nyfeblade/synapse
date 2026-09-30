import { LIMITS } from "@synapse/shared";
import type { ModelMessage } from "../brain/types";
import { fillTemplate, loadPrompt } from "../prompts/index";

export interface RoomMessage { from: string; fromName: string; text: string; at: number }

/** Bug 434 follow-up: who wrote a room post, from the room's own record (never from a rendered display name). */
export type RoomAuthor = "owner" | "self" | "bot";
/** What a member turn showed of the room, structured, for Auto-review (set on the turn's slot by the orchestrator). */
export interface RoomReview { posts: { author: RoomAuthor; line: string }[]; join: string | null }

/** Common Cyrillic, Greek and small-capital letters that look like the Latin ones in "user" and "you". */
const LOOKALIKE: Record<string, string> = {
  "а": "a", "е": "e", "ё": "e", "о": "o", "р": "p", "с": "c", "у": "y", "ү": "y", "ѕ": "s", "і": "i", "г": "r", "ս": "u", "υ": "u", "ʋ": "u", "ο": "o",
  "ε": "e", "ʏ": "y", "ʀ": "r", "ᴜ": "u", "ꜱ": "s", "ᴇ": "e", "ᴏ": "o", "ʸ": "y", "ᵘ": "u", "ᵒ": "o", "ˢ": "s", "ᵉ": "e", "ʳ": "r",
};
/** A name folded for comparison: compatibility forms (full width, small forms), case, invisible characters, look-alikes. */
function fold(name: string): string {
  return [...name.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "")].map((c) => LOOKALIKE[c] ?? c).join("").normalize("NFKC");
}

/**
 * Bug 434 follow-up: how another Bot's name is shown in a room. "User" marks the owner and "<name> (you)" the member
 * itself, so a Bot name that folds to "user" or ends in a separate "you" (any case, width or look-alike) is shown
 * without brackets and with " (Bot)", e.g. `User (Bot):`. Other names are unchanged, so the prompt stays the same size.
 */
export function roomBotName(name: string): string {
  const f = fold(name);
  const letters = f.replace(/[^\p{L}\p{N}]/gu, "");
  const collides = letters === "user" || letters === "you" || /[^\p{L}\p{N}]you[^\p{L}\p{N}]*$/u.test(f);
  if (!collides) return name;
  const plain = name.normalize("NFKC").replace(/[\p{Ps}\p{Pe}\p{Cf}:]/gu, "").replace(/\s+/g, " ").trim();
  return `${plain || "Bot"} (Bot)`;
}

/** The history lines a member turn shows, oldest first, each with its structured author. */
function roomLines(history: RoomMessage[], meId: string): RoomReview["posts"] {
  return history.slice(-LIMITS.groupPromptHistory).map((m) => {
    const author: RoomAuthor = m.from === meId ? "self" : m.from === "user" ? "owner" : "bot";
    const who = author === "self" ? `${m.fromName} (you)` : author === "owner" ? "User" : roomBotName(m.fromName);
    return { author, line: `${who}: ${m.text.replace(/\s+/g, " ").trim()}` };
  });
}

/** The structured twin of renderMemberTurn's text: same lines, same join block. */
export function roomReviewOf(p: { me: { id: string }; history: RoomMessage[]; joinContext?: string }): RoomReview {
  return { posts: roomLines(p.history, p.me.id), join: p.joinContext?.trim() || null };
}

export function renderMemberTurn(p: { groupName: string; members: { id: string; name: string }[]; me: { id: string; name: string }; history: RoomMessage[]; redriveNote?: string; voiceCall?: boolean; joinContext?: string }): ModelMessage[] {
  const others = p.members.filter((m) => m.id !== p.me.id).map((m) => m.name);
  const lines = roomLines(p.history, p.me.id).map((x) => x.line);
  const text = fillTemplate(loadPrompt("wakes/group-member.md"), {
    GROUP: p.groupName,
    WITH: others.join(", "),
    ME: p.me.name,
    REDRIVE: p.redriveNote ? `${p.redriveNote}\n` : "",
    HISTORY: lines.length ? lines.join("\n") : "(no new messages)",
  });
  // Voice calls: the post was spoken in a group call, so the answer is spoken too.
  // Bug 108: a Bot added mid-call gets the call so far once, ahead of its first turn.
  const join = p.joinContext ? [{ text: p.joinContext }] : [];
  if (!p.voiceCall) return [...join, { text: text.trim() }];
  // Bug 134 (item 6): on a group call a Bot can hand a part to a teammate by name, and the floor goes to them next.
  const handOff = others.length
    ? [{ text: `On this call you can hand a part of the answer to a teammate by name, e.g. "${others[0]}, can you take the calendar part?"; they speak next. Only hand off real work, never just to be polite.` }]
    : [];
  return [...join, { text: text.trim() }, { text: loadPrompt("wakes/voice-call.md").trim() }, ...handOff];
}

const HISTORY_HEAD = "Messages since you last spoke:\n";
const HISTORY_END = "\nIt's your turn.";
const LEFT_OUT = "…[older room posts left out]…";

/**
 * Bug 434: what Auto-review reads of a group member's wake (renderMemberTurn's text), at most `max` characters.
 * A room's history runs oldest to newest, so the NEWEST posts are kept: the triggering (last) post whole, then older
 * ones while they fit, then the call-so-far block of a Bot added mid-call. The template's fixed lines are host text
 * and are left out once anything is cut. `unread` is set when an untrusted part is cut or the triggering untrusted
 * post alone is longer than `max`. Trust comes only from `review`, the room's structured record: the owner's and the
 * member's own posts are not outside text, another Bot's post and the call block are. Without it (a follow-up that
 * lost it, a changed template) every line is untrusted: a display name is never trusted, whatever it says.
 */
export function roomReviewText(text: string, max: number, review?: RoomReview | null): { untrusted: string[]; unread?: true } {
  if (text.length <= max) return { untrusted: text ? [text] : [] };
  let parts: { t: string; untrusted: boolean }[];
  if (review) {
    parts = review.posts.map((x) => ({ t: x.line, untrusted: x.author === "bot" }));
    if (review.join) parts.unshift({ t: review.join, untrusted: true });
  } else {
    const end = text.lastIndexOf(HISTORY_END);
    const head = end < 0 ? -1 : text.lastIndexOf(HISTORY_HEAD, end);
    // Not the member template: fail closed, as bug 432 does for peers.
    if (head < 0) return { untrusted: [text.slice(0, max)], unread: true };
    const lines = text.slice(head + HISTORY_HEAD.length, end).split("\n").filter((l) => l && l !== "(no new messages)");
    const joinAt = text.lastIndexOf("[Group chat: ", head);
    const join = joinAt > 0 ? text.slice(0, joinAt).trim() : "";
    parts = [...(join ? [join] : []), ...lines].map((t) => ({ t, untrusted: true }));
  }
  // Newest first: the triggering post always, then each older part only while the piece stays within `max`.
  const newestFirst = [...parts].reverse();
  const kept: string[] = [];
  let used = LEFT_OUT.length + 1;
  let unread = false;
  let full = true;
  for (const [i, p] of newestFirst.entries()) {
    if (i === 0) {
      kept.push(p.t);
      used += p.t.length;
      if (p.t.length > max && p.untrusted) unread = true;
      continue;
    }
    if (full && used + 1 + p.t.length <= max) { kept.push(p.t); used += 1 + p.t.length; continue; }
    full = false; // older than a part left out: left out too, so the reviewer reads one unbroken newest stretch
    if (p.untrusted) unread = true;
  }
  const out = kept.reverse();
  if (!full) out.unshift(LEFT_OUT);
  return { untrusted: [out.join("\n")], ...(unread ? { unread: true as const } : {}) };
}
