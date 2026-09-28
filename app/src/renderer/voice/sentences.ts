/**
 * Voice calls speak a reply while it is still streaming: each sentence goes to the speech queue the
 * moment it is complete, so the first audio starts after the first sentence instead of after the
 * whole reply. `push` takes the streamed text so far (it only grows); `finish` takes the final
 * message and returns only what hasn't been spoken yet, so nothing is said twice when the final
 * message replaces the stream.
 */
const ABBREV = new Set(["e.g", "i.e", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "approx", "no", "fig", "u.s", "inc", "ltd", "co",
  // Bug 166: "…at 4 p.m. about the release" was split after "p.m." and the rest of the thought then
  // started cold, which is exactly the break the user could hear.
  "p.m", "a.m", "est", "pst", "ph.d", "e.t.a"]);
/** A reply's OPENING sentence, with no end in sight, is cut at a comma past this many characters so speech
 * can start. Only the opening: once the reply is talking, every chunk is a whole sentence. */
const LONG = 180;
const MIN_COMMA = 60;

/**
 * Prosody: the pause the voice leaves after a line is the punctuation that line ends with, not one flat
 * number for everything (a call where every line landed the same way read like a list, not like talking).
 * The helper validates pauseMs as an integer 0–1000.
 */
export const VOICE_PAUSE_MS = {
  /** A breath inside a thought: a comma, semicolon, colon or dash (the opening clause ends on one). */
  comma: 90,
  /** A full stop: the voice falls and settles. */
  period: 220,
  /** "!" — a beat, a shade shorter than a question. */
  exclaim: 240,
  /** "?" — bug 224: paced like a full stop (no question handling on any voice, the user's decision). */
  question: 220,
  /** A paragraph break: a real gap, the way a person changes subject. */
  paragraph: 380,
} as const;

export type PauseTable = { readonly [K in keyof typeof VOICE_PAUSE_MS]: number };

/**
 * Bug 166: the SAME table is wrong for Qwen3, because Qwen is not Kokoro. Kokoro renders one line at a
 * time and stops dead at the full stop, so the beat between sentences has to be ours. Qwen renders the
 * pause itself — measured on this Mac, it leaves 250-330 ms between the sentences of one render — and
 * the chain then keeps that pause on the end of the chunk (PROSODY_QWEN's `tailMs`). Adding the Kokoro
 * beat on top of it was most of what "pauses or breaks between sentences" was: two pauses, back to back.
 *
 * So these are TOP-UPS, not pauses: what is left to add once the model's own tail has played. A comma
 * chunk keeps less tail than it needs and gets a little back; a sentence end needs nothing at all. The
 * paragraph break is the one place a real gap is still wanted, so it keeps a beat of its own.
 */
const QWEN_PERIOD_MS = 0;
export const QWEN_PAUSE_MS: PauseTable = {
  comma: 40,
  period: QWEN_PERIOD_MS,
  exclaim: 0,
  // Bug 190: a Qwen Bot's "?" is a "." as far as we are concerned — the model renders the question.
  question: QWEN_PERIOD_MS,
  paragraph: 180,
} as const;

/**
 * Bug 190: the Kokoro stand-in a Qwen Bot speaks through (a whole reply when Qwen is unavailable, or the whole call once
 * a short Mac drops it to Light mode). Kokoro's own beats, except that a question is paced like a
 * full stop: the user asked for no question handling at all on a Qwen Bot.
 */
export const PLAIN_PAUSE_MS: PauseTable = { ...VOICE_PAUSE_MS, question: VOICE_PAUSE_MS.period };

/** A paragraph-ending chunk carries a trailing newline; `pauseMsFor` turns it into the paragraph pause. */
const PARA_MARK = "\n";
/** Punctuation a chunk may end on, with closing quotes / brackets after it. */
const ENDS_PUNCT = /[.,!?;:–—]["')\]’”]*$/u;
const TRAILING = /[\s"')\]’”]+$/u;

/** The pause (ms) to leave after speaking `chunk`, from the punctuation it ends with. */
export function pauseMsFor(chunk: string, table: PauseTable = VOICE_PAUSE_MS): number {
  if (chunk.endsWith(PARA_MARK)) return table.paragraph;
  const end = chunk.replace(TRAILING, "").slice(-1);
  const ms = end === "?" ? table.question
    : end === "!" ? table.exclaim
      : end === "." ? table.period
        : /[,;:–—]/.test(end) ? table.comma
          : table.period; // nothing to go on: a sentence beat, never a run-on
  return Math.min(1_000, Math.max(0, Math.round(ms)));
}

/** Code blocks are never read aloud; an unclosed one hides everything after it until it closes. */
function prepare(raw: string): string {
  const s = raw.replace(/```[\s\S]*?```/g, "\n");
  const open = s.indexOf("```");
  return open >= 0 ? s.slice(0, open) : s;
}

/** Markdown → words to say. A list item becomes its own short sentence. */
export function speechText(seg: string): string {
  let t = seg.trim();
  const item = /^([-+*]|\d+[.)])\s+/.test(t);
  t = t.replace(/^([-+*]|\d+[.)])\s+/, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (item && t && !/[.!?:;,]$/.test(t)) t += ".";
  return t;
}

/**
 * Index just past the end of the first complete sentence in s (from 0), or -1. `end`: s is final.
 * `opening`: nothing of this reply has been said yet, so a sentence with no end in sight may be cut at a
 * comma to get speech going. Past the opening the cut is never taken: every later chunk is a whole
 * sentence, so intonation is never broken mid-thought.
 */
function boundary(s: string, end: boolean, opening = false): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\n") { if (s.slice(0, i).trim()) return i; continue; }
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let j = i + 1;
    while (j < s.length && /["')\]*_]/.test(s[j]!)) j++; // closing quotes / emphasis stay with the sentence
    if (j < s.length ? !/\s/.test(s[j]!) : !end) continue; // "3.50", or the stream may still continue
    // Bug 166: an ELLIPSIS is a hesitation inside a thought as often as it is the end of one.
    // "Well... maybe we should wait." was two chunks, and the second one started cold. A run of dots
    // only ends the sentence when what follows opens like a new one.
    if (ch === "." && (s[i - 1] === "." || s[i + 1] === ".")) {
      const k = s.slice(j).search(/\S/);
      if (k < 0 && !end) continue;
      if (k >= 0 && !/[\p{Lu}\p{N}"'“(]/u.test(s[j + k]!)) continue;
    }
    if (ch === ".") {
      const word = (s.slice(0, i).match(/(\S+)$/)?.[1] ?? "").replace(/^[("'[]+/, "");
      if (ABBREV.has(word.toLowerCase()) || /^[A-Z]$/.test(word)) continue;
      // Bug 191: "1." opening a line is a list marker, not a sentence: cut there, the voice said "One." on
      // its own and the item started cold. The marker goes with its item (and speechText drops it).
      // Only at a real line start (or the reply's very start): "How many? 3. Yes." stays two sentences.
      if (/^\d{1,2}$/.test(word) && (/\n[ \t]*\d{1,2}$/.test(s.slice(0, i)) || (opening && /^\s*\d{1,2}$/.test(s.slice(0, i))))) continue;
    }
    return j;
  }
  if (opening && s.trim().length > LONG) {
    const cut = s.lastIndexOf(", ");
    if (cut >= MIN_COMMA) return cut + 1;
  }
  return end && s.trim() ? s.length : -1;
}

/**
 * Bug 142's clause start, narrowed: chunking is sentence-level by default, because a fragment read on its
 * own lands flat and the rest of its sentence then starts cold — the whole sentence loses its shape. A
 * reply's opening is cut early only when the sentence has PROVED long (CLAUSE_LONG words have streamed in
 * and it still hasn't ended), only at a comma-like mark it already has, never before CLAUSE_MIN words, and
 * never in a question (its rise has to carry from the first word). The rest of that sentence then goes as
 * one intact chunk. Returns [end index, the line to say] or null.
 */
const CLAUSE_MIN = 8;
const CLAUSE_LONG = 18;
/** An opener that means the sentence is a question, long before its "?" arrives. */
const ASKS = /^(?:who|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|am)\b/i;
function clause(s: string): [number, string] | null {
  if (ASKS.test(s.trimStart())) return null;
  const re = /\S+/g;
  let n = 0;
  let cut: [number, string] | null = null;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const end = m.index + m[0].length;
    if (end >= s.length || !/\s/.test(s[end]!)) return null; // this word may still be growing
    const w = m[0];
    if (/[.!?]["')\]]*$/.test(w)) return null; // the sentence ended by itself: it goes whole
    n += 1;
    if (!cut && n >= CLAUSE_MIN && /[,;:—–]$/.test(w)) cut = [end, s.slice(0, end)];
    if (n > CLAUSE_LONG) return cut; // long enough that waiting for the full stop would cost real time
  }
  return null;
}

/**
 * Bug 166: how many sentences go to the model in ONE piece.
 *
 * Sentence-at-a-time is right for Kokoro — it reaches first audio in 0.16 s and the beat between
 * sentences is ours to place. It is wrong for Qwen3, which renders its own sentence-final pause, its
 * own falling and rising lines, and its own breath: cut into one sentence per render, it starts each
 * one cold and every join is a new take. Given two or three sentences it phrases ACROSS them, which is
 * what "flows like one person talking" means here.
 *
 * The opening chunk is never grouped — it is the one the user waits for, and grouping it would mean
 * waiting for two more sentences to stream out of the model before a word is spoken. Everything after
 * it is rendered ahead of what is playing, so grouping it costs nothing at all.
 *
 *   minChars     emit as soon as the group is at least this long: a group is never held for a third
 *                sentence it doesn't need, so the text is never the thing playback is waiting on.
 *   maxChars     a hard cap. A part that would take the group past it starts the next group instead.
 *   maxSentences the most sentences one render may carry.
 */
export interface ChunkGroup { minChars: number; maxChars: number; maxSentences: number }
/** Measured on this Mac: 2-3 sentences is where Qwen's phrasing spans the join and the cap still
 * holds a render to about 6 s, so nothing waits on a long one. */
export const QWEN_CHUNK: ChunkGroup = { minChars: 140, maxChars: 300, maxSentences: 3 };

export interface ChunkerOptions {
  /** `firstClause`: the reply's first line may be its first clause (bug 142). */
  firstClause?: boolean;
  /** Group whole sentences into one spoken chunk after the opening one (bug 166). */
  group?: ChunkGroup;
}

export class SentenceChunker {
  private cursor = 0;
  private consumed = "";
  private said: string[] = [];
  private done = false;
  /** Sentences complete but held back, waiting for the rest of their group (bug 166). */
  private held: { text: string; at: number }[] = [];
  private readonly o: ChunkerOptions;

  constructor(o: ChunkerOptions = {}) { this.o = o; }

  /** The streamed reply so far → the sentences newly complete. */
  push(streamed: string): string[] {
    if (this.done) return [];
    const s = prepare(streamed);
    if (!s.startsWith(this.consumed)) return []; // the stream was rewritten; finish() sorts it out
    return this.take(s, false);
  }

  /** The final message → whatever of it hasn't been spoken. Idempotent. */
  finish(final: string): string[] {
    if (this.done) return [];
    this.done = true;
    const s = prepare(final);
    if (s.startsWith(this.consumed)) return this.take(s, true);
    // The final text isn't the stream plus more: say its sentences that weren't said already.
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const already = new Set(this.said.map(norm));
    // The same options, so the fresh run cuts the text the same way and the two sets can be compared.
    const fresh = new SentenceChunker(this.o);
    const out = fresh.take(s, true).filter((x) => !already.has(norm(x)));
    this.said.push(...out);
    return out;
  }

  /**
   * The stream has stopped short of a sentence end: say what it has so far (a watchdog's call).
   * Unlike finish(), the reply stays open: later text continues after what was flushed.
   */
  flush(streamed: string): string[] {
    if (this.done) return [];
    const s = prepare(streamed);
    if (!s.startsWith(this.consumed)) return [];
    return this.take(s, true);
  }

  /** Text of `streamed` not yet handed to speech (the chunker is waiting for its sentence to end). */
  hasPending(streamed: string): boolean {
    if (this.done) return false;
    const s = prepare(streamed);
    if (!s.startsWith(this.consumed)) return false;
    // A sentence held back for its group counts as pending: the stall watchdog's flush releases it.
    return this.held.length > 0 || speechText(s.slice(this.cursor)) !== "";
  }

  /** Everything handed to speech so far, in order (to cut an interrupted reply at what was said). */
  spoken(): string[] { return this.said.map((x) => x.trim()); }

  private take(s: string, end: boolean): string[] {
    for (;;) {
      const rest = s.slice(this.cursor);
      const opening = this.cursor === 0 && !this.said.length && !this.held.length;
      let b = boundary(rest, end, opening);
      let line: string | null = null;
      if (this.o.firstClause && opening) {
        const c = clause(rest);
        if (c && (b < 0 || c[0] < b)) { b = c[0]; line = c[1]; }
      }
      if (b < 0) break;
      let text = speechText(line ?? rest.slice(0, b));
      // A chunk never ends bare: a line that stops at a newline or at the end of the message is a
      // finished thought, and the voice has to hear its full stop to fall instead of trailing off.
      if (text && !ENDS_PUNCT.test(text)) text += ".";
      // A blank line after it is a change of subject, not another sentence: it gets the long pause.
      if (text && /^[^\S\n]*\n[^\S\n]*\n/.test(rest.slice(b))) text += PARA_MARK;
      this.cursor += b;
      // Punctuation alone (the "." left after a flushed stream) is not a line.
      if (text && /[\p{L}\p{N}]/u.test(text)) this.held.push({ text, at: this.cursor });
      if (this.cursor >= s.length) break;
    }
    this.consumed = s.slice(0, this.cursor);
    return this.drain(end);
  }

  /**
   * Bug 166: complete sentences → the chunks actually spoken. Without `group` that is one to one, as
   * it has always been. With it, the opening chunk still goes alone (nothing may delay first audio)
   * and the rest are joined until the group is long enough, ends a paragraph, or is full — and a group
   * that is none of those waits for more text unless the reply has ended (`end`, which is finish() or
   * the stall watchdog's flush, so a held sentence is never stranded).
   */
  private drain(end: boolean): string[] {
    const g = this.o.group;
    const out: string[] = [];
    for (;;) {
      if (!this.held.length) break;
      if (!g || !this.said.length) {
        const one = this.held.shift()!;
        out.push(one.text);
        this.said.push(one.text);
        continue;
      }
      const group: { text: string; at: number }[] = [];
      let len = 0;
      let closed = false;
      while (this.held.length && group.length < g.maxSentences) {
        const next = this.held[0]!;
        const add = next.text.length + (group.length ? 1 : 0);
        if (group.length && len + add > g.maxChars) { closed = true; break; }
        group.push(this.held.shift()!);
        len += add;
        if (next.text.endsWith(PARA_MARK) || len >= g.minChars || group.length >= g.maxSentences) { closed = true; break; }
      }
      if (!closed && !end) { this.held.unshift(...group); break; }
      if (!group.length) break;
      const line = group.map((x) => x.text).join(" ");
      out.push(line);
      this.said.push(line);
    }
    return out;
  }
}
