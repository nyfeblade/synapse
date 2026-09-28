import { createHash } from "node:crypto";
import { LIMITS, type B2BKind } from "@synapse/shared";
import type { ThreadLine } from "./threads";

/** The courtesy lexicon (G3), matched per sentence after stripping punctuation and emoji. */
export const COURTESY_LEXICON: readonly string[] = [
  "thanks", "thank you so much", "thank you", "thx", "ty", "much appreciated", "appreciate it", "got it", "noted", "received",
  "acknowledged", "confirmed", "understood", "will do", "on it", "sounds good", "sounds great", "perfect", "great", "awesome",
  "nice", "cool", "ok", "okay", "sure", "no problem", "np", "you're welcome", "happy to help", "glad to help", "my pleasure",
  "standing by", "ready when you are", "let me know if you need anything else", "let me know if you need anything",
  "let me know if you have questions", "keep me posted", "looking forward", "cheers", "great work", "nice work", "well done",
];
const LEX_BY_LENGTH = [...COURTESY_LEXICON].sort((a, b) => b.length - a.length);
/** Words that carry no content once courtesy phrases are removed ("thank you so much, this is it"). */
const FILLER = new Set(["so", "very", "really", "again", "too", "all", "and", "for", "the", "a", "an", "it", "this", "that", "is", "i", "i'll", "i've", "i'm", "we", "we'll", "you", "your", "just", "much", "a lot", "lot", "lots", "of", "oh", "ah", "then", "anyway", "everyone", "team", "folks", "guys", "mate", "man", "both", "as", "always", "now", "will", "keep", "in", "mind", "to", "on"]);
const STOP = new Set([
  "that", "this", "with", "have", "from", "your", "what", "will", "just", "been", "were", "they", "them", "then", "than", "there", "here",
  "into", "also", "very", "much", "such", "some", "more", "most", "only", "over", "when", "which", "while", "about", "would", "could",
  "should", "their", "these", "those", "does", "thanks", "thank", "great", "perfect", "awesome", "nice", "cool", "okay", "sure", "cheers",
  "welcome", "happy", "glad", "pleasure", "noted", "received", "acknowledged", "confirmed", "understood", "sounds", "good", "standing",
  "ready", "know", "need", "needed", "anything", "else", "questions", "keep", "posted", "looking", "forward", "work", "well", "appreciate",
  "appreciated", "exactly", "really", "again", "please", "let", "i'll", "you're", "it's", "that's", "we'll",
]);
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu;
const GREETING = /^(?:hi|hey|hello|dear|yo)(?:\s+[\p{L}-]+)?\s*[,!.:—-]?\s*/iu;
const SIGNOFF = /^(?:best|regards|best regards|kind regards|thanks again|talk soon)\b[\s,\p{L}]*$/iu;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const PATH_RE = /(?:^|[\s(["'])(\/(?:workspace|home|tmp|srv|opt|var|data)\/[^\s"'<>)\],;]*)/g;
const NUM_RE = /\$?\d[\d,.:%]*/g;
const IMPERATIVE = new Set([
  "please", "send", "make", "create", "check", "review", "find", "write", "update", "fix", "draft", "book", "schedule", "compute", "calculate",
  "prepare", "share", "tell", "give", "list", "research", "compare", "summarize", "look", "get", "run", "build", "dedupe", "add", "remove",
  "move", "pay", "file", "decide", "choose", "pick", "approve", "confirm", "cancel", "pause", "resume", "email", "call", "reply", "answer",
  "export", "import", "merge", "deploy", "test", "verify", "collect", "gather", "take", "handle", "own", "finish", "complete", "submit",
]);
const ASK_PHRASE = /\b(?:please|can you|could you|would you|will you|need you to|i need|we need|until you|waiting (?:on|for) you|let me know (?:which|whether|if (?!you need anything|you have questions)))\b/i;

const trimPunct = (s: string) => s.replace(/[.,;:!?)\]]+$/, "");

export function normalizeText(s: string): string {
  return s.replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function extractArtifacts(s: string): string[] {
  const urls = (s.match(URL_RE) ?? []).map(trimPunct);
  const paths = [...s.matchAll(PATH_RE)].map((m) => trimPunct(m[1] as string));
  return [...new Set([...paths, ...urls])];
}

/** G7: words of ≥ 4 letters (minus stopwords), numbers, paths and URLs. Deduped, lowercased (paths and URLs kept as written). */
export function informativeTokens(s: string): string[] {
  const artifacts = extractArtifacts(s);
  let rest = s;
  for (const a of artifacts) rest = rest.split(a).join(" ");
  const nums = (rest.match(NUM_RE) ?? []).map((n) => trimPunct(n)).filter((n) => /\d/.test(n));
  const words = normalizeText(rest.replace(NUM_RE, " ")).match(/[\p{L}][\p{L}'-]{3,}/gu) ?? [];
  return [...new Set([...artifacts, ...nums, ...words.filter((w) => !STOP.has(w))])];
}

export function tokenSet4(s: string): Set<string> {
  return new Set(normalizeText(s).match(/[\p{L}]{4,}/gu) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function novelty(tokens: string[], known: Set<string>): number {
  if (!tokens.length) return 0;
  return tokens.filter((t) => !known.has(t)).length / tokens.length;
}

function sentences(s: string): string[] {
  // Split after . ! ? only when whitespace follows, so "/workspace/a.csv" stays one sentence.
  return s.replace(EMOJI, " ").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

function words(s: string): string[] {
  return normalizeText(s).replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
}

function isCourtesySentence(sentence: string): { courtesy: boolean; hit: boolean } {
  const ws = words(sentence);
  if (!ws.length) return { courtesy: true, hit: false };
  let flat = ` ${ws.join(" ")} `;
  let hit = false;
  for (const p of LEX_BY_LENGTH) {
    while (flat.includes(` ${p} `)) { hit = true; flat = flat.replace(` ${p} `, " "); }
  }
  const rest = flat.split(" ").filter((w) => w && !FILLER.has(w));
  const question = sentence.includes("?");
  const data = /\d|\/|https?:|www\./.test(sentence);
  if (hit && !rest.length && !question) return { courtesy: true, hit };
  if (hit && ws.length <= LIMITS.gateCourtesyShortWords && !question && !data) return { courtesy: true, hit };
  return { courtesy: false, hit };
}

/** The message with greetings, sign-offs, emoji and courtesy sentences removed. */
export function courtesyRemainder(s: string): string {
  return analyzeCourtesy(s).remainder;
}

function analyzeCourtesy(s: string): { remainder: string; hadCourtesy: boolean } {
  const keep: string[] = [];
  let hadCourtesy = false;
  sentences(s).forEach((raw, i) => {
    let t = raw;
    if (i === 0 && GREETING.test(t)) { t = t.replace(GREETING, "").trim(); hadCourtesy = true; }
    if (!t || SIGNOFF.test(t)) { hadCourtesy = true; return; }
    const c = isCourtesySentence(t);
    if (c.hit) hadCourtesy = true;
    if (!c.courtesy) keep.push(t);
  });
  return { remainder: keep.join(" ").trim(), hadCourtesy };
}

/**
 * G3: every sentence is courtesy, or the message contained courtesy and what is left is < 12 chars with no number,
 * path, URL or question. (A bare short answer such as "no: 14:00" has no courtesy and is not G3.)
 */
export function isCourtesyOnly(s: string): boolean {
  if (!s.replace(EMOJI, "").replace(/[\s\p{P}\p{S}]/gu, "")) return true; // emoji-only or punctuation-only
  const { remainder, hadCourtesy } = analyzeCourtesy(s);
  if (!remainder) return true;
  return hadCourtesy && remainder.replace(/[\s\p{P}]/gu, "").length < LIMITS.gateCourtesyRemainder && !/\d|\/|https?:|\?/.test(remainder);
}

/** G8: an ask is a question mark, an imperative verb opening a sentence, or an explicit ask phrase. */
export function hasAsk(s: string): boolean {
  if (s.includes("?")) return true;
  if (ASK_PHRASE.test(s)) return true;
  return sentences(s).some((x) => {
    const w = words(x.replace(/^(?:[\p{L}]+:\s*)/u, ""));
    return w.length > 0 && IMPERATIVE.has(w[0] as string);
  });
}

/** Builds the thread line recorded for a delivered message (Task 30) and for tests. */
export function threadLineOf(p: { at: number; from: string; to: string; kind: B2BKind; message: string; rid?: string; artifacts?: string[] }): ThreadLine {
  return {
    at: p.at, from: p.from, to: p.to, kind: p.kind, text: p.message, sha1: sha1(normalizeText(p.message)),
    tokens: [...new Set([...tokenSet4(p.message), ...informativeTokens(p.message)])],
    artifacts: [...new Set([...(p.artifacts ?? []), ...extractArtifacts(p.message)])],
    ...(p.rid ? { rid: p.rid } : {}),
  };
}
