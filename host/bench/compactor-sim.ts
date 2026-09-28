import { fillTemplate, loadPrompt } from "../prompts/index";

/**
 * A deterministic stand-in for OUR /compact run (context/compact-query.ts with prompts/orig/compact.md).
 * The real summary is written by the model; this keeps its shape and its rules without one:
 *  - the categories compact.md keeps, in its order (1 preferences … 7 waiting on the user);
 *  - "Drop: small talk … and superseded plans": asides never enter, a newer value for the same
 *    slot replaces the older one, a finished task leaves;
 *  - each summary is made from the previous summary plus the turns since (a chain), capped at
 *    the brief's ~1,500 tokens, so a saturated chain forgets its oldest decisions first;
 *  - the prompt's exact closing line.
 */
export type Category = "preference" | "task" | "commitment" | "decision" | "identifier" | "error" | "waiting";
export const CATEGORY_ORDER: readonly Category[] = ["preference", "task", "commitment", "decision", "identifier", "error", "waiting"];
const HEADINGS: Record<Category, string> = {
  preference: "Standing requests and preferences", task: "Open tasks", commitment: "Commitments to the user", decision: "Decisions",
  identifier: "Identifiers", error: "Errors and fixes", waiting: "Waiting on the user",
};
/** Live items first (what the Bot must act on), then the record, each newest first. */
const LIVE = new Set<Category>(["preference", "task", "commitment", "waiting"]);

export interface SummaryItem { cat: Category; slot: string; date: string; text: string; sources: string[] }
export type SummaryEvent = { op: "add"; item: SummaryItem } | { op: "close"; slot: string };

export function compactFooter(botId: string): string {
  const prompt = fillTemplate(loadPrompt("orig/compact.md"), { botName: "Bot", botId });
  const m = /"(Full history: [^"]+)"/.exec(prompt);
  if (!m) throw new Error("compact.md lost its closing line");
  return m[1]!;
}

export function applyEvents(prev: SummaryItem[], events: SummaryEvent[]): SummaryItem[] {
  const bySlot = new Map(prev.map((i) => [i.slot, i]));
  for (const e of events) {
    if (e.op === "close") bySlot.delete(e.slot);
    else { bySlot.delete(e.item.slot); bySlot.set(e.item.slot, e.item); }
  }
  return [...bySlot.values()];
}

const newestFirst = (a: SummaryItem, b: SummaryItem) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
const line = (i: SummaryItem) => `- (${i.date}) ${i.text}`;

/** Keeps what fits in maxChars: live items up to 40% of the room, then the record, then any live remainder. */
export function budgetItems(items: SummaryItem[], maxChars: number): SummaryItem[] {
  const live = items.filter((i) => LIVE.has(i.cat)).sort(newestFirst);
  const record = items.filter((i) => !LIVE.has(i.cat)).sort(newestFirst);
  const kept: SummaryItem[] = [];
  let used = 0;
  const take = (xs: SummaryItem[], cap: number) => {
    for (const i of xs) {
      if (kept.includes(i)) continue;
      const n = line(i).length + 1;
      if (used + n > cap) break;
      kept.push(i);
      used += n;
    }
  };
  take(live, maxChars * 0.4);
  take(record, maxChars);
  take(live, maxChars);
  return kept;
}

export function renderSummary(p: { items: SummaryItem[]; n: number; upTo: string; botId: string; maxTokens: number }): { text: string; items: SummaryItem[] } {
  const head = `Summary ${p.n} of this conversation, up to ${p.upTo}. It replaces the earlier history.\n`;
  const foot = compactFooter(p.botId);
  const headingsRoom = CATEGORY_ORDER.reduce((a, c) => a + HEADINGS[c].length + 6, 0);
  const kept = budgetItems(p.items, p.maxTokens * 4 - head.length - foot.length - headingsRoom - 4);
  const blocks = CATEGORY_ORDER.map((c, i) => {
    const xs = kept.filter((k) => k.cat === c).sort((a, b) => -newestFirst(a, b));
    return xs.length ? `${i + 1}. ${HEADINGS[c]}\n${xs.map(line).join("\n")}` : "";
  }).filter(Boolean);
  return { text: `${head}\n${blocks.join("\n\n")}\n\n${foot}\n`, items: kept };
}
