import { NOT_IN_DATA, type Truth } from "./corpus";

export interface Passage { id: string; date: string; text: string; sources?: string[] }

/**
 * The deterministic exact-match reader: a stand-in for the model reading what was loaded, with no
 * model. It finds "<key> is <value>" statements, dates each one by the nearest date on its own line
 * (a memory line's "(learned …)", a summary item's "(…)") or else its passage's date, and answers
 * with the latest value ("latest") or every distinct value oldest first ("all"). Nothing found →
 * NOT_IN_DATA, so it can never hallucinate: negatives only measure what an exact reader can.
 */
export function readAnswer(truth: Truth, passages: readonly Passage[]): string {
  const needle = `${truth.key.toLowerCase()} is `;
  const hits: { date: string; order: number; value: string }[] = [];
  let order = 0;
  for (const p of passages) {
    const lower = lowerOf(p);
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      const from = at + needle.length;
      const rest = p.text.slice(from);
      const m = /(\.(\s|$)|[;\n]|$)/.exec(rest)!;
      const value = rest.slice(0, m.index).trim();
      const lineStart = p.text.lastIndexOf("\n", at) + 1;
      const dates = p.text.slice(lineStart, at).match(/\d{4}-\d{2}-\d{2}/g);
      if (value) hits.push({ date: dates?.at(-1) ?? p.date, order: order++, value });
    }
  }
  if (!hits.length) return NOT_IN_DATA;
  hits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  if (truth.mode === "latest") return hits.at(-1)!.value;
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(norm(h.value)) && seen.add(norm(h.value))).map((h) => h.value).join(", ");
}

export const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Loading everything hands the same passage objects to every question; lower-case each once. */
const lowered = new WeakMap<Passage, string>();
function lowerOf(p: Passage): string {
  let v = lowered.get(p);
  if (v === undefined) { v = p.text.toLowerCase(); lowered.set(p, v); }
  return v;
}
