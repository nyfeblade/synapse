import type { TranscriptItem } from "./transcript-items";

/**
 * The Carbon look's document-style transcript: a Bot's turn — its steps, its words, its files, its
 * cards — reads as one document under ONE head (its face, its name, the time), the way the look study
 * draws it. These are the items a turn is made of; a group member's own post carries its own face and
 * name, and so is never part of the Bot's run.
 */
const BOT_SIDE = new Set<TranscriptItem["kind"]>(["bot", "activity", "file", "approval", "card", "widget", "form", "secret", "box-help", "connect-card"]);

export const isBotSide = (it: TranscriptItem): boolean => BOT_SIDE.has(it.kind) && !(it.kind === "bot" && it.author);

/** When the item happened, where the transcript knows it. */
function timeOfItem(it: TranscriptItem): number | null {
  switch (it.kind) {
    case "bot": case "file": case "widget": case "connect-card": return it.entry.createdAt;
    case "card": return "entry" in it ? it.entry.createdAt : null;
    case "activity": return it.steps[0]?.startedAt ?? null;
    default: return null;
  }
}

/** item key -> the time its head shows (null: no time to show), for every item that starts a Bot run. */
export function docHeads(items: readonly TranscriptItem[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let inRun = false;
  for (const it of items) {
    const side = isBotSide(it);
    if (side && !inRun) out.set(it.key, timeOfItem(it));
    // Anything that is not the Bot's (your message, a day separator, a notice, a member's post) ends the run.
    inRun = side;
  }
  return out;
}

/**
 * Whether the typing bubble at the foot gets a head of its own — the Bot's face, its name.
 *
 * IT ALMOST ALWAYS DOES. The rule used to be "only when the last item is not the Bot's", which
 * sounds right and is wrong in the case that matters: a Bot that has just run six tool steps, saved
 * a file and put an approval in front of you is *still inside its own run*, so the dots appeared as
 * a bare grey pill floating under a card, hundreds of pixels below the last time anything said who
 * was typing. Who is typing is the only thing a typing indicator is for.
 *
 * The one case that still gets no head is the dots directly under the Bot's own words: there the
 * dots are the next sentence of a paragraph that is already attributed an inch above them, and a
 * second face would be the same name twice in a row. That is also the case the dots-to-text morph
 * runs in (Transcript.tsx TypingBubble), where a head appearing and then vanishing mid-morph would
 * be a flicker rather than information.
 */
export const typingNeedsHead = (items: readonly TranscriptItem[]): boolean => {
  const last = items.at(-1);
  return !last || !(last.kind === "bot" && !last.author);
};

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const clockTime = (ms: number): string => CLOCK.format(ms);
