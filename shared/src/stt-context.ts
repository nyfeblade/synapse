// Bug 162: what the speech recognizer is told to expect.
//
// Contextual strings are the single biggest accuracy win on names: on a fixed set of spoken samples
// they took word error rate from 16.8% to 6.9% and name accuracy from 25/54 to 48/54, at no run-time
// cost. The recognizer weighs each entry, so a huge list dilutes every one of them — hence the cap,
// and hence the priority order below, which spends the budget on what the user actually says.

/** The most contextual strings a session sends. Past this the bias per entry stops being useful. */
export const STT_CONTEXT_CAP = 300;

/** How much of the budget mined chat vocabulary may take. Names matter more than jargon. */
export const STT_MINED_CAP = 60;

/** The longest contextual string worth sending; the recognizer never matches a whole paragraph. */
export const STT_TERM_MAX = 60;

export interface SttContextSources {
  /** The user's Bot names — the words most often misheard, and the cheapest to get right. */
  botNames?: string[];
  /** Project and product terms the user says constantly ("Kokoro", "OrbStack", "Synapse"). */
  projectTerms?: string[];
  /** Mac app names, so "open OrbStack" resolves instead of becoming "orb stack". */
  appNames?: string[];
  /** Contact names, for "text Priya" / "call Priya". */
  contactNames?: string[];
  /** Recent chat text, mined for the unusual words this conversation keeps using. */
  recentText?: string;
}

/** Words that start a sentence and would otherwise look like a name because of the capital. */
const SENTENCE_STARTERS = new Set([
  "the", "a", "an", "i", "it", "we", "you", "they", "he", "she", "this", "that", "there", "here",
  "and", "but", "or", "so", "if", "when", "what", "who", "how", "why", "where", "can", "could",
  "would", "should", "will", "do", "does", "did", "is", "are", "was", "were", "be", "been", "have",
  "has", "had", "let", "please", "thanks", "thank", "ok", "okay", "yes", "no", "not", "my", "your",
  "our", "their", "his", "her", "its", "for", "from", "with", "without", "about", "after", "before",
  "just", "now", "then", "also", "still", "only", "very", "more", "most", "some", "any", "all",
]);

/** A term is worth biasing on if it is long enough to match and short enough to be a phrase. */
function usable(s: string): boolean {
  const t = s.trim();
  return t.length >= 2 && t.length <= STT_TERM_MAX && /\p{L}/u.test(t);
}

/**
 * Mine the unusual vocabulary out of recent chat text: CamelCase ("OrbStack"), capitalised words
 * that are not simply a sentence starter ("Kokoro"), and letter+digit tokens ("H100"). A word seen
 * once is noise; a word seen twice is this conversation's vocabulary.
 *
 * Deterministic: ties break alphabetically, so the same transcript always yields the same list.
 */
export function mineVocabulary(text: string, cap = STT_MINED_CAP): string[] {
  if (!text) return [];
  const counts = new Map<string, { term: string; n: number }>();
  // Split on anything that cannot be inside a word, keeping apostrophes out of the way.
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || raw.length > 30) continue;
    const inner = /\p{Ll}\p{Lu}/u.test(raw); // camelCase / OrbStack
    const capped = /^\p{Lu}\p{Ll}+$/u.test(raw) && !SENTENCE_STARTERS.has(raw.toLowerCase());
    const mixed = /\p{L}/u.test(raw) && /\p{N}/u.test(raw);
    if (!inner && !capped && !mixed) continue;
    const key = raw.toLowerCase();
    const seen = counts.get(key);
    // Keep the first spelling seen, so "OrbStack" wins over a later "orbstack".
    if (seen) seen.n += 1;
    else counts.set(key, { term: raw, n: 1 });
  }
  return [...counts.values()]
    .filter((c) => c.n >= 2)
    .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term))
    .slice(0, cap)
    .map((c) => c.term);
}

/**
 * The session's contextual strings, in the order the recognizer should spend its budget: Bot names
 * first (said most, misheard most), then the project and app terms, then contacts, then whatever
 * the recent chat has been about. Deduplicated case-insensitively, keeping the first spelling.
 */
export function buildSttContext(src: SttContextSources, cap = STT_CONTEXT_CAP): string[] {
  const ordered = [
    ...(src.botNames ?? []),
    ...(src.projectTerms ?? []),
    ...(src.appNames ?? []),
    ...(src.contactNames ?? []),
    ...mineVocabulary(src.recentText ?? ""),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().replace(/\s+/g, " ");
    if (!usable(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
