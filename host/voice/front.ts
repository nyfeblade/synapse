import { randomUUID } from "node:crypto";
import { DEFAULT_BOT_MODEL, STRV, sendEntryId, spokenWords, type ApprovalCardView, type ApprovalChoice, type ApprovalStatus, type BotSummary, type TranscriptEntry } from "@synapse/shared";
import type { ModelMessage, TurnResult, WakeSource } from "../brain/types";
import { fillTemplate, loadPrompt } from "../prompts/index";
import type { WakeSpec } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import { totalTokens, ZERO_FRONT_USAGE, type FrontFactory, type FrontSession, type FrontTurn, type FrontUsage } from "./front-session";

/**
 * Bug 142 — the voice fast path ("Option A", approved by the user). On a 1:1 call each utterance is answered by
 * the Bot's VOICE: a warm, lean session (front-session.ts) with a tiny prompt — persona, the user's name, the call
 * so far, the per-turn memory recall — and one capability, delegate(task). It answers at once, in its own words;
 * real work goes to the Bot's FULL session as a "voice-delegate" wake, whose report comes back to the voice as a
 * [result] turn and is spoken. Everything lands in the chat: the user's words, what the voice said, the full
 * session's own messages and cards (only the voice speaks them on the call: its entries carry a "vf_" request id).
 *
 * Also here: the speculative start (a front turn begun on the helper's likely end of turn, held back until the
 * final confirms it; at most one a user turn; a dropped one's tokens are counted and logged), and spoken
 * approvals that aren't a plain yes / no (the voice's delegate becomes a decline carrying the user's change, so
 * the full session redoes the action and the new card is read back for a final yes).
 */

export const FRONT_REQUEST_PREFIX = "vf_";
const MAX_TURNS_PER_SESSION = 40;
const SEED_CHARS = 1_200;
const RESEED_CHARS = 3_000;
const SYNC_LINES = 30;
const SYNC_CHARS = 4_000;
const LINE_CHARS = 600;
const PERSONA_CHARS = 600;
/**
 * Prosody: what the voice writes is read aloud by the TTS engine exactly as written, so the words have
 * to carry their own breathing. Two lines on the end of the existing prompt — no second model call, no
 * second prompt file, and a handful of tokens once a session rather than once a turn.
 */
export const SPEAKABLE = [
  "- Write it to be heard: short sentences, each ending in its own full stop or question mark, and a comma wherever you would take a breath.",
  "- Never more than three things in a row, and no parentheses or asides — say it as the next sentence instead.",
].join("\n");

/**
 * Plan item 27: the voice may say nothing at all after a plain thanks or okay (`[quiet]`, the user's decision 5). The
 * marker is never spoken or shown — not even the half of it that has streamed so far — and a turn that was only the
 * marker tells the call it is over (no filler, no "that'll take a minute").
 */
const QUIET = /[[(]\s*quiet\s*[\])]/i;
/** Review round 1: the markers as the voice may write them — "[quiet]", "(quiet)", "[ Quiet ]" — and an echoed "[working]". */
const MARKERS = /[[(]\s*quiet\s*[\])]|\[\s*working\s*\]/gi;
function withoutQuiet(sofar: string): string {
  const t = sofar.replace(MARKERS, "");
  // Not even the half of one that has streamed so far ("[qu", "( quie", "[work").
  const tail = /([[(])\s*([a-z]*)\s*$/i.exec(t);
  if (!tail) return t;
  const word = tail[2]!.toLowerCase();
  return "quiet".startsWith(word) || (tail[1] === "[" && "working".startsWith(word)) ? t.slice(0, tail.index) : t;
}
/** Plan item 27: a plain acknowledgement needs no memories pulled into the turn. */
const ACK_ONLY = /^(?:(?:ok(?:ay)?|thanks?|thank you(?: so much)?|cheers|cool|great|perfect|nice|got it|sounds good|all ?right|awesome|sure|yep|yeah|no worries|brilliant|lovely)[\s,.!]*)+$/i;
/**
 * Plan item 20: while tasks the voice handed over are still running, each user turn carries one short line saying so
 * (the bench saw the voice claim "already sent" with nothing back yet). Two tasks at most, each cut short.
 */
const WORKING_MAX = 2;
const WORKING_TASK_CHARS = 70;
function workingLine(open: string[]): string {
  const cut = (t: string) => { const s = oneLine(t); return s.length <= WORKING_TASK_CHARS ? s : `${s.slice(0, WORKING_TASK_CHARS).replace(/\s+\S*$/, "")}…`; };
  const more = open.length > WORKING_MAX ? ` (+${open.length - WORKING_MAX} more)` : "";
  return `[working] ${open.slice(0, WORKING_MAX).map(cut).join("; ")}${more}`;
}
/** Plan item 13: a spoken reply this long is logged (lengths only): the prompt asks for one short sentence or two. */
const LONG_REPLY_WORDS = 60;

export interface FrontBots {
  has(id: string): boolean;
  summary(id: string): BotSummary;
  appendEntry(id: string, e: TranscriptEntry): void;
  publishTyping(id: string, typing: boolean, partialText: string | null): void;
  tail(id: string, n: number): TranscriptEntry[];
  nextTurnNo(id: string): number;
}
export interface FrontRunner {
  recordVoiceUtterance(botId: string, text: string, clientNonce: string, o: { durationMs?: number }): { entryId: string };
  enqueueWake(botId: string, spec: WakeSpec): string;
}
export interface FrontGate {
  pending(botId: string): ApprovalCardView[];
  resolve(botId: string, approvalId: string, choice: ApprovalChoice, note?: string): ApprovalStatus;
}

export interface VoiceFrontDeps {
  bots: FrontBots;
  runner: FrontRunner;
  gate: FrontGate | null;
  calls: { roster(chatId: string): string[] | null };
  factory: FrontFactory;
  /** Fast path on (host config; off = every utterance is a full-session turn, as before). */
  enabled(): boolean;
  /** The per-turn memory recall block (≤ LIMITS.recallMaxChars), or null. */
  recall?(botId: string, text: string): string | null;
  userName?(): string | null;
  /** Plan item 27: the voice chose to say nothing this turn (the call stops waiting for a reply). */
  quiet?(botId: string): void;
  now(): number;
  log?(msg: string, fields?: Record<string, unknown>): void;
}

export interface FrontStats {
  turns: number;
  tokens: number;
  usage: FrontUsage;
  delegations: number;
  speculations: number;
  speculationsCommitted: number;
  speculationsCanceled: number;
  canceledTokens: number;
  firstTextMs: number[];
  edits: number;
}
const newStats = (): FrontStats => ({ turns: 0, tokens: 0, usage: { ...ZERO_FRONT_USAGE }, delegations: 0, speculations: 0, speculationsCommitted: 0, speculationsCanceled: 0, canceledTokens: 0, firstTextMs: [], edits: 0 });

/** One front turn in flight: held (a speculative start, not yet confirmed) or live. */
interface Run { abort: AbortController; begun: boolean; delegated: boolean; tasks: string[]; noted: string[]; held: boolean; canceled: boolean; done: boolean; finished: boolean; buffer: string; stash: string[]; result: FrontTurn | null; approvalId: string | null; kind: "user" | "result"; text: string; retried: boolean }
interface Spec { id: string; text: string; run: Run }
interface Live {
  botId: string;
  session: FrontSession | null;
  startedAt: number;
  /** The call so far, as lines ("User: …" / "Nova: …"). */
  transcript: string[];
  /** Context from the chat before the call (or the last session's lines), given with the next turn. */
  seed: string;
  /** A speculative reply was dropped: the voice is told at its next turn. */
  correction: boolean;
  spec: Spec | null;
  /** Plan item 10: the last user turn's run (a continuation drops it if nothing of it has been said). */
  lastUser: Run | null;
  /** Plan item 20: tasks handed to the full self whose report hasn't come back, oldest first. */
  open: string[];
  /** Review round 1: tasks a dropped fragment had already handed over (the next turn is told, so none goes twice). */
  handed: string[];
  /** The voice failed on this call: the full session answers and its own words are spoken. */
  degraded: boolean;
  stats: FrontStats;
}

/** Bug 220: two transcripts of one utterance compare in their canonical spoken form (Apple's partial vs Whisper's final). */
const wordsOf = spokenWords;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, LINE_CHARS);

export class VoiceFronts {
  private live = new Map<string, Live>();
  /** Call lines the full session hasn't seen yet, by Bot (they ride its next turn). */
  private unsynced = new Map<string, string[]>();
  /** The last finished call's stats, by Bot (the bench and the call-end log). */
  readonly lastStats = new Map<string, FrontStats & { durationMs: number }>();

  constructor(private d: VoiceFrontDeps) {}

  /** A spoken post on a live 1:1 call, with the fast path on. */
  handles(botId: string, voice?: { call?: boolean } | null): boolean {
    if (!voice?.call || !this.d.enabled() || !this.d.bots.has(botId)) return false;
    if (this.d.bots.summary(botId).group) return false;
    const roster = this.d.calls.roster(botId);
    return !!roster && roster.length === 1 && roster[0] === botId;
  }

  /** The Bot is on a fast-path call right now (its full session's stream stays unpublished). */
  onCall(botId: string): boolean {
    return this.live.has(botId);
  }

  stats(botId: string): FrontStats | null {
    return this.live.get(botId)?.stats ?? null;
  }

  // ---------- call lifecycle ----------

  /** A call started (or its roster changed): a 1:1 call warms its voice; a room (2+ Bots) has none. */
  callChanged(chatId: string): void {
    const roster = this.d.calls.roster(chatId);
    const one = !!roster && roster.length === 1 && roster[0] === chatId && this.d.enabled() && this.d.bots.has(chatId) && !this.d.bots.summary(chatId).group;
    if (!one) { this.close(chatId); return; }
    this.ensure(chatId);
  }

  callEnded(chatId: string): void {
    this.close(chatId);
  }

  private ensure(botId: string): Live {
    let L = this.live.get(botId);
    if (!L) {
      L = { botId, session: null, startedAt: this.d.now(), transcript: [], seed: this.seedFromChat(botId), correction: false, spec: null, lastUser: null, open: [], handed: [], degraded: false, stats: newStats() };
      this.live.set(botId, L);
    }
    if (!L.session || !L.session.alive) this.open(L);
    return L;
  }

  private open(L: Live): void {
    const s = this.d.bots.summary(L.botId);
    const p = s.profile;
    const persona = [p.title, p.description].filter(Boolean).join(". ").replace(/\s+/g, " ").slice(0, PERSONA_CHARS);
    const system = `${fillTemplate(loadPrompt("voice-front.md"), { BOT_NAME: p.name, USER_NAME: this.d.userName?.() ?? "the user", PERSONA: persona })}\n${SPEAKABLE}`;
    L.session = this.d.factory({ botId: L.botId, model: p.model ?? DEFAULT_BOT_MODEL, system }); // the Bot's own model; the voice never needs the 1M window
    this.d.log?.("voice-front: session open", { botId: L.botId });
  }

  private close(botId: string): void {
    const L = this.live.get(botId);
    if (!L) return;
    this.live.delete(botId);
    if (L.spec) this.cancelRun(L, L.spec.run);
    L.session?.close();
    const durationMs = this.d.now() - L.startedAt;
    this.lastStats.set(botId, { ...L.stats, durationMs });
    const min = Math.max(durationMs / 60_000, 1 / 60);
    this.d.log?.("voice-front: call summary", {
      botId, durationMs, turns: L.stats.turns, tokens: L.stats.tokens, tokensPerMinute: Math.round(L.stats.tokens / min),
      delegations: L.stats.delegations, speculations: L.stats.speculations, canceled: L.stats.speculationsCanceled, canceledTokens: L.stats.canceledTokens,
    });
  }

  /** The chat just before the call: the voice starts with the gist of what was going on. */
  private seedFromChat(botId: string): string {
    const name = this.d.bots.summary(botId).profile.name;
    const lines: string[] = [];
    for (const e of this.d.bots.tail(botId, 40)) {
      if (e.kind === "message" && e.role === "user" && !("fromAgent" in e && e.fromAgent)) lines.push(`User: ${oneLine(e.content)}`);
      else if (e.kind === "send-message" && e.message.type === "text" && !e.author) lines.push(`${name}: ${oneLine(e.message.content)}`);
    }
    let out = lines.join("\n");
    while (out.length > SEED_CHARS && lines.length) { lines.shift(); out = lines.join("\n"); }
    return out;
  }

  // ---------- utterances ----------

  /** A spoken utterance on the call. `speculationId`: the early start this final confirms (same words). */
  userPost(botId: string, text: string, clientNonce: string, o: { durationMs?: number; speculationId?: string; continues?: boolean } = {}): { entryId: string; ready?: boolean } {
    const r = this.d.runner.recordVoiceUtterance(botId, text, clientNonce, { durationMs: o.durationMs });
    const L = this.ensure(botId);
    // Plan item 10: the user went on right after their last final, before any of the answer played.
    const correction = L.correction;
    const handed = L.handed.length;
    // Review round 1: a fragment that never reached the voice gives its words to the continuation (never lost).
    const unsent = o.continues ? this.dropFragment(L) : null;
    const said = unsent ? `${unsent} ${text}` : text;
    this.line(L, `User: ${oneLine(text)}`);
    const spec = L.spec;
    L.spec = null;
    // A fragment that just handed a task over: the early start was written without that note, so it isn't kept
    // (it could send the task again); a fresh run carries the note.
    const fresh = !!unsent || L.handed.length > handed;
    if (spec && !fresh && o.speculationId === spec.id && !spec.run.canceled && wordsOf(spec.text) === wordsOf(text)) {
      L.stats.speculationsCommitted += 1;
      // Bug 218: the held reply already has words, so its audio is a round trip and a render away: the call makes
      // no "mm" in front of it.
      // Review 1: words, not just a finished run — a run that ended saying nothing is not ready (no sound, then dead air).
      const ready = spec.run.buffer.trim().length > 0 || (spec.run.done && !!spec.run.result?.text.trim());
      L.lastUser = spec.run;
      // A continuation's early start was written before the fragment was dropped: the note can't ride on it now, and
      // must not land on the user's NEXT turn instead (the voice's history already shows the user going on).
      if (o.continues) L.correction = correction;
      this.commit(L, spec.run);
      return { ...r, ready };
    } else {
      if (spec) this.cancelRun(L, spec.run);
      L.lastUser = this.start(L, said, false);
    }
    return r;
  }

  /**
   * Plan item 10: the app heard the user go on from a fragment before any of its answer played, and sends the rest as
   * a continuation. The fragment's run is dropped: one still queued never reaches the model; one being written is
   * never said and hands nothing more over (its tokens are counted as cancelled). The voice is told its last reply
   * wasn't heard (only if it saw one), so it answers the whole thought. Already said (the chat has it): only told.
   * Review round 1: a task the fragment already handed over stays handed over (never cancelled, never sent twice) —
   * the voice is told exactly what went, so it only adds the rest or delegates a change to it. A fragment that never
   * reached the voice returns its words, which the continuation carries.
   */
  private dropFragment(L: Live): string | null {
    const run = L.lastUser;
    L.lastUser = null;
    if (!run || run.canceled || run.kind !== "user") return null;
    this.d.log?.("voice-front: merged a continuation", { botId: L.botId, said: run.finished, handed: run.tasks.length, begun: run.begun });
    L.handed.push(...run.tasks);
    if (run.finished) { L.correction = true; return null; }
    run.canceled = true;
    run.stash = [];
    run.abort.abort();
    this.d.bots.publishTyping(L.botId, false, null);
    if (run.done && run.result) this.canceledTokens(L, run.result);
    if (run.begun) { L.correction = true; return null; }
    return run.text;
  }

  /** The helper's likely end of turn: the voice starts now, held back until the final confirms the words. */
  speculate(botId: string, specId: string, text: string): { started: boolean } {
    const L = this.live.get(botId);
    if (!L || !text.trim() || !this.d.enabled()) return { started: false };
    if (L.spec) { this.cancelRun(L, L.spec.run); L.spec = null; }
    L.stats.speculations += 1;
    L.spec = { id: specId, text, run: this.start(L, text, true) };
    return { started: true };
  }

  cancelSpeculation(botId: string, specId: string): void {
    const L = this.live.get(botId);
    if (!L?.spec || L.spec.id !== specId) return;
    this.cancelRun(L, L.spec.run);
    L.spec = null;
  }

  private line(L: Live, s: string): void {
    L.transcript.push(s);
    if (L.transcript.length > 200) L.transcript.splice(0, L.transcript.length - 200);
    const u = this.unsynced.get(L.botId) ?? [];
    u.push(s);
    if (u.length > SYNC_LINES * 2) u.splice(0, u.length - SYNC_LINES * 2);
    this.unsynced.set(L.botId, u);
  }

  private start(L: Live, text: string, held: boolean, kind: Run["kind"] = "user", retried = false, carry: string[] = []): Run {
    if (L.session && L.session.turns >= MAX_TURNS_PER_SESSION) {
      // A long call: a fresh voice with the latest lines, so the context (and its cost a turn) stays small.
      L.session.close();
      L.session = null;
      L.seed = this.lastLines(L.transcript, RESEED_CHARS);
    }
    if (!L.session || !L.session.alive) this.open(L);
    const pending = kind === "user" ? this.d.gate?.pending(L.botId).at(-1) ?? null : null;
    const run: Run = { abort: new AbortController(), begun: false, delegated: false, tasks: [], noted: [], held, canceled: false, done: false, finished: false, buffer: "", stash: [], result: null, approvalId: pending?.approvalId ?? null, kind, text, retried };
    const parts: string[] = [];
    if (L.seed) { parts.push(`[earlier]\n${L.seed}`); L.seed = ""; }
    if (L.correction) { parts.push("[The user went on: your last reply wasn't heard. Answer everything they said since your last heard reply.]"); L.correction = false; }
    // Review round 1: what a dropped fragment already handed over stays in L.handed until a run carrying the note has
    // actually begun (a run dropped before it began, or a retry, must not lose it: that is how a task goes out twice).
    if (kind === "user") run.noted = [...carry, ...L.handed.filter((t) => !carry.includes(t))];
    if (run.noted.length) parts.push(`[Already handed over (don't send it again): ${run.noted.map(oneLine).join("; ")}. Add only the rest, or delegate a change to it.]`);
    if (kind === "result") parts.push(`[result] ${text}`);
    else {
      if (pending) parts.push(`[approval] Waiting for the user's OK: ${oneLine(pending.summary)}`);
      const rec = ACK_ONLY.test(text.trim()) ? null : this.d.recall?.(L.botId, text);
      if (rec) parts.push(`[recall]\n${rec.replace(/<\/?(system_reminder|recalled_memory)>/g, "").trim()}`);
      if (L.open.length) parts.push(workingLine(L.open));
      parts.push(`User: ${text}`);
    }
    const session = L.session!;
    void session.turn(parts.join("\n"),
      (raw) => {
        if (run.canceled) return;
        const sofar = withoutQuiet(raw);
        if (run.held) run.buffer = sofar;
        else if (sofar.trim()) this.d.bots.publishTyping(L.botId, true, sofar);
      },
      (task) => {
        if (run.canceled) return;
        if (run.held) run.stash.push(task);
        else this.delegate(L, run, task);
      },
      run.abort.signal,
      () => { run.begun = true; if (run.noted.length) L.handed = L.handed.filter((t) => !run.noted.includes(t)); },
    ).then((r) => {
      run.done = true;
      run.result = r;
      this.count(L, r, run.canceled);
      if (run.canceled) return this.canceledTokens(L, r);
      if (!run.held) this.finish(L, run);
    });
    return run;
  }

  private count(L: Live, r: FrontTurn, canceled = false): void {
    L.stats.turns += 1;
    L.stats.tokens += totalTokens(r.usage);
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) L.stats.usage[k] += r.usage[k];
    if (r.firstTextMs !== null) L.stats.firstTextMs.push(r.firstTextMs);
    if (r.error && !canceled) this.d.log?.("voice-front: turn error", { botId: L.botId, error: r.error });
  }

  private canceledTokens(L: Live, r: FrontTurn): void {
    const n = totalTokens(r.usage);
    L.stats.canceledTokens += n;
    this.d.log?.("voice-front: speculative reply dropped", { botId: L.botId, tokens: n, outputTokens: r.usage.outputTokens });
  }

  private commit(L: Live, run: Run): void {
    run.held = false;
    if (run.buffer) this.d.bots.publishTyping(L.botId, true, run.buffer);
    const stash = run.stash;
    run.stash = [];
    for (const t of stash) this.delegate(L, run, t);
    if (run.done) this.finish(L, run);
  }

  private cancelRun(L: Live, run: Run): void {
    if (run.canceled || !run.held) return;
    run.canceled = true;
    run.stash = [];
    // Speed plan #8b (bug 216): a run still queued behind another turn never reaches the model (the voice runs its
    // turns in order: it would only hold the real turn back). One already streaming finishes (front-session.ts).
    run.abort.abort();
    L.stats.speculationsCanceled += 1;
    // The voice's own history now holds a reply the user never heard: it is told at its next turn. Review 1: only if
    // the run reached the model — one dropped while still queued left nothing in its history to correct.
    if (run.begun) L.correction = true;
    if (run.done && run.result) this.canceledTokens(L, run.result);
  }

  private finish(L: Live, run: Run): void {
    if (run.finished || !run.result) return;
    run.finished = true;
    const raw = run.result.text;
    const text = withoutQuiet(raw).replace(/\s{2,}/g, " ").trim();
    this.d.bots.publishTyping(L.botId, false, null);
    // Plan item 27: the voice chose to say nothing (a plain thanks). Not a failure: no retry, no hand-over.
    // Never on an [approval] turn: the card is still waiting for the user's answer, so the turn is answered.
    if (!text && QUIET.test(raw) && !run.delegated && !run.result.delegations.length && !run.approvalId) {
      this.d.log?.("voice-front: quiet", { botId: L.botId });
      this.d.quiet?.(L.botId);
      return;
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > LONG_REPLY_WORDS) this.d.log?.("voice-front: long reply", { botId: L.botId, words, kind: run.kind });
    // The voice said nothing (its process died, or the call failed): never leave the call silent. One retry on a
    // fresh voice, then the full session answers instead and its own words are spoken.
    // Bug 223: it handed the task over without a word of its own (delegate came before any text, and the turn ends at
    // the tool). The voice is fine and the work is on its way: never run the turn again (that handed the task over a
    // second time) — the call says a short pre-rendered "On it." instead.
    if (!text.trim() && (run.delegated || run.result.delegations.length > 0)) {
      this.d.log?.("voice-front: handed over without a word; said the stock line", { botId: L.botId });
      if (this.d.bots.has(L.botId)) this.say(L, STRV.delegatedOnIt);
      return;
    }
    if (!text) {
      const why = run.result.error ?? "no reply";
      this.d.log?.("voice-front: no reply from the voice", { botId: L.botId, error: why, retried: run.retried });
      if (!run.retried && run.kind === "user" && this.d.bots.has(L.botId)) { this.start(L, run.text, false, run.kind, true, run.noted); return; }
      if (run.kind === "user" && this.d.bots.has(L.botId)) this.handOver(L, run.text);
      return;
    }
    if (!this.d.bots.has(L.botId)) return;
    this.say(L, text);
  }

  /** Posts a line as the Bot's voice: it lands in the chat and is what the call speaks. */
  private say(L: Live, text: string): void {
    const turn = this.d.bots.nextTurnNo(L.botId);
    this.d.bots.appendEntry(L.botId, {
      kind: "send-message", id: sendEntryId(turn, 1), requestId: `${FRONT_REQUEST_PREFIX}${randomUUID()}`, createdAt: this.d.now(),
      message: { type: "text", content: text },
    } as TranscriptEntry);
    this.line(L, `${this.d.bots.summary(L.botId).profile.name} (voice): ${oneLine(text)}`);
  }

  /** The voice is down: the full session answers this utterance itself, and its report is spoken as it is. */
  private handOver(L: Live, text: string): void {
    L.degraded = true;
    this.d.runner.enqueueWake(L.botId, {
      source: "voice-delegate", lane: "user", silenceAllowed: false, voiceCall: true,
      prompt: (): ModelMessage[] => [{ text: `Your voice on the call couldn't answer, so answer the user yourself. They said: "${text}"\nReply with SendMessage in one or two short spoken sentences; it is read aloud on the call.` }],
      onSettle: (slot: TurnSlot, result: TurnResult | null) => this.relay(L.botId, slot.sentTexts, result),
    });
  }

  // ---------- delegation and the relay back ----------

  private delegate(L: Live, run: Run, task: string): void {
    run.delegated = true;
    run.tasks.push(task);
    L.stats.delegations += 1;
    const botId = L.botId;
    // Answering a pending card with a change: the card is declined carrying it, and the full session (which is
    // waiting on that card) redoes the action with the change — the new card is read back for a final yes.
    if (run.approvalId && this.d.gate) {
      const approvalId = run.approvalId;
      run.approvalId = null;
      try {
        this.d.gate.resolve(botId, approvalId, "deny", task);
        L.stats.edits += 1;
        this.d.log?.("voice-front: approval edited by voice", { botId });
        return;
      } catch { /* the card settled meanwhile: a new task instead */ }
    }
    const source: WakeSource = "voice-delegate";
    L.open.push(task);
    this.d.runner.enqueueWake(botId, {
      source, lane: "user", silenceAllowed: false, voiceCall: true,
      prompt: (): ModelMessage[] => [{ text: delegateText(task) }],
      onSettle: (slot: TurnSlot, result: TurnResult | null) => this.relay(botId, slot.sentTexts, result, task),
    });
  }

  /** The full session finished a delegated task: its report goes back to the voice, which says the gist. */
  private relay(botId: string, sent: string[], result: TurnResult | null, task?: string): void {
    const L = this.live.get(botId);
    if (!L) return; // the call ended: the chat has the report
    const i = task === undefined ? -1 : L.open.indexOf(task);
    if (i >= 0) L.open.splice(i, 1);
    const report = sent.map(oneLine).join(" ").trim()
      || (result?.error ? `It didn't work: ${oneLine(result.error.message)}` : result?.aborted ? "It was stopped before it finished." : "It's done, with nothing to report.");
    // With the voice down, the full session's own words are spoken (no model call, nothing left unsaid).
    if (L.degraded || !L.session?.alive) { this.say(L, report.slice(0, 1_000)); return; }
    this.start(L, report.slice(0, 1_500), false, "result");
  }

  /** The call lines the full session hasn't seen (its next turn gets them, once). */
  takeUnsynced(botId: string): string | null {
    const u = this.unsynced.get(botId);
    if (!u?.length) return null;
    this.unsynced.delete(botId);
    const body = this.lastLines(u.slice(-SYNC_LINES), SYNC_CHARS);
    return `<system_reminder>On the voice call, your voice (the quick part of you that talks while you work) had this conversation with the user since you last saw it:\n${body}\n</system_reminder>`;
  }

  private lastLines(lines: string[], cap: number): string {
    const out: string[] = [];
    let n = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (n + lines[i]!.length + 1 > cap) break;
      out.unshift(lines[i]!);
      n += lines[i]!.length + 1;
    }
    return out.join("\n");
  }
}

/**
 * Mac actions by voice (bug 142): the recipes ride the delegated task that needs them — open an app or file, send
 * an iMessage/SMS, run a Shortcut, the web. Not a listed skill: the per-turn skill catalog is on a measured ceiling
 * (test/perf/prompt-budget), and every Bot would pay for these on every call of every turn. No new tool either:
 * ExternalShell and the Browser tool do all of it, and a Messages send is always a card (shared/mac-messages.ts).
 */
const MAC_TASK = /\b(message|imessage|sms|text(?:ing|ed)?|whatsapp|open|launch|shortcut|shortcuts|app|finder|file|browser|website|site|book|order)\b/i;
let macRecipes: string | null = null;
export function macRecipeFor(task: string): string | null {
  if (!MAC_TASK.test(task)) return null;
  macRecipes ??= loadPrompt("skills/mac-quick-actions/SKILL.md").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return macRecipes;
}

/** The task as the full session gets it (a hidden wake; the call so far rides along as a reminder). */
export function delegateText(task: string): string {
  const recipes = macRecipeFor(task);
  return [
    "Your voice on the call with the user handed you this task (their own spoken request). Do it now with your tools.",
    `Task: ${task}`,
    "When it's done (or if you can't), report with SendMessage in one or two short plain sentences: your voice reads your report and tells the user. If an action needs the user's OK, the card is read aloud on the call and they answer by voice.",
    ...(recipes ? [`Recipes for the user's Mac (follow these rather than exploring):\n${recipes}`] : []),
  ].join("\n");
}
