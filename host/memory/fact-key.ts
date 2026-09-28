/**
 * Memory provenance: a conservative, code-only reading of one memory sentence as (subject, predicate, value),
 * so a new value for the same subject and predicate can supersede the old one without a model call.
 *
 * Deliberately narrow. It reads a few English shapes the extractor writes ("The user's dentist is Kim.",
 * "Acme's budget is 55k.", "The budget for Acme is 55k.", "The design review happens on Tuesdays.",
 * "Dana manages the billing team.") and returns null for everything else, and for relations that
 * usually hold several values at once (a sister, a client, a friend). A null only means "no automatic
 * supersession": the extractor's own `remove:` + new line still pairs as one (MemoryStore.supersede).
 */
export interface FactKey { subject: string; predicate: string; value: string }

/** Relations people have several of: never keyed, so two of them never supersede each other. */
const MULTI = new Set([
  "sister", "sisters", "brother", "brothers", "sibling", "siblings", "friend", "friends", "client", "clients", "customer", "customers",
  "child", "children", "kid", "kids", "son", "sons", "daughter", "daughters", "cousin", "cousins", "colleague", "colleagues", "coworker",
  "coworkers", "teammate", "teammates", "pet", "pets", "dog", "dogs", "cat", "cats", "hobby", "hobbies", "project", "projects", "goal",
  "goals", "neighbor", "neighbors", "neighbour", "neighbours", "grandchild", "grandchildren", "parent", "parents", "report", "reports",
  "contact", "contacts", "account", "accounts", "tool", "tools", "language", "languages", "interest", "interests", "allergy", "allergies",
]);
const WORD = "[\\p{L}][\\p{L}\\p{N}-]*";
const clean = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").trim();
const subj = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/^(?:user|i|me|my)$/, "user").trim();
const norm = (s: string) => s.toLowerCase().trim();

const POSSESSIVE = new RegExp(`^(?:the )?(${WORD}(?: ${WORD}){0,2})['’]s ((?:${WORD} ){0,2}${WORD}) (?:is|are) (.+)$`, "iu");
const OF_FOR = new RegExp(`^the ((?:${WORD} ){0,2}${WORD}) (?:of|for) (?:the )?(${WORD}(?: ${WORD}){0,3}) (?:is|are) (.+)$`, "iu");
const WHEN = new RegExp(`^the ((?:${WORD} ){0,3}${WORD}) (?:happens|takes place|is held|meets) (?:on|at|every) (.+)$`, "iu");
const MANAGES = new RegExp(`^(${WORD}(?: ${WORD}){0,2}) (?:manages|leads|runs|heads) the ((?:${WORD} ){0,2}${WORD})$`, "iu");

export function factKey(sentence: string): FactKey | null {
  const s = clean(sentence);
  if (!s || s.length > 300 || /[;?]/.test(s)) return null;
  let m = POSSESSIVE.exec(s);
  if (m) {
    const predicate = norm(m[2]!);
    if (MULTI.has(predicate.split(" ").at(-1)!)) return null;
    return { subject: subj(m[1]!), predicate, value: norm(m[3]!) };
  }
  m = OF_FOR.exec(s);
  if (m) {
    const predicate = norm(m[1]!);
    if (MULTI.has(predicate.split(" ").at(-1)!)) return null;
    return { subject: subj(m[2]!), predicate, value: norm(m[3]!) };
  }
  m = WHEN.exec(s);
  if (m) return { subject: subj(m[1]!), predicate: "when", value: norm(m[2]!) };
  m = MANAGES.exec(s);
  if (m) return { subject: subj(m[2]!), predicate: "managed by", value: norm(m[1]!) };
  return null;
}
