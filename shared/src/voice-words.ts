/**
 * Bug 220 (voice-smooth plan item 9, the matcher half): whether two transcripts of one utterance say the same thing.
 *
 * A speculative start is made on Apple's live partial and kept only if the final says the same words. In Full mode
 * the final is Whisper's re-read, and the two engines write the same speech differently — "ten" / "10", "what's" /
 * "what is", "e-mail" / "email", "um" / nothing, case and punctuation — so an exact match threw the start away on
 * turns where nothing was misheard. This puts both into one canonical spoken form. It is NOT fuzzy: every content
 * word, name and number must still be equal, because a different one is a different request.
 */

const DISFLUENCY = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "hm", "mm", "mmm"]);

const CONTRACTIONS: Record<string, string> = {
  "what's": "what is", "that's": "that is", "it's": "it is", "there's": "there is", "here's": "here is", "he's": "he is",
  "she's": "she is", "who's": "who is", "where's": "where is", "how's": "how is", "when's": "when is", "why's": "why is",
  "let's": "let us", "i'm": "i am", "can't": "can not", "cannot": "can not", "won't": "will not", "shan't": "shall not",
  "ain't": "is not",
};
const SUFFIX: [RegExp, string][] = [[/n't$/, " not"], [/'re$/, " are"], [/'ve$/, " have"], [/'ll$/, " will"], [/'d$/, " would"]];

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function expand(tok: string): string[] {
  const c = CONTRACTIONS[tok];
  if (c) return c.split(" ");
  for (const [re, to] of SUFFIX) {
    if (re.test(tok)) {
      const stem = tok.replace(re, "");
      // "don't" -> "do not", "isn't" -> "is not"; the stem keeps its own spelling.
      return [stem, to.trim()];
    }
  }
  return [tok];
}

/** Number words to digits: "ten" -> "10", "twenty five" -> "25" (what Whisper writes). */
function digits(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const ten = TENS.indexOf(t);
    if (ten >= 2) {
      const unit = ONES.indexOf(toks[i + 1] ?? "");
      if (unit >= 1 && unit <= 9) { out.push(String(ten * 10 + unit)); i++; continue; }
      out.push(String(ten * 10));
      continue;
    }
    const one = ONES.indexOf(t);
    out.push(one >= 0 ? String(one) : t);
  }
  return out;
}

/** The canonical spoken form of a transcript: lower case, no punctuation or disfluencies, contractions expanded, digits. */
export function spokenWords(s: string): string {
  const t = s.toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/(\p{L})-(\p{L})/gu, "$1$2")
    .replace(/\ball right\b/g, "alright")
    .replace(/\bo\.k\.?(?=\s|$)|\bok\b/g, "okay");
  const toks = t.replace(/[^\p{L}\p{N}']+/gu, " ").trim().split(/\s+/).map((x) => x.replace(/^'+|'+$/g, "")).filter(Boolean);
  const words = toks.flatMap(expand).filter((w) => w && !DISFLUENCY.has(w));
  return digits(words).join(" ");
}

/** Two transcripts say the same thing (both non-empty). */
export function sameWords(a: string, b: string): boolean {
  const x = spokenWords(a);
  return x !== "" && x === spokenWords(b);
}
