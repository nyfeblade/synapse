/** Deterministic synthetic memory for the ORIG-05 §05.5 recall eval. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SYL = ["mar", "lin", "dov", "keth", "sor", "vane", "brix", "tal", "quen", "rho", "dess", "mir", "cal", "fen", "orr", "zel", "pim", "war", "gald", "sten"];
const RELATIONS = ["landlord", "dentist", "accountant", "plumber", "tutor", "mechanic", "florist", "barber", "lawyer", "trainer"];
const CITIES = ["Denver", "Lisbon", "Osaka", "Tallinn", "Quito", "Perth", "Oslo", "Tucson"];
const THINGS = ["quarterly", "invoice", "garden", "podcast", "renovation", "newsletter", "fundraiser", "workshop"];

export function generateRecallCorpus(seed = 7): { facts: { content: string; date: string }[]; queries: { text: string; relevant: string[] }[]; empty: string[] } {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const names = new Set<string>();
  while (names.size < 1200) names.add(`${pick(SYL)}${pick(SYL)}${pick(SYL)}`.replace(/^./, (c) => c.toUpperCase()));
  const surnames = [...names];
  const facts: { content: string; date: string }[] = [];
  const date = () => `2026-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`;
  for (let i = 0; i < 2000; i++) {
    const s = surnames[i % surnames.length]!;
    const kind = i % 4;
    const content = kind === 0 ? `The user's ${pick(RELATIONS)} is ${s}, reachable by phone on weekdays.`
      : kind === 1 ? `The ${pick(THINGS)} review with ${s} moved to the second week of the month.`
      : kind === 2 ? `The user booked a trip to ${pick(CITIES)} and ${s} handles the itinerary.`
      : `The user prefers the ${pick(THINGS)} drafts from ${s} as plain text.`;
    facts.push({ content, date: date() });
  }
  // 50 labeled queries: the surname (unique to ≤2 facts) plus a content word of its fact
  const queries: { text: string; relevant: string[] }[] = [];
  for (let q = 0; q < 50; q++) {
    const idx = 1300 + q * 13; // surnames reused at idx % 1200 make some queries have two relevant facts
    const s = surnames[idx % surnames.length]!;
    const relevant = facts.filter((f) => f.content.includes(` ${s},`) || f.content.includes(` ${s} `)).map((f) => f.content);
    const word = relevant[0]!.match(/landlord|dentist|accountant|plumber|tutor|mechanic|florist|barber|lawyer|trainer|review|trip|drafts/)![0];
    queries.push({ text: `${s} ${word}?`, relevant });
  }
  const empty = ["zeppelin quartz orchard", "saxophone lessons", "volcano hiking boots", "marmalade recipe", "chess openings", "sourdough starter", "bicycle chain grease", "violin rosin", "aquarium filter", "kayak paddle", "origami cranes", "telescope eyepiece", "pottery glaze", "fencing epee", "curling stones", "ukulele chords", "beekeeping smoker", "falconry gloves", "lighthouse tours", "glacier trekking"];
  return { facts, queries, empty };
}
