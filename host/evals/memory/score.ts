export interface ExtractionCase {
  id: string; group: "must" | "none" | "mixed"; existing?: string[]; user: string; bot: string;
  expect: { tag: "profile" | "log" | "note" | "remove"; all: string[] }[]; forbid: string[];
  /** Also-correct memories the labels don't require: count as correct for precision, never for recall. */
  accept?: { tag: "profile" | "log" | "note" | "remove"; all: string[] }[];
}

export function scoreExtraction(results: { c: ExtractionCase; lines: { tag: string; content: string }[] }[]): { precision: number; recall: number; forbiddenHits: string[] } {
  let produced = 0, producedOk = 0, expected = 0, expectedOk = 0;
  const forbiddenHits: string[] = [];
  const matches = (e: ExtractionCase["expect"][number], l: { tag: string; content: string }) => e.tag === l.tag && e.all.every((k) => l.content.toLowerCase().includes(k.toLowerCase()));
  for (const { c, lines } of results) {
    produced += lines.length;
    producedOk += lines.filter((l) => [...c.expect, ...(c.accept ?? [])].some((e) => matches(e, l))).length;
    expected += c.expect.length;
    expectedOk += c.expect.filter((e) => lines.some((l) => matches(e, l))).length;
    for (const l of lines) if (c.forbid.some((f) => l.content.includes(f))) forbiddenHits.push(`${c.id}: ${l.content}`);
  }
  return { precision: produced ? producedOk / produced : 1, recall: expected ? expectedOk / expected : 1, forbiddenHits };
}

export function episodeRubric(text: string): { dates: boolean; past: boolean; sentences: boolean; noSecrets: boolean } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
  return {
    dates: /\b\d{4}-\d{2}-\d{2}\b/.test(text) && !/\b(today|yesterday|tomorrow|next week|last week)\b/i.test(text),
    past: /\b(\w+ed|sent|made|drafted|found|set|was|were|did|took|wrote|held|left|chose)\b/i.test(text),
    sentences: sentences >= 1 && sentences <= 2,
    noSecrets: !/(sk-|ghp_|password|\b\d{13,19}\b)/i.test(text),
  };
}
