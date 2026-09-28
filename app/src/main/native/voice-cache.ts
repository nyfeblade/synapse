import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { greetingClaimReason } from "@synapse/shared";
import { registerNative } from "../native";
import { kokoroVoiceId, prosodyFrom, qwenProsody, withProsody, type NaturalTts, type Prosody } from "./kokoro";
import { QWEN_PREFIX, qwenVoiceId, targetRmsFor, type QwenTts } from "./qwen";

/**
 * Bug 134: the call's own lines — each Bot's pick-up greetings, the fillers, "sorry, go ahead", "that'll
 * take a minute", the goodbyes — rendered ONCE in the Bot's Kokoro voice and kept on this Mac as raw PCM
 * (24 kHz mono float32 LE). A cached line plays at once, even before the Kokoro sidecar has loaded, so
 * a pick-up is instant in the Bot's own voice. Nothing here leaves the Mac, and no line costs a token.
 */

const HEADER = "SYNPCM1\n";
/** Bugs 180/181/190: bumped whenever the processing a cached line went through changes (see `key`). */
const RENDER = "\nr4"; // bug 224: a Kokoro Bot's cached questions were ramped
const MAX_TEXT = 200;
/** ~4 MB a Bot (about 30 lines); 64 MB holds the whole team, least recently played first out. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Bug 141: at most this many remembered call lines (about 15 Bots' greetings and stock lines). */
const BOOK_MAX = 600;

export class PhraseCache {
  private maxBytes: number;
  /** Strictly increasing use times (two writes in the same millisecond still order correctly). */
  private clock = 0;
  private maxText: number;

  constructor(private o: { dir: string; maxBytes?: number; maxText?: number }) {
    this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxText = o.maxText ?? MAX_TEXT;
  }

  /** voice = a Kokoro id ("bm_george"); speed = the Bot's speech rate (0.5–2). */
  key(voice: string, speed: number, text: string, level?: number): string {
    // Bugs 180/181: RENDER names how a line was processed. Lines cached before them were cut mid-decay
    // (and, for Qwen, ramped), so they get new keys and are rendered again; the old files age out
    // under the size cap like any unplayed line. Bug 190 (r3): a Qwen Bot's lines lost their last
    // question handling, so anything cached for one is rendered again. A Qwen line's delivery instruction is not in the key
    // because there is only ever one (the sidecar's DEFAULT_INSTRUCT; QwenJob has no field for another,
    // test/main/qwen.test.ts checks none is sent) — a per-Bot instruct would have to be added here.
    // Bug 221: a Qwen line is held to its Bot's level (its Kokoro voice's): a take at another level is another take.
    const lvl = level === undefined ? "" : `\nL${level.toFixed(4)}`;
    return createHash("sha256").update(`${voice}\n${speed.toFixed(2)}\n${text.trim()}${RENDER}${lvl}`).digest("hex").slice(0, 40);
  }

  private file(voice: string, speed: number, text: string, level?: number): string {
    return path.join(this.o.dir, `${this.key(voice, speed, text, level)}.f32`);
  }

  get(voice: string, speed: number, text: string, level?: number): Buffer | null {
    const f = this.file(voice, speed, text, level);
    try {
      const b = fs.readFileSync(f);
      if (b.length <= HEADER.length || b.subarray(0, HEADER.length).toString("latin1") !== HEADER) return null;
      this.touch(f);
      return b.subarray(HEADER.length);
    } catch {
      return null;
    }
  }

  has(voice: string, speed: number, text: string, level?: number): boolean {
    return fs.existsSync(this.file(voice, speed, text, level));
  }

  /** Drops one rendered line (bug 151: a cached greeting that isn't a greeting). True when a file went. */
  remove(voice: string, speed: number, text: string, level?: number): boolean {
    try { fs.unlinkSync(this.file(voice, speed, text, level)); return true; } catch { return false; }
  }

  put(voice: string, speed: number, text: string, pcm: Buffer, level?: number): void {
    if (!pcm.length || pcm.length % 4 !== 0 || text.length > this.maxText) return;
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const f = this.file(voice, speed, text, level);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([Buffer.from(HEADER, "latin1"), pcm]), { mode: 0o600 });
      fs.renameSync(tmp, f);
      this.touch(f);
      this.prune();
    } catch { /* a full disk only costs the cache */ }
  }

  private touch(f: string): void {
    this.clock = Math.max(Date.now(), this.clock + 1);
    const t = new Date(this.clock);
    try { fs.utimesSync(f, t, t); } catch { /* read-only is fine */ }
  }

  /** Least recently played out first, until the folder fits its cap. */
  prune(): void {
    let entries: { f: string; size: number; at: number }[];
    try {
      entries = fs.readdirSync(this.o.dir).filter((n) => n.endsWith(".f32")).map((n) => {
        const f = path.join(this.o.dir, n);
        const st = fs.statSync(f);
        return { f, size: st.size, at: st.mtimeMs };
      });
    } catch { return; }
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      try { fs.unlinkSync(e.f); total -= e.size; } catch { /* gone */ }
    }
  }
}

/** Files in `dir` older than `maxAgeMs` are deleted (voicemail audio: 30 days). Returns how many. */
export function pruneOld(dir: string, maxAgeMs: number, now = Date.now()): number {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) { fs.unlinkSync(f); n += 1; } } catch { /* gone */ }
    }
  } catch { /* no folder yet */ }
  return n;
}

/** `fallback`: a Qwen Bot's own Kokoro voice ("kokoro:<id>") — its lines are held to that voice's level (bug 221). */
export interface PhraseItem { voice: string; speed: number; text: string; kind?: "greeting"; fallback?: string }

/**
 * Bug 151: a remembered line that a call would open with, but that isn't a greeting ("Hi, I've drafted
 * three replies for you."), is dropped along with its rendered audio, so the user never hears it again.
 * Lines written before `kind` existed are checked too — every stock call line passes the same test, so
 * the worst an unmarked one risks is being rendered again.
 */
export function staleGreeting(it: PhraseItem): boolean {
  return (it.kind === undefined || it.kind === "greeting") && greetingClaimReason(it.text) !== null;
}
type Tts = Pick<NaturalTts, "isReady" | "isWarm" | "synth"> & { busy?(): boolean; cancel?(id?: string): void };
type PrerenderJob = { voice: string; speed: number; text: string; engine: "kokoro" | "qwen"; level?: number; fallback?: string };

/**
 * Renders missing phrases in the background, one at a time, only while Kokoro is warm and not saying a
 * live line (so a reply never waits behind a greeting being rendered for next time).
 */
export class PhrasePrerender {
  /**
   * Bug 164: `engine` is which engine renders this line. A Bot set to a Qwen voice gets its
   * greetings and fillers in THAT voice — at "full" quality, because nothing is waiting on a line
   * rendered now to be played days later, and the whole-utterance render is the better take.
   */
  private queue: PrerenderJob[] = [];
  private inflight = false;
  /** Bug 221: the render in flight (halt() cancels it, and its late audio is ignored). */
  private current: { id: string; job: PrerenderJob } | null = null;
  private seq = 0;

  /** Bug 141: every line a call has asked for (voice, speed, text), kept on this Mac in `book`. */
  private known = new Map<string, PhraseItem>();
  /** Bug 151: the texts thrown away as stale greetings (logged and deleted once each). */
  private dropped = new Set<string>();

  /** Bug 156: the same question ramp and silence trim a spoken line gets (tests pass PROSODY_OFF). */
  private get prosody(): Prosody { return this.o.prosody ?? prosodyFrom(); }

  constructor(private o: {
    cache: PhraseCache; tts: Tts; log: (line: string) => void; prosody?: Prosody;
    /** Bug 164: the Qwen engine, for Bots set to a Qwen voice. Absent = those lines aren't rendered. */
    qwen?: QwenTts;
    /** Bug 141: a call or dictation has the microphone: no pre-rendering (no CPU burst beside it). */
    live?: () => boolean;
    /** Bug 141: where the asked-for lines are remembered, so the next launch renders them before any call. */
    book?: string;
  }) {}

  pending(): number { return this.queue.length + (this.inflight ? 1 : 0); }

  prepare(items: PhraseItem[]): void {
    let added = false;
    for (const it of items.slice(0, 200)) {
      // Bug 164: a Qwen voice id can never be read as a Kokoro one (Kokoro's are "xx_name"), so the
      // cache key stays unambiguous with no extra namespacing.
      const qwen = qwenVoiceId(it.voice);
      const voice = qwen ?? kokoroVoiceId(it.voice);
      const engine: "kokoro" | "qwen" = qwen ? "qwen" : "kokoro";
      const text = typeof it.text === "string" ? it.text.trim() : "";
      if (!voice || !text || text.length > MAX_TEXT) continue;
      if (engine === "qwen" && !this.o.qwen) continue; // no Qwen engine wired: nothing to render with
      const speed = Number.isFinite(it.speed) ? Math.min(2, Math.max(0.5, it.speed)) : 1;
      // Bug 221: a Qwen line renders at its Bot's level, the one every live line of that Bot is held to.
      const level = engine === "qwen" ? targetRmsFor(typeof it.fallback === "string" ? it.fallback : null) : undefined;
      const fallback = engine === "qwen" && typeof it.fallback === "string" ? it.fallback : undefined;
      // Bug 151: a line a call would open with that isn't a greeting is never rendered or remembered.
      if (staleGreeting({ ...it, text })) { this.dropStale({ voice, speed, text, kind: it.kind, level }); continue; }
      const k = this.o.cache.key(voice, speed, text, level);
      if (!this.known.has(k)) { this.known.set(k, { voice: engine === "qwen" ? `${QWEN_PREFIX}${voice}` : `kokoro:${voice}`, speed, text, ...(it.kind ? { kind: it.kind } : {}), ...(fallback ? { fallback } : {}) }); added = true; }
      if (this.o.cache.has(voice, speed, text, level) || this.queue.some((q) => q.voice === voice && q.speed === speed && q.text === text && q.level === level)) continue;
      this.queue.push({ voice, speed, text, engine, ...(level !== undefined ? { level } : {}), ...(fallback ? { fallback } : {}) });
    }
    if (added) this.saveBook();
  }

  /** The line is forgotten and whatever was rendered of it is deleted (it can never play again). */
  private dropStale(it: { voice: string; speed: number; text: string; kind?: "greeting"; level?: number }): void {
    if (this.dropped.has(it.text)) return;
    this.dropped.add(it.text);
    const gone = this.o.cache.remove(it.voice, it.speed, it.text, it.level);
    this.o.log(`voice-cache: dropped a cached line that isn't a greeting (${JSON.stringify(it.text.slice(0, 60))})${gone ? ", audio deleted" : ""}`);
  }

  /**
   * Loads the remembered lines and queues the ones missing from the cache. Returns how many were queued.
   * Bug 151: a remembered greeting that no longer passes the greeting rules is dropped here, with its
   * audio, and the book is rewritten without it — the point where the user stops hearing the bad ones.
   */
  restore(): number {
    if (!this.o.book) return 0;
    let items: PhraseItem[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.o.book, "utf8")) as unknown;
      if (Array.isArray(raw)) items = raw.filter((x): x is PhraseItem => !!x && typeof x === "object" && typeof (x as PhraseItem).text === "string" && typeof (x as PhraseItem).voice === "string");
    } catch { return 0; }
    const before = this.queue.length;
    const stale = items.filter(staleGreeting).length;
    for (let i = Math.max(0, items.length - BOOK_MAX); i < items.length; i += 200) this.prepare(items.slice(i, i + 200));
    if (stale) this.saveBook(); // the book is written again without them, even if nothing new was queued
    return this.queue.length - before;
  }

  /** How many remembered lines were thrown away as stale greetings (bug 151). */
  droppedCount(): number { return this.dropped.size; }

  private saveBook(): void {
    if (!this.o.book) return;
    // The newest lines win; a Bot re-authoring its greetings pushes its old ones out over time.
    while (this.known.size > BOOK_MAX) this.known.delete(this.known.keys().next().value!);
    try {
      fs.mkdirSync(path.dirname(this.o.book), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.book}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.known.values()]), { mode: 0o600 });
      fs.renameSync(tmp, this.o.book);
    } catch { /* only costs a warm cache next launch */ }
  }

  /**
   * Bug 221: a call (or dictation) just took the microphone: the render in flight is cancelled and goes back to the
   * front of the queue — a full-quality Qwen take is seconds of GPU, and it would sit beside the greeting.
   */
  halt(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.inflight = false;
    const t: Tts | undefined = cur.job.engine === "qwen" ? this.o.qwen : this.o.tts;
    t?.cancel?.(cur.id);
    this.queue.unshift(cur.job);
  }

  /** Called on a timer and whenever speech finishes: starts the next render if it may. */
  pump(): void {
    if (this.inflight || !this.queue.length) return;
    if (this.o.live?.()) return;
    // Bug 164: whichever engine the NEXT line belongs to has to be the one that is ready. A queue
    // with Qwen lines in it must not stall behind Kokoro's readiness, or the other way round.
    const next = this.queue[0]!;
    const t: Tts | undefined = next.engine === "qwen" ? this.o.qwen : this.o.tts;
    if (!t || !t.isReady() || !t.isWarm() || t.busy?.()) return;
    const job = this.queue.shift()!;
    if (this.o.cache.has(job.voice, job.speed, job.text, job.level)) return this.pump();
    this.inflight = true;
    const parts: Buffer[] = [];
    const id = `pre-${++this.seq}`;
    const cur = { id, job };
    this.current = cur;
    // A halted render's late callbacks change nothing (halt() already let it go and queued it again).
    const mine = () => this.current === cur;
    const end = () => { if (mine()) { this.inflight = false; this.current = null; } };
    // Bug 156: a line rendered ahead is stored as it will be PLAYED — the question ramp and the
    // silence trim run here too, or a cached greeting ending in "?" would be the one line on a call
    // that still falls at the end.
    // "full" quality for a Qwen line: it renders the whole utterance before emitting, which is
    // slower and better, and nothing is waiting on a line being kept for next time.
    const start = job.engine === "qwen" && this.o.qwen
      ? (h: Parameters<Tts["synth"]>[1]) => this.o.qwen!.synthQwen({ id, text: job.text, voice: job.voice, speed: job.speed, quality: "full", targetRms: job.level ?? targetRmsFor(null) }, h)
      : (h: Parameters<Tts["synth"]>[1]) => t.synth({ id, text: job.text, voice: job.voice, speed: job.speed }, h);
    // Bug 181: and a QWEN line goes through Qwen's prosody, as it would live (dictation.ts). It was
    // handed Kokoro's: the question ramp bug 166 turned off for Qwen lifted the model's own rise by
    // another 1.3-3.7 st, and the tail was cut 30-37 dB under the peak — the glitch at the end of a
    // Qwen question, heard on every greeting and filler that asks one.
    start(withProsody(job.text, {
      audio: (pcm) => { if (mine()) parts.push(Buffer.from(pcm)); },
      done: () => { if (!mine()) return; end(); this.o.cache.put(job.voice, job.speed, job.text, Buffer.concat(parts), job.level); },
      error: (m) => { if (!mine()) return; end(); this.o.log(`voice-cache: couldn't pre-render a line (${m})`); },
    }, job.engine === "qwen" ? qwenProsody(this.prosody) : this.prosody));
  }
}

/** Bug 218: `x` (a PhraseItem: "kokoro:<id>" or "qwen3:<id>", speed, text) is in the cache, keyed as a call plays it. */
export function phraseCached(cache: Pick<PhraseCache, "has">, x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const it = x as Partial<PhraseItem>;
  const qwen = qwenVoiceId(it.voice);
  const voice = qwen ?? kokoroVoiceId(it.voice);
  const text = typeof it.text === "string" ? it.text.trim() : "";
  if (!voice || !text || text.length > MAX_TEXT) return false;
  const speed = typeof it.speed === "number" && Number.isFinite(it.speed) ? Math.min(2, Math.max(0.5, it.speed)) : 1;
  return cache.has(voice, speed, text, qwen ? targetRmsFor(typeof it.fallback === "string" ? it.fallback : null) : undefined);
}

/** voice.phrases.prepare {items}: the lines a call may say by itself, rendered ahead (bug 134). */
export function registerVoiceCache(o: { cache: PhraseCache; tts: Tts; qwen?: QwenTts; log: (line: string) => void; live?: () => boolean; book?: string }): { pre: PhrasePrerender; kick(): void } {
  const pre = new PhrasePrerender(o);
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    pre.pump();
    if (!pre.pending() && timer) { clearInterval(timer); timer = null; }
  };
  /** Starts the render timer if anything is waiting (after a call ends, at launch…). */
  const kick = () => { if (pre.pending() && !timer) { timer = setInterval(tick, 400); timer.unref?.(); } };
  registerNative("voice.phrases.prepare", (a: { items?: unknown }) => {
    const items = Array.isArray(a?.items) ? (a.items as unknown[]).filter((x): x is PhraseItem => !!x && typeof x === "object") : [];
    pre.prepare(items);
    kick();
    return { pending: pre.pending() };
  });
  // Bug 218: which of these lines are already rendered (the end-of-turn sound only plays one that can start at once).
  registerNative("voice.phrases.has", (a: { items?: unknown }) => {
    const items = Array.isArray(a?.items) ? (a.items as unknown[]).slice(0, 200) : [];
    return { has: items.map((x) => phraseCached(o.cache, x)) };
  });
  // Bug 141: the call lines of earlier sessions, rendered in the background (never during a call).
  const n = pre.restore();
  if (n) o.log(`voice-cache: ${n} remembered call line(s) to render before the next call`);
  if (pre.droppedCount()) o.log(`voice-cache: ${pre.droppedCount()} cached line(s) were not greetings and were purged (bug 151)`);
  kick();
  return { pre, kick };
}
