import { CALL_FEEL, LIMITS5, STOP_WORDS, STR5, spokenWords } from "@synapse/shared";
import { namesIn, type NamedBot } from "./call-names";
import { isBenignSpeechEnd, permissionFault } from "./dictation-errors";
import { pauseMsFor, PLAIN_PAUSE_MS, QWEN_CHUNK, QWEN_PAUSE_MS, SentenceChunker, VOICE_PAUSE_MS, type PauseTable } from "./sentences";

/**
 * Bug 134: lines the call says by itself, never a reply of the Bot's: the pick-up greeting, a filler
 * when the first sentence is slow, "sorry, go ahead" after a barge-in, "that'll take a minute" on a long
 * task, the hang-up wrap-up, and a spoken notice ("I couldn't find a Bot called ..."). None costs a token.
 */
export type PhraseKind = "greeting" | "filler" | "sorry" | "long-task" | "wrap-up" | "notice" | "ack";

/**
 * Bug 218 (the user's choice (a)): the Bot's short sound ("mm", "okay", "hm") the moment the user stops, ONLY when its
 * answer can't start at once. Without a kept speculative start it goes after a natural beat (ACK_BEAT_MS: review 1 —
 * at the final itself it landed on a user who was only pausing); with one, the answer gets ACK_WAIT_MS to start first.
 * Either way it is checked again when due: not if the user has started talking again, not if the answer is here.
 * Talking over it is never a barge-in on the answer (cutAck). Pre-rendered: no model call.
 */
export const ACK_BEAT_MS = 250;
export const ACK_WAIT_MS = 300;
/**
 * A kept start this old may already have words on the host (the voice never wrote its first word sooner than ~400 ms:
 * the real-model bench, min 404 ms), so the sound waits for the host's word; a younger one can't, so it goes at once.
 */
const SPEC_READY_AFTER_MS = 400;
const ACK_FINISH_MS = 150;
const ACK_MS_PER_CHAR = 70; // ~14 characters a second (voice.log fit)
/**
 * Review 1: never a sound on every turn. The turn right after one that had a sound gets none — measured, even a
 * 1.2 s wait before a second one still sounded on 72% of turns, because the answer really is that slow; a long wait
 * there is still covered by the filler (1.5 s).
 */
/** After a sound, the filler (a whole phrase) waits longer: "Mm." then "Hmm, let me check." is one too many. */
export const FILLER_AFTER_ACK_MS = 2_500;
export type AckMood = "question" | "request" | "other";
const REQUEST = /^(?:(?:ok(?:ay)?|so|and|also|hey|please|now|right|alright)[,\s]+)*(?:(?:can|could|would|will) you\b|please\b|go ahead and\b|i (?:need|want) you to\b|let'?s\b|(?:send|text|message|email|call|open|find|check|look|search|book|remind|schedule|set|add|make|write|tell|ask|read|play|turn|move|cancel|create|draft|reply|show|get|put|start|stop|pull|update)\b)/i;
/** What the user's words were, for the sound that answers them: a request, a question, or anything else. */
export function ackMood(text: string): AckMood {
  const t = text.trim();
  if (REQUEST.test(t)) return "request";
  return QUESTION.test(t) ? "question" : "other";
}

/** A barge-in the user only meant as "hold on": the Bot yields, and nothing is sent as a turn. */
const HOLD = /^(?:wait|hold on|hang on|one sec(?:ond)?|just a sec(?:ond)?|sorry|um+|uh+|hmm+|er+|oh)(?:[\s,]+(?:wait|sorry|a sec(?:ond)?|a moment))?[.!?,\s]*$/i;
const QUESTION = /\?\s*$|^(?:who|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|have|has)\b/i;
/** The whole call is addressed. */
const EVERYONE = /\b(?:all of you|you all|y'?all|everyone|everybody|both of you|you two|you guys|hi all|hey all|team)\b|@(?:all|everyone)\b/i;
/** "go ahead, Bo" / "Bo, go ahead" / "yes, go on" - a raised hand is given the floor. */
const GO_AHEAD = /^(?:(?:ok(?:ay)?|yes|yeah|sure|right)[,\s]+)?(?:go ahead|go on|you go|your turn|over to you)\b|\b(?:go ahead|go on|your turn)[.!\s]*$/i;

/** Bug 142: the words of an utterance, for comparing a speculative start with the final. */
/** Bug 220: two transcripts of one utterance compare in their canonical spoken form (Apple's partial vs Whisper's final). */
const wordsOf = spokenWords;

/**
 * Bug 187: what a listener says WHILE someone talks, to show they are following — not a turn, and not a
 * request to stop. Measured (`say`, two voices): every one of these runs 300-1,000 ms of voice, so each
 * clears the helper's 300 ms barge-in bar and used to stop the Bot, draw "sorry, go ahead" and go to the
 * model as a turn of its own. Never "yes" / "no": over a Bot's question those are answers.
 */
const BACKCHANNEL = /^(?:yeah|yep|yup|mm+[- ]?hm+|mhm+|uh[- ]?huh|right|okay|ok|sure|got it|gotcha|i see|oh wow|wow|nice|cool|totally|exactly|oh okay|oh nice|oh right)(?:[\s,]+(?:yeah|right|okay|sure|got it))?[.!,\s]*$/i;
/**
 * Bug 187: a barge-in is held open this long for the words that caused it. A backchannel resumes the Bot
 * where it was cut; anything else (or nothing heard at all, past RESUME_SILENT_MS) settles it.
 */
const RESUME_WINDOW_MS = 8_000;
/** No words at all this long after a barge-in (a cough, a door, the Bot's own echo): the Bot carries on. */
export const RESUME_SILENT_MS = 2_500;

/**
 * Speed plan #8a: a likely end waits this long for Apple's trailing partial before the speculative start goes out
 * (real cancels: 7 of 18 came 4-40 ms after the start). A second start is allowed for words that trail in within
 * RESPEC_WINDOW_MS of the first (Apple's partial lags the voice 300-500 ms); later words are the user going on.
 */
export const SPEC_SETTLE_MS = 60;
const RESPEC_WINDOW_MS = 600;
const MAX_SPECS = 2;
/**
 * 5.8: a user who goes on after a likely end (a mid-thought pause: "Remind me to call the dentist … on Friday
 * morning") used to get no early start at the REAL end — the one start had gone on the pause — so the reply began only
 * at the final (~1 s after the voice stopped) and the voice's whole time to first text came after it. The helper now
 * sends a likely end again when new words close a clause, and the loop takes it: at most this many starts a turn.
 */
export const MAX_SPECS_TURN = 3;

/**
 * Plan item 3 (call-behaviour): no line takes the floor while the user has an utterance open — a reply that is ready
 * waits for their final (or the helper dropping a wordless one). On the user's calls 25 lines started over an open
 * utterance, 21 of them more than 0.5 s into it, and the helper then cut the user off ("bot-spoke", 13 times). A
 * noise onset that never becomes words can't hold a ready answer for long: the hold lets go this long after the
 * last sign of speech (the utterance's start or its newest words).
 */
export const FLOOR_HOLD_MS = 1_500;
/**
 * Plan item 10: the user started again this soon after their final, before any of the answer played — they hadn't
 * finished. Their next final goes as a continuation of the same turn: the reply to the fragment is never spoken and
 * the voice answers the whole thought once (on the user's calls 44 turns had the user resume within 1.5 s of the
 * end of turn before the Bot spoke, 36 of them after the fragment had already been sent).
 */
export const MERGE_MS = 2_500;

/** Speed plan #7: the call's own lines that only cover a wait; a ready answer never queues behind them. */
const COVER = new Set<PhraseKind>(["filler", "long-task"]);

/** A group post that is only "(pass)" is never shown, and never spoken. */
const PASS = /^\(?\s*pass\s*\)?\.?$/i;

export type CallState = "listening" | "thinking" | "speaking" | "idle";

/** A line waiting for the floor. `done`: a phrase's say() resolves when it ends (or is dropped). */
interface Waiting { reply: Reply; text: string; pauseMs: number; pauseMsFlow?: number; done?: () => void; replayed?: boolean }

/** One Bot reply being spoken: its sentences, what of it has been said, and the entry it became. */
interface Reply {
  botId: string;
  chunker: SentenceChunker;
  /** The final message has arrived (nothing more will stream into this reply). */
  final: boolean;
  entryId?: string;
  /** Lines whose speech finished. */
  said: string[];
  /** Barged over: the rest of it is never spoken. */
  cut: boolean;
  /** The streamed text so far (the watchdog flushes it; a cut reply is recognised by it). */
  text: string;
  /** Bug 134: a line the call says by itself (not the Bot's reply): never "said", never cut in the chat. */
  phrase?: PhraseKind;
  /** Bug 134: a raised hand's reply, held back while another Bot has the floor: its lines so far. */
  held?: string[];
  /** Bug 187: this reply already carried on once after a barge-in with no words (steady noise can't loop it). */
  silentResumed?: boolean;
  /** A reply let go without being cut by the user (an expired hand): the chat keeps it whole. */
  quiet?: boolean;
}

/** A Bot with its hand up, and since when. */
export interface RaisedHand { botId: string; since: number }

/** Reply text arrived and nothing has been handed to speech for this long: the watchdog steps in. */
export const SPEECH_STALL_MS = 3_000;
/**
 * A line whose speech never reports its end is let go after this plus 200 ms a character: about 3×
 * a line's measured length (ce221ffa: 164 chars in 10.7 s), so a slow speech rate never trips it.
 */
const LINE_GRACE_MS = 8_000;
const LINE_MS_PER_CHAR = 200;
/** A cut reply is known by the start of its text. */
const CUT_PREFIX = 24;
/**
 * A monologue is handed to the helper a few sentences at a time, never all at once (voice.log, call
 * 6a3ca1b6: sp-11..sp-19 — nine sentences of a delegated result queued in the same millisecond, a wall
 * of audio the user could only stop by talking over a long tail of it). Two or three are always queued
 * ahead, so the audio stays gapless, and the rest is still only text the loop can drop on a barge-in.
 */
const SPEAK_BATCH = 3;
/** Lines still playing at which the next batch is handed over (the helper never runs dry). */
const SPEAK_REFILL_AT = 1;

/**
 * Voice calls (CHAT-08, bug 101, the call redesign): full duplex, speech → text → a user message,
 * the reply spoken sentence by sentence WHILE it streams, one Bot speaking at a time, and the user's
 * voice always taking the floor (barge-in cancels what is playing and everything queued).
 *
 * States: idle → listening → thinking (a turn is running) → speaking → (barge-in) listening.
 */
export class VoiceLoop {
  state: CallState = "idle";
  private lastPartialAt = 0;
  private startedAt = 0;
  private heard = "";
  /** Whether a native helper process is believed to be running for this loop. */
  private helperLive = false;
  /** `now()` when the current helper session was started, for the restart-storm window. */
  private sessionStartedAt = 0;
  /** The helper exited and listening has to resume; done on the next tick() so the recognizer's
   * `error` + `end` pair for one exit produces exactly one restart. */
  private restartPending = false;
  /** Consecutive helper sessions that came up and died again without hearing anything. */
  private emptyRestarts = 0;
  /** `now()` when the current "thinking" wait started, so that wait can be bounded. */
  private sendingSince = 0;
  /** Identifies the in-flight send so a late rejection cannot disturb a newer state. */
  private sendSeq = 0;
  /** `now()` of the last end of turn (the helper's final), for the latency marks. */
  private turnEndedAt = 0;
  private firstTextMarked = false;
  private firstAudioMarked = false;

  // ---- speech ----
  /** The reply each Bot is speaking now (one per Bot). */
  private replies = new Map<string, Reply>();
  /** Lines waiting for the floor, in arrival order. `done`: a phrase's say() resolves when it ends (or is dropped). */
  private waiting: Waiting[] = [];
  /** The Bot that has the floor (its lines are playing or queued in the helper). */
  private floor: string | null = null;
  /** Lines handed to speech whose speech hasn't ended. */
  private inFlight = 0;
  /** Each Bot's last final message: a late typing event for it is not a new reply. */
  private lastFinal = new Map<string, string>();
  /** Bumped by a barge-in: speech that ends afterwards belongs to a cut-off past. */
  private speechGen = 0;
  /**
   * Replies the user talked over, by Bot, until their final message arrives: their text keeps
   * streaming into the chat but is never spoken. Kept apart from `replies`, so the Bot's NEXT reply
   * is a new one (voice-stall: a cut reply whose final never came used to silence that Bot for good).
   */
  private cutReplies = new Map<string, Reply>();
  /** Lines handed to speech whose end hasn't been reported: a deadline each, so one lost end can't hold the floor. */
  private flights = new Map<number, { deadline: number; finish(): void; w: Waiting }>();
  /**
   * Bug 187: what a barge-in cut off, kept until the user's words say what the barge-in was: a backchannel
   * ("yeah", "mm-hm") or nothing at all puts it back; anything else settles it as cut (the chat marks it).
   */
  private paused: { at: number; floor: string | null; lines: Waiting[]; finals: Reply[]; streaming: Reply[] } | null = null;
  private lineSeq = 0;
  /** `now()` since reply text has been waiting with nothing playing (0 = not waiting). */
  private stallSince = 0;
  /** Plan item 3: lines are waiting because the user has an utterance open (pumped when it closes). */
  private floorHeld = false;
  /** Plan item 16: the last line of a reply that finished playing ended in a question. */
  private lastLineAsked = false;
  /** Plan item 10: the send the user's open utterance continues (null = none). */
  private continuing: number | null = null;

  // ---- bug 134: calls that feel like calling teammates ----
  /** A turn was sent and no reply text has arrived for it yet ("thinking" between call lines). */
  private awaitingReply = false;
  /** No line of a real reply has been handed to speech since the user's turn ended (a filler may play). */
  private awaitingFirstLine = false;
  private fillerDone = false;
  private longTaskDone = false;
  /** Bug 218: when this turn's sound went out (null = none), and the last sound said (never twice running). */
  private ackAt: number | null = null;
  private lastAck: string | null = null;
  /** The previous user turn had a sound (the next one waits ACK_AGAIN_MS before making another). */
  private lastTurnAcked = false;
  /** The Bot answering the current turn (the long-task line's voice). */
  private turnBot: string | null = null;
  /** Who may speak in this turn without raising a hand: the Bots the user named, the first to answer, and hand-offs by name. */
  private owners = new Set<string>();
  private openFloor = true;
  private turnSeq = 0;
  private replyTurn = new WeakMap<Reply, number>();
  /** Raised hands: the held reply of each Bot waiting for the user's go-ahead. */
  private heldReplies = new Map<string, { reply: Reply; since: number }>();
  /** The last barge-in (a following short or questioning utterance may get "sorry, go ahead"). */
  private barged: { botId: string | null; at: number; asked?: boolean; stopped?: boolean } | null = null;
  private lastSorryAt = -Infinity;
  /** The Bot that spoke most recently (a filler's voice when nobody was named). */
  private lastSpeaker: string | null = null;

  /** Mute is the user's call control: the helper drops microphone audio until unmuted. */
  muted = false;

  /**
   * `send` may return a promise (it is a gateway call in the app); a rejection means the Bot never heard the user.
   * Bug 101: `helperEndpoints` — the helper runs continuously (a call) and decides end of turn by
   * itself (voice-activity detection + silence), so the loop never stops it on a pause; `mute`
   * drives the helper's mute. `speak` resolves when that line has been spoken (or cut off); with
   * `queue` it plays after what is already playing, gaplessly.
   */
  constructor(private d: {
    start(): void; stop(): void; send(text: string, durationMs: number, extra?: { speculated?: boolean; continues?: boolean }): unknown;
    /**
     * Bug 166: `pauseMsFlow` is the pause to leave instead when the line really goes to the voice that
     * renders its own — the speech side knows which engine took it and this side cannot.
     */
    speak(text: string, o?: { queue?: boolean; botId?: string; phrase?: PhraseKind; pauseMs?: number; pauseMsFlow?: number }): Promise<void>; cancelSpeech(): void; now(): number; silenceMs: number;
    notify?(message: string): void; mute?(muted: boolean): void; helperEndpoints?: boolean;
    /** A line started playing (captions, the speaking avatar). `phrase`: one the call said by itself. */
    onLine?(botId: string, text: string, phrase?: PhraseKind): void;
    /** A reply was cut off by the user: the chat keeps it cut at what was said. */
    onInterrupted?(botId: string, entryId: string | undefined, said: string): void;
    /** Latency marks for voice.log (ms since the end of the user's turn). */
    mark?(what: string, ms?: number): void;
    // ---- bug 134 ----
    /** The text of a stock phrase in a Bot's voice (a shuffle bag, so none repeats back to back); null = none. */
    phrase?(kind: "filler" | "sorry" | "long-task" | "ack", botId: string, mood?: AckMood): string | null;
    /** Who is on the call (names: addressing, hand-offs, "go ahead, <name>"). */
    members?(): NamedBot[];
    /** The Bot is still working on something (tools running): the long-task line may play. */
    working?(botId: string): boolean;
    /** The call handles this utterance itself (a voice command): true = never sent as a turn. */
    intercept?(text: string): boolean;
    /**
     * Bug 166: this Bot's voice renders its OWN phrasing across a sentence end (Qwen3). Its reply is
     * cut into bigger pieces — two or three sentences to a render, so the model's own line carries
     * across the join — and almost nothing is added after each, because the model already left it.
     */
    naturalFlow?(botId: string): boolean;
    /**
     * Bug 190: this Bot's own voice is Qwen3 — whichever engine says the line (Qwen, or the Kokoro
     * stand-in it falls back to), a "?" is paced like a "." and gets no question handling.
     */
    qwenBot?(botId: string): boolean;
    /** The raised hands changed. */
    onHands?(hands: RaisedHand[]): void;
    // ---- bug 142: the voice fast path ----
    /** A likely end of turn: start the reply now (held until the final confirms it). */
    speculate?(text: string): void;
    /** The user kept talking: drop the speculative reply (its tokens are counted as cancelled). */
    cancelSpeculation?(): void;
    /** Run `fn` once, `ms` from now (the app: setTimeout). Absent: a likely end speculates at once, as before. */
    after?(ms: number, fn: () => void): void;
    /** Plan item 16: the Bot's last line asked something — a short closed answer may end the user's turn sooner. */
    expectAnswer?(): void;
  }) {}

  /** Bug 142: the text a speculative start was made for (null = none live), and how many this user turn has made. */
  private spec: string | null = null;
  private specUsed = 0;
  /**
   * Speed plan #8a (bug 216): a likely end waiting SPEC_SETTLE_MS for Apple's trailing partial, and when the last
   * start was made (a second one is only for trailing words, not for a user who kept talking).
   */
  private specPending: { text: string; seq: number } | null = null;
  private specSeq = 0;
  private specAt = 0;
  /** 5.8: the last start was dropped because the user went on (not Apple's trailing words): the real end may start again. */
  private specWentOn = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.d.mute?.(muted);
  }

  /** The helper heard someone start talking. While the Bot speaks, that is a barge-in. */
  onSpeechStart(): void {
    if (this.state === "idle") return;
    if (!this.startedAt) this.startedAt = this.d.now();
    if (this.state === "speaking") this.bargeIn();
    // Plan item 10: the user went on right after their final, and nothing of the answer has played yet.
    // (After a barge-in on the end-of-turn sound alone the state may read "listening": the answer still hasn't started.)
    if (this.sendSeq > 0 && this.awaitingFirstLine && this.d.now() - this.turnEndedAt <= MERGE_MS) this.continuing = this.sendSeq;
  }

  /**
   * Plan item 5: the helper dropped the utterance it had opened — a sound with no words (a cough, a door, the room).
   * Nobody is talking any more: the filler and the end-of-turn sound may play again, and a held reply takes the
   * floor now (65 of 392 utterances on the user's calls were wordless; each left "user is talking" set until the
   * next final).
   */
  onSpeechDrop(): void {
    if (this.state === "idle") return;
    this.startedAt = 0;
    this.continuing = null;
    this.releaseFloor();
  }

  /** Plan item 3: the user has an utterance open (and showed a sign of speech within FLOOR_HOLD_MS). */
  private userHasFloor(): boolean {
    return this.startedAt !== 0 && this.d.now() - Math.max(this.startedAt, this.lastPartialAt) < FLOOR_HOLD_MS;
  }

  /** Plan item 3: what waited for the user's utterance to close goes out now. */
  private releaseFloor(): void {
    if (!this.floorHeld || this.userHasFloor()) return;
    this.floorHeld = false;
    this.pump();
  }

  /**
   * Plan item 27: the Bot's voice chose to say nothing to this turn (a plain "thanks": `[quiet]`). The turn is over —
   * no filler, no "that'll take a minute", no fault 45 s later — and the call is listening again.
   */
  onQuiet(botId: string): void {
    if (this.state === "idle" || !this.awaitingFirstLine || this.waiting.some((w) => !w.reply.phrase) || this.replies.has(botId)) return;
    this.awaitingReply = this.awaitingFirstLine = false;
    this.fillerDone = this.longTaskDone = true;
    this.d.mark?.("quiet");
    if (this.state === "thinking") this.state = "listening";
  }

  /** The helper already cut its own playback because the user talked over it. */
  onBargeIn(): void {
    if (this.state === "speaking") this.bargeIn();
  }

  private bargeIn(): void {
    // Review 1: over the end-of-turn sound alone, the user's voice is them going on — not a barge-in on the answer.
    if (this.onlyAckPlaying()) return this.cutAck();
    this.lastLineAsked = false;
    this.barged = { botId: this.floor ?? this.lastSpeaker, at: this.d.now() };
    this.settlePaused(); // an older barge-in's words never came: it is cut for good
    // Bug 187: the reply lines that were playing or queued, in order — put back if this was only "yeah".
    const flown = [...this.flights.values()].map((f) => f.w).filter((w) => !w.reply.phrase);
    // Only these were captioned and handed off already; a line still waiting gets both when it first plays.
    for (const w of flown) w.replayed = true;
    const lines = [...flown, ...this.waiting.filter((w) => !w.reply.phrase)];
    // Plan item 4: the line it was cut in, or the last one it finished, asked something: "that's fine" is an answer.
    this.barged.asked = [lines[0]?.text, lines[0]?.reply.said.at(-1), ...[...this.replies.values()].map((r) => r.said.at(-1))].some((x) => x?.trim().endsWith("?"));
    const floor = this.floor;
    this.speechGen += 1;
    this.d.cancelSpeech();
    this.inFlight = 0;
    this.releaseFlights();
    this.dropWaiting();
    this.floor = null;
    this.awaitingReply = false;
    this.stallSince = 0;
    // Every reply still being spoken (or still streaming) is cut at what was said — reported once the
    // user's words confirm it (bug 187), so a backchannel never marks the chat "(interrupted)".
    const finals: Reply[] = [], streaming: Reply[] = [];
    for (const r of this.replies.values()) {
      r.cut = true;
      if (r.final) finals.push(r);
      else { this.cutReplies.set(r.botId, r); streaming.push(r); }
    }
    this.replies.clear();
    this.paused = lines.length || finals.length || streaming.length ? { at: this.d.now(), floor, lines, finals, streaming } : null;
    this.d.mark?.("barge-in");
    this.state = "listening";
  }

  /** Bug 187: the barge-in was real (or too long ago): what it cut stays cut, and the chat says so. */
  private settlePaused(): void {
    const p = this.paused;
    if (!p) return;
    this.paused = null;
    // A reply still streaming stays in cutReplies and is reported when its final comes, as before; one whose
    // final came while it was paused is reported now.
    for (const r of [...p.finals, ...p.streaming.filter((x) => x.final)]) this.reportCut(r);
  }

  /**
   * Bug 187: the user only said "yeah" (or nothing at all): the Bot picks up where it was cut, from the
   * start of the line it was saying — the way a person carries on after "mm-hm".
   */
  private resumePaused(): boolean {
    const p = this.paused;
    this.paused = null;
    if (!p) return false;
    const all = [...p.finals, ...p.streaming];
    for (const r of all) {
      r.cut = false;
      if (this.cutReplies.get(r.botId) === r) this.cutReplies.delete(r.botId);
      this.replies.set(r.botId, r);
    }
    // Text that streamed in while it was paused (and a final that arrived meanwhile) comes after the cut line.
    const more: Waiting[] = [];
    for (const r of p.streaming) more.push(...this.linesFor(r, r.final ? r.chunker.finish(r.text) : r.chunker.push(r.text)));
    const lines = [...p.lines, ...more];
    if (!lines.length) {
      for (const r of all) if (r.final) this.replies.delete(r.botId);
      return false;
    }
    this.d.mark?.("resume");
    this.waiting = [...lines, ...this.waiting];
    this.floor = p.floor ?? lines[0]!.reply.botId;
    this.pump();
    return true;
  }

  private reportCut(r: Reply): void {
    const said = r.said.length ? r.said : r.chunker.spoken().slice(0, 1);
    if (!r.quiet) this.d.onInterrupted?.(r.botId, r.entryId, said.join(" "));
    this.cutReplies.delete(r.botId);
  }

  /**
   * Lines in flight belong to a cut-off past (the speech generation has moved on): end each one, which
   * only resolves a phrase's say() — their counts were already reset.
   */
  private releaseFlights(): void {
    const f = [...this.flights.values()];
    this.flights.clear();
    for (const x of f) x.finish();
  }

  /** Lines that will never be spoken now: a phrase's say() still resolves. */
  private dropWaiting(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const x of w) x.done?.();
  }

  /** `text` belongs to the reply the user cut off (it continues that reply's text). */
  private ofCut(botId: string, text: string): Reply | undefined {
    const c = this.cutReplies.get(botId);
    if (!c) return undefined;
    const a = c.text.trim().slice(0, CUT_PREFIX), b = text.trim().slice(0, CUT_PREFIX);
    return a && (b.startsWith(a) || a.startsWith(b)) ? c : undefined;
  }

  /** A failure the overlay has already put into words (bug 101: the helper's own reason). */
  onFault(message: string): void {
    if (this.state === "idle") return;
    this.fail(message);
  }

  begin(): void {
    this.emptyRestarts = 0;
    this.muted = false; // every call starts with a fresh, unmuted helper
    this.listen();
  }

  end(): void {
    // Review 1: nothing of this call's speculation or sounds carries into the next one.
    this.spec = null;
    this.specUsed = 0;
    this.specPending = null;
    this.specWentOn = false;
    this.lastAck = null;
    this.lastTurnAcked = false;
    this.ackAt = null;
    this.speechGen += 1;
    this.d.cancelSpeech();
    // Any helper that is still up, not only the one behind "listening": ending the call must never
    // leave the microphone live behind a dismissed call screen.
    if (this.helperLive) this.stopHelper();
    this.clearSpeech();
    this.restartPending = false;
    this.helperLive = false;
    this.state = "idle";
  }

  private clearSpeech(): void {
    this.paused = null;
    this.replies.clear();
    this.cutReplies.clear();
    this.lastFinal.clear();
    this.dropWaiting();
    if (this.heldReplies.size) { this.heldReplies.clear(); this.d.onHands?.([]); }
    this.awaitingReply = this.awaitingFirstLine = false;
    this.floor = null;
    this.inFlight = 0;
    this.releaseFlights();
    this.stallSince = 0;
  }

  onPartial(text: string): void {
    if (this.state === "speaking") this.bargeIn();
    // Speed plan #8a: a likely end still settling takes the newer words (Apple's partial trails the voice).
    if (this.specPending) this.specPending.text = text.trim() || this.specPending.text;
    // Bug 142: new words after a likely end: the user wasn't done, so the early start is dropped.
    else if (this.spec !== null && wordsOf(text) !== wordsOf(this.spec)) {
      this.dropSpeculation();
      // Speed plan #8a: words that trail in soon after the start are Apple catching up, not a new thought — the
      // settled text gets one more start (the final still has to match it word for word).
      if (this.d.now() - this.specAt <= RESPEC_WINDOW_MS) this.likelyEnd(text, true);
      else this.specWentOn = true;
    }
    if (!this.startedAt) this.startedAt = this.d.now();
    // Plan item 4: "stop" / "shh" / "enough" over the Bot settles the reply as cut on the partial (it can't come back
    // after a pause), and the final is then neither sent nor answered with "sorry, go ahead".
    const b = this.barged;
    if (b && !b.asked && !b.stopped && this.paused && STOP_WORDS.test(text.trim())) { b.stopped = true; this.settlePaused(); this.d.mark?.("stop"); }
    this.heard = text;
    this.lastPartialAt = this.d.now();
    this.emptyRestarts = 0; // the helper is healthy: it heard someone.
  }

  /** Called on a timer; the helper only finalizes after stop, so silence ends the utterance. */
  tick(): void {
    if (!this.d.helperEndpoints && this.state === "listening" && this.heard && this.d.now() - this.lastPartialAt >= this.d.silenceMs) { this.stopHelper(); return; }
    // "thinking" is bounded: a Bot that answers with a card, a widget or an attachment (or one that
    // is simply very slow) would otherwise strand the call there forever.
    if (this.state === "thinking" && this.d.now() - this.sendingSince >= LIMITS5.voiceSendTimeoutMs) return this.recover(STR5.voiceNoSpokenReply);
    if (this.restartPending) this.resume();
    // Bug 187: a barge-in with no words behind it (a cough, a door, the Bot's own echo) doesn't end the reply.
    if (this.paused && this.state === "listening" && !this.heard && this.d.now() - this.paused.at >= RESUME_SILENT_MS) {
      // Once a reply: a second wordless barge-in (a TV, steady noise, echo) would replay the same line forever.
      const p = this.paused;
      const rs = new Set([...p.finals, ...p.streaming, ...p.lines.map((w) => w.reply)]);
      if ([...rs].some((r) => r.silentResumed)) this.settlePaused();
      else { for (const r of rs) r.silentResumed = true; this.resumePaused(); }
    }
    else if (this.paused && this.d.now() - this.paused.at >= RESUME_WINDOW_MS) this.settlePaused();
    this.releaseFloor(); // plan item 3: a hold past FLOOR_HOLD_MS with no sign of speech lets go
    this.watchdog();
    this.feel();
  }

  /**
   * Bug 134, on the loop's clock: a filler when the first sentence is slow (never over real speech),
   * "that'll take a minute" once when a turn keeps working, and raised hands let go after 20 s.
   */
  private feel(): void {
    if (this.state === "idle") return;
    const now = this.d.now();
    let handsChanged = false;
    for (const [id, h] of [...this.heldReplies]) {
      if (now - h.since < CALL_FEEL.handExpiresMs) continue;
      this.heldReplies.delete(id);
      handsChanged = true;
      // Its text stays in the chat, whole; the rest of it (if still streaming) is never spoken.
      if (!h.reply.final) { h.reply.quiet = true; this.cutReplies.set(id, h.reply); }
    }
    if (handsChanged) this.emitHands();
    const quiet = this.inFlight === 0 && this.waiting.length === 0 && !this.startedAt;
    if (!quiet || !this.d.phrase) return;
    // Bug 186: only while NO text of the answer has come. Once it is streaming its first line is a few hundred ms
    // away, and a filler queued then stood in front of it: on the user's calls 16 of 29 fillers started after
    // the answer's text had arrived and held it back a median 2.0 s (a filler plays ~1.8 s).
    if (this.state === "thinking" && this.awaitingReply && this.awaitingFirstLine && !this.fillerDone && now - this.turnEndedAt >= (this.ackAt !== null ? FILLER_AFTER_ACK_MS : CALL_FEEL.fillerAfterMs)) {
      this.fillerDone = true;
      const who = this.responder();
      const text = who ? this.d.phrase("filler", who) : null;
      if (who && text) { this.d.mark?.("filler", now - this.turnEndedAt); void this.say(who, text, "filler"); }
      return;
    }
    if (!this.longTaskDone && this.turnSeq > 0 && now - this.turnEndedAt >= CALL_FEEL.longTaskAfterMs) {
      const who = this.turnBot ?? this.responder();
      const busy = who !== null && (this.state === "thinking" || (this.state === "listening" && this.d.working?.(who) === true));
      if (!busy) return;
      this.longTaskDone = true;
      const text = this.d.phrase("long-task", who);
      if (text) void this.say(who, text, "long-task");
    }
  }

  /** Only the end-of-turn sound is playing (nothing of an answer is in flight). */
  private onlyAckPlaying(): boolean {
    const f = [...this.flights.values()];
    return f.length > 0 && f.every((x) => x.w.reply.phrase === "ack");
  }

  /**
   * Review 1: the user talked over the sound. It fades out (the helper's 80 ms fade) and that is all: no barge-in
   * mark (so no "sorry, go ahead"), the answer the user is waiting for is still awaited and still plays.
   */
  private cutAck(): void {
    this.speechGen += 1;
    this.d.cancelSpeech();
    this.inFlight = 0;
    this.releaseFlights();
    this.floor = null;
    this.state = this.awaitingReply ? "thinking" : "listening";
    this.d.mark?.("ack-cut");
  }

  /**
   * Bug 218: the sound, if the answer still hasn't started: no line of it handed to speech, none of its text here
   * (text arriving means its first line is a few hundred ms off), and never while the user is talking again.
   */
  private ack(seq: number, heard: string): void {
    if (this.sendSeq !== seq || this.state !== "thinking" || !this.awaitingReply || !this.awaitingFirstLine || this.inFlight || this.waiting.length) return;
    // The user has started again since their final (a voice, or new words): they were only pausing.
    if (this.startedAt || this.lastPartialAt > this.turnEndedAt) return;
    const who = this.responder();
    const mood = ackMood(heard);
    let text = who ? this.d.phrase?.("ack", who, mood) : null;
    // Never the same sound twice running (the bags are per mood, and some sounds are in two of them).
    if (text && text === this.lastAck) text = this.d.phrase?.("ack", who!, mood) ?? null;
    if (!who || !text || text === this.lastAck) return;
    this.lastAck = text;
    this.lastTurnAcked = true;
    this.ackAt = this.d.now();
    this.d.mark?.("ack", this.ackAt - this.turnEndedAt);
    void this.say(who, text, "ack");
  }

  /** Who is answering the user's turn: the one Bot named, else the only Bot, else whoever spoke last. */
  private responder(): string | null {
    const m = this.d.members?.() ?? [];
    if (this.owners.size === 1) return [...this.owners][0]!;
    if (m.length === 1) return m[0]!.id;
    return this.lastSpeaker && m.some((x) => x.id === this.lastSpeaker) ? this.lastSpeaker : null;
  }

  private emitHands(): void {
    this.d.onHands?.(this.hands());
  }

  /** The raised hands, oldest first. */
  hands(): RaisedHand[] {
    return [...this.heldReplies.values()].map((h) => ({ botId: h.reply.botId, since: h.since })).sort((a, b) => a.since - b.since);
  }

  /** The user said "go ahead, <name>" or clicked the hand: that Bot's held reply is spoken next. */
  goAhead(botId: string): boolean {
    const h = this.heldReplies.get(botId);
    if (!h) return false;
    this.heldReplies.delete(botId);
    this.owners.add(botId);
    const r = h.reply;
    const lines = r.held ?? [];
    delete r.held;
    if (!r.final) this.replies.set(botId, r);
    this.emitHands();
    this.enqueue(r, lines);
    if (r.final) this.settle();
    return true;
  }

  /**
   * Say a line of the call's own (greeting, filler, sorry, long task, wrap-up, notice) in a Bot's voice.
   * It takes the floor like a reply line; resolves when it has been spoken, cut off or dropped.
   */
  say(botId: string, text: string, kind: PhraseKind): Promise<void> {
    if (this.state === "idle" || !text.trim()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const reply: Reply = { botId, chunker: new SentenceChunker(), final: true, said: [], cut: false, text, phrase: kind };
      // Review 1: no sentence pause after the end-of-turn sound — the answer follows it straight on (the sound's own
      // tail is its breath), and a pause there only held the answer back.
      this.waiting.push({ reply, text: text.trim(), pauseMs: kind === "ack" ? 0 : pauseMsFor(text.trim(), this.pauses(botId)), done: resolve });
      this.pump();
    });
  }

  /**
   * voice-stall: reply text arrived during a call and nothing has been handed to speech for
   * SPEECH_STALL_MS (or a line's end was never reported). Log it and recover: let go of a line past
   * its deadline, release the floor, flush a stream that stopped short of a sentence end, re-pump.
   */
  private watchdog(): void {
    if (this.state === "idle") return;
    const now = this.d.now();
    for (const f of [...this.flights.values()]) if (now >= f.deadline) { this.d.mark?.("stall-line"); f.finish(); }
    if (this.floorHeld) { this.stallSince = 0; return; } // plan item 3: waiting for the user, not stalled
    const pending = this.inFlight === 0 && (this.waiting.length > 0 || [...this.replies.values()].some((r) => r.chunker.hasPending(r.text)));
    if (!pending) { this.stallSince = 0; return; }
    if (!this.stallSince) { this.stallSince = now; return; }
    if (now - this.stallSince < SPEECH_STALL_MS) return;
    this.d.mark?.("stall", now - this.stallSince);
    this.stallSince = 0;
    this.floor = null;
    for (const r of this.replies.values()) if (!r.final) this.queueLines(r, r.chunker.flush(r.text));
    this.pump();
  }

  /**
   * Bug 142: the helper judged the utterance complete (the recognizer's final with sentence punctuation,
   * a complete clause, a falling voice) before the silence window ran out. At most one early start a
   * user turn, only while listening, never for a bare hold ("wait").
   */
  onLikelyEnd(text: string): void {
    this.likelyEnd(text, false);
  }

  /**
   * Speed plan #8a (bug 216): the start waits SPEC_SETTLE_MS for Apple's trailing partial (7 of 18 real cancels came
   * 4-40 ms after the start, carrying the last word), then goes out on the newest words. `again`: a second start,
   * after trailing words cancelled the first. At most MAX_SPECS a user turn.
   */
  private likelyEnd(text: string, again: boolean): void {
    const t = text.trim();
    // 5.8: a fresh start at the real end, after the user went on from an earlier one.
    const fresh = !again && this.specWentOn && this.specUsed < MAX_SPECS_TURN;
    if (!this.mayListenAhead(again) || !this.d.speculate || this.specPending || (this.specUsed >= (again ? MAX_SPECS : 1) && !fresh) || !t || HOLD.test(t) || STOP_WORDS.test(t)) return;
    // Already started on exactly these words (the helper's own likely end for the words the trailing partial brought).
    if (this.spec !== null && wordsOf(t) === wordsOf(this.spec)) return;
    if (fresh) this.specWentOn = false;
    if (!this.d.after) return this.speculateNow(t);
    const seq = ++this.specSeq;
    this.specPending = { text: t, seq };
    this.d.after(SPEC_SETTLE_MS, () => {
      const p = this.specPending;
      if (!p || p.seq !== seq) return;
      this.specPending = null;
      if (this.mayListenAhead(again) && !HOLD.test(p.text) && !STOP_WORDS.test(p.text)) this.speculateNow(p.text);
    });
  }

  /**
   * A speculative start is for a user turn in progress: while listening, or (plan item 3) while the last turn's reply
   * is held because the user started talking again — their new words are the next turn, and it may start early too.
   */
  private mayListenAhead(again = false): boolean {
    return this.state === "listening" || (!again && this.continuing === this.sendSeq);
  }

  private speculateNow(t: string): void {
    this.specUsed += 1;
    this.spec = t;
    this.specAt = this.d.now();
    this.d.mark?.("speculate");
    this.d.speculate!(t);
  }

  private dropSpeculation(): void {
    if (this.spec === null) return;
    this.spec = null;
    this.d.mark?.("speculate-cancel");
    this.d.cancelSpeculation?.();
  }

  onFinal(text: string): void {
    this.final(text);
    // Plan item 3: the utterance is closed — whatever waited for it takes the floor now (after the turn is sent).
    if (this.floorHeld && this.state !== "idle") { this.floorHeld = false; this.pump(); }
  }

  private final(text: string): void {
    if (this.state === "idle") return;
    this.lastLineAsked = false;
    const t = text.trim();
    // Bug 142: the final either confirms the early start (same words) or ends it.
    const speculated = this.spec !== null && t !== "" && wordsOf(t) === wordsOf(this.spec);
    if (!speculated) this.dropSpeculation();
    this.spec = null;
    this.specUsed = 0;
    this.specPending = null;
    this.specWentOn = false;
    const duration = this.lastPartialAt - this.startedAt;
    this.heard = "";
    this.startedAt = 0;
    const barged = this.barged && this.d.now() - this.barged.at < 15_000 ? this.barged : null;
    this.barged = null;
    // Bug 187: "yeah" / "mm-hm" over the Bot is listening, not a turn: nothing is sent, nobody says sorry,
    // and the Bot carries on from the line it was cut in. Over a question the words are an answer instead.
    const paused = this.paused && this.d.now() - this.paused.at < RESUME_WINDOW_MS ? this.paused : null;
    // The line it was cut in, and the last one it finished: if either asked something, "sure" is the answer.
    const asked = paused ? [paused.lines[0]?.text, paused.lines[0]?.reply.said.at(-1), ...[...paused.finals, ...paused.streaming].map((r) => r.said.at(-1))].some((x) => x?.trim().endsWith("?")) : false;
    // Nothing heard: the barge-in stays open, and tick() carries the Bot on (once) after RESUME_SILENT_MS.
    if (paused && !t) return this.listen();
    // Plan item 4: a silent yield — 8 short words over the Bot on the user's calls drew "sorry, go ahead" and were
    // then sent as a turn of their own (the Bot spoke again 1.4-4.7 s later).
    if (barged && !barged.asked && STOP_WORDS.test(t)) {
      if (speculated) { this.spec = t; this.dropSpeculation(); }
      if (!barged.stopped) this.d.mark?.("stop");
      this.continuing = null; // review round 1: a yield continues nothing
      this.settlePaused();
      return this.idleTurn();
    }
    if (paused && t && BACKCHANNEL.test(t) && !asked) {
      if (speculated) { this.spec = t; this.dropSpeculation(); }
      this.d.mark?.("backchannel");
      this.state = "listening";
      if (!this.resumePaused()) this.idleTurn();
      return;
    }
    this.settlePaused();
    if (!t) return this.listen();
    this.emptyRestarts = 0;
    // Bug 134: a raised hand given the floor by voice, and the call's own voice commands, are never a turn.
    if (this.heldReplies.size && GO_AHEAD.test(t)) {
      const named = namesIn(t, (this.d.members?.() ?? []).filter((m) => this.heldReplies.has(m.id)));
      const pick = named[0] ?? (this.heldReplies.size === 1 ? [...this.heldReplies.keys()][0] : undefined);
      if (pick && this.goAhead(pick)) return;
    }
    if (this.d.intercept?.(t)) { if (speculated) { this.spec = t; this.dropSpeculation(); } return this.idleTurn(); }
    // Polite interruptions: after talking over the Bot with something short or a question, it yields
    // ("sorry, go ahead"), at most once every 90 s. A bare "wait" / "hold on" is not sent as a turn.
    const hold = HOLD.test(t);
    let sorry = false;
    if (barged && (hold || t.split(/\s+/).length <= 3 || QUESTION.test(t)) && this.d.now() - this.lastSorryAt >= CALL_FEEL.sorryMinGapMs && this.d.phrase) {
      const who = barged.botId ?? this.responder();
      const line = who ? this.d.phrase("sorry", who) : null;
      if (who && line) { this.lastSorryAt = this.d.now(); sorry = true; void this.say(who, line, "sorry"); }
    }
    if (hold && barged) { if (speculated) { this.spec = t; this.dropSpeculation(); } return this.idleTurn(); }
    // Plan item 10: the words go on the thought the last send began — its answer (held, never started) is dropped and
    // the host answers the whole thing once. Not for a bare "um" / "yeah": that answer still plays.
    const continues = this.continuing === this.sendSeq && this.awaitingFirstLine && !hold && !BACKCHANNEL.test(t);
    this.continuing = null;
    if (continues) this.dropFragmentReply();
    this.turnSeq += 1;
    // "Hi all" / "what do you all think": everyone on the call may answer (in turn), no hands.
    const named = EVERYONE.test(t) ? (this.d.members?.() ?? []).map((m) => m.id) : namesIn(t, this.d.members?.() ?? []);
    this.owners = new Set(named);
    this.openFloor = named.length === 0;
    this.turnBot = named.length === 1 ? named[0]! : null;
    this.awaitingReply = this.awaitingFirstLine = true;
    this.fillerDone = sorry; // a sorry line already filled the silence
    this.longTaskDone = false;
    this.state = "thinking";
    this.sendingSince = this.turnEndedAt = this.d.now();
    this.firstTextMarked = this.firstAudioMarked = false;
    this.ackAt = null;
    const seq = ++this.sendSeq;
    this.d.mark?.("sent");
    // Bug 218: the sound. No kept start: the answer can't be ready, so it goes now. A kept start: the host says, in
    // its answer to the send, whether the reply it held already has text (then the answer is ~0.4 s off and plays
    // alone); no word inside ACK_WAIT_MS, and the sound goes anyway.
    let acked = sorry || !this.d.after || !this.d.phrase;
    const ack = () => { if (acked) return; acked = true; this.ack(seq, t); };
    // A start made only just now can't have words yet (the voice's first text takes ~0.6-0.9 s): no need to ask.
    const mayBeReady = speculated && this.d.now() - this.specAt >= SPEC_READY_AFTER_MS;
    if (this.lastTurnAcked) acked = true;
    this.lastTurnAcked = false;
    if (!acked) this.d.after!(mayBeReady ? ACK_WAIT_MS : ACK_BEAT_MS, ack);
    // The filler is due at a set time after the final: checked then, not on the next 200 ms tick (it came up to a tick
    // late, ~100 ms on average, on every turn that needed one). feel() decides; a newer turn makes these no-ops.
    if (this.d.after) for (const ms of [CALL_FEEL.fillerAfterMs, FILLER_AFTER_ACK_MS]) this.d.after(ms, () => this.feel());
    // The send is a promise in the app (a gateway call). If it rejects, the Bot never heard the
    // user: say so and hand the microphone back instead of waiting out the timeout in silence.
    const extra = speculated || continues ? { ...(speculated ? { speculated: true } : {}), ...(continues ? { continues: true } : {}) } : undefined;
    void Promise.resolve(this.d.send(t, duration, extra)).then((r) => {
      if (!speculated || acked) return;
      if ((r as { ready?: unknown } | null | undefined)?.ready === true) acked = true;
      else ack();
    }, () => {
      if (this.state !== "thinking" || this.sendSeq !== seq) return; // a newer turn owns the loop
      this.recover(STR5.voiceSendFailed);
    });
  }

  /**
   * Plan item 10: the answer to a fragment the user went on from is never spoken — its held lines are dropped and its
   * text (if more streams in) is let go quietly: the chat keeps it whole, nothing is marked cut.
   */
  private dropFragmentReply(): void {
    this.waiting = this.waiting.filter((w) => w.reply.phrase !== undefined);
    for (const r of this.replies.values()) {
      r.cut = true;
      r.quiet = true;
      if (!r.final) this.cutReplies.set(r.botId, r);
    }
    this.replies.clear();
    this.d.mark?.("merged");
  }

  /**
   * The native helper process ended — by itself (silence: Apple's recognizer stops the task, the
   * helper reports "No speech detected" and exits) or after a real error. The overlay routes both
   * `end` and `error` here, and one exit reports both, so the restart is deferred to the next tick
   * and happens once.
   */
  /** An utterance the call handled itself: nothing is sent; the microphone stays with the user. */
  private idleTurn(): void {
    if (this.state !== "speaking") this.state = "listening";
  }

  onSessionEnd(error?: string): void {
    if (this.state === "idle") return;
    if (error && !isBenignSpeechEnd(error)) return this.fail(permissionFault(error)?.text ?? error);
    this.helperLive = false;
    // While the loop is waiting on the Bot or talking, the helper going away is expected and
    // harmless — the speech path owns the state and starts the helper again when it is done.
    if (this.state === "thinking" || this.state === "speaking") return;
    this.restartPending = true;
  }

  /** The reply streaming in (the typing event's text so far); null = the Bot stopped typing. */
  onBotStream(botId: string, partial: string | null): void {
    if (this.state === "idle" || !partial) return;
    // A reply the user cut off keeps streaming into the chat, but is never spoken.
    const cut = this.ofCut(botId, partial);
    if (cut) { cut.text = partial; return; }
    const held = this.heldReplies.get(botId)?.reply;
    if (held && !held.final) { held.text = partial; held.held!.push(...held.chunker.push(partial)); return; }
    let r = this.replies.get(botId);
    if (!r || r.final) {
      // The typing state and the final message arrive in either order: text the last final message
      // already contains belongs to that reply, not to a new one.
      if (this.lastFinal.get(botId)?.startsWith(partial.trim())) return;
      r = this.newReply(botId);
      if (this.holdIfNeeded(r)) { r.text = partial; r.held!.push(...r.chunker.push(partial)); return; }
    }
    r.text = partial;
    this.markFirstText(botId);
    this.enqueue(r, r.chunker.push(partial));
  }

  /**
   * Bug 134 (item 7): a Bot that answers while another has the floor, when nobody asked it (the user
   * didn't name it, no Bot handed it a part, and it isn't the first answer to the user's turn), raises
   * a hand instead of talking: its reply is held until the user says "go ahead, <name>" or clicks it.
   */
  private holdIfNeeded(r: Reply): boolean {
    const m = this.d.members?.() ?? [];
    if (m.length < 2 || this.owners.has(r.botId)) return false;
    const current = this.replyTurn.get(r) === this.turnSeq && this.turnSeq > 0;
    if (current && this.openFloor && this.owners.size === 0) { this.owners.add(r.botId); return false; }
    const busy = (this.floor !== null && this.floor !== r.botId) || this.inFlight > 0 || this.waiting.some((w) => w.reply.botId !== r.botId);
    if (!busy) { if (current) this.owners.add(r.botId); return false; }
    this.replies.delete(r.botId);
    r.held = [];
    this.heldReplies.set(r.botId, { reply: r, since: this.d.now() });
    this.emitHands();
    return true;
  }

  /** A final Bot message (a SendMessage text entry). Only what the stream hasn't already said is spoken. */
  onBotText(text: string, botId = "", entryId?: string): void {
    if (this.state === "idle") return;
    const cut = this.ofCut(botId, text);
    if (cut) {
      // The user talked over this reply while it streamed: the chat keeps it cut at what was said.
      cut.entryId = entryId;
      cut.final = true;
      cut.text = text;
      this.lastFinal.set(botId, text.trim());
      // Bug 187: unless the barge-in may still turn out to be a backchannel — then it waits for the words.
      if (this.paused?.streaming.includes(cut)) return;
      return this.reportCut(cut);
    }
    const held = this.heldReplies.get(botId)?.reply;
    if (held && !held.final) {
      held.final = true;
      held.entryId = entryId;
      held.text = text;
      held.held!.push(...held.chunker.finish(text));
      this.lastFinal.set(botId, text.trim());
      return;
    }
    let r = this.replies.get(botId);
    this.lastFinal.set(botId, text.trim());
    if (!r || r.final) {
      r = this.newReply(botId);
      if (this.holdIfNeeded(r)) { r.final = true; r.entryId = entryId; r.text = text; r.held!.push(...r.chunker.finish(text)); return; }
    }
    r.final = true;
    r.entryId = entryId;
    this.markFirstText(botId);
    this.enqueue(r, r.chunker.finish(text));
    this.settle();
  }

  private newReply(botId: string): Reply {
    // Bug 166: a voice that phrases across a sentence end is given two or three sentences at a time;
    // the opening chunk is still a clause, so first audio is exactly as early as it was.
    const group = this.d.naturalFlow?.(botId) === true ? { group: QWEN_CHUNK } : {};
    const r: Reply = { botId, chunker: new SentenceChunker({ firstClause: true, ...group }), final: false, said: [], cut: false, text: "" };
    this.replies.set(botId, r);
    this.replyTurn.set(r, this.turnSeq);
    return r;
  }

  private markFirstText(botId?: string): void {
    this.awaitingReply = false;
    if (botId && !this.turnBot) this.turnBot = botId;
    if (this.firstTextMarked || !this.turnEndedAt) return;
    this.firstTextMarked = true;
    this.d.mark?.("first-text", this.d.now() - this.turnEndedAt);
  }

  /** The helper reports the first audio of a reply went out: the end-of-turn → first-audio latency. */
  onAudioOut(): void {
    if (this.firstAudioMarked || !this.turnEndedAt) return;
    this.firstAudioMarked = true;
    this.d.mark?.("first-audio", this.d.now() - this.turnEndedAt);
  }

  private enqueue(r: Reply, lines: string[]): void {
    this.queueLines(r, lines);
    this.pump();
  }

  /** Bug 190: a Qwen Bot's Kokoro-voiced lines pace a "?" like a "."; every other Bot's are as they were. */
  private pauses(botId: string): PauseTable {
    return this.d.qwenBot?.(botId) === true ? PLAIN_PAUSE_MS : VOICE_PAUSE_MS;
  }

  private queueLines(r: Reply, lines: string[]): void {
    this.waiting.push(...this.linesFor(r, lines));
  }

  private linesFor(r: Reply, lines: string[]): Waiting[] {
    const flow = this.d.naturalFlow?.(r.botId) === true;
    const out: Waiting[] = [];
    for (const raw of lines) {
      // The punctuation goes to the helper with the words: it is what the voice reads the sentence's
      // shape from (a stripped full stop made every line trail off), and it chooses the pause after it.
      const pauseMs = pauseMsFor(raw, this.pauses(r.botId));
      const text = raw.trim();
      // Bug 166: both pauses ride along. A Qwen Bot's line still goes to its Kokoro voice whenever the
      // big model is cold — and a Kokoro line with Qwen's pause would run into the next one.
      if (text && !PASS.test(text)) out.push({ reply: r, text, pauseMs, ...(flow ? { pauseMsFlow: pauseMsFor(raw, QWEN_PAUSE_MS) } : {}) });
    }
    return out;
  }

  /**
   * Hand lines to speech: the floor Bot's next few (SPEAK_BATCH), which the helper queues gaplessly.
   * The rest waits here until the batch nearly drains, so a long answer can be interrupted at once.
   */
  private pump(): void {
    if (this.state === "idle") return;
    // Plan item 3: the user is talking — nothing new takes the floor until their utterance closes (a barge-in has
    // already stopped whatever was playing, so this only ever holds a line that hasn't started).
    if (this.waiting.length && this.state !== "speaking" && this.userHasFloor()) {
      if (!this.floorHeld) this.d.mark?.("floor-held");
      this.floorHeld = true;
      return;
    }
    this.floorHeld = false;
    this.cutCover();
    if (!this.floor && this.waiting.length) this.floor = this.waiting[0]!.reply.botId;
    const mine: typeof this.waiting = [];
    const rest: typeof this.waiting = [];
    for (const w of this.waiting) {
      if (w.reply.botId === this.floor && mine.length + this.inFlight < SPEAK_BATCH) mine.push(w);
      else rest.push(w);
    }
    if (!mine.length) return;
    this.waiting = rest;
    if (this.state !== "speaking") {
      this.state = "speaking";
      this.restartPending = false;
      // Keep listening for barge-in while speaking. A call-mode helper is still up (bug 101): it
      // speaks the reply itself, so starting another one would cut the reply off.
      if (!this.helperLive || !this.d.helperEndpoints) this.startHelper();
    }
    const gen = this.speechGen;
    this.stallSince = 0;
    for (const w of mine) {
      this.inFlight += 1;
      const id = ++this.lineSeq;
      let ended = false;
      const phrase = w.reply.phrase;
      // Once per line, whichever comes first: its speech ending (or failing), or the watchdog's deadline.
      const finish = () => {
        if (ended) return;
        ended = true;
        this.flights.delete(id);
        w.done?.();
        if (gen !== this.speechGen) return; // cut off by a barge-in or the end of the call
        this.inFlight -= 1;
        if (!phrase) { w.reply.said.push(w.text); this.lastLineAsked = w.text.trim().endsWith("?"); }
        // The batch is nearly played out: hand over the next one while the last line is still going,
        // so a long answer stays gapless without ever being queued whole (6a3ca1b6).
        if (this.inFlight <= SPEAK_REFILL_AT && this.waiting.some((x) => x.reply.botId === this.floor)) this.pump();
        this.settle();
      };
      this.flights.set(id, { deadline: this.d.now() + LINE_GRACE_MS + w.text.length * LINE_MS_PER_CHAR, finish, w });
      if (!phrase) {
        this.awaitingFirstLine = false;
        this.lastSpeaker = w.reply.botId;
        // Bug 187: a line said again after a backchannel was captioned and handed off the first time.
        if (!w.replayed) this.handOff(w.reply.botId, w.text);
      }
      if (!w.replayed) this.d.onLine?.(w.reply.botId, w.text, phrase);
      void Promise.resolve(this.d.speak(w.text, { queue: true, botId: w.reply.botId, pauseMs: w.pauseMs, ...(w.pauseMsFlow !== undefined ? { pauseMsFlow: w.pauseMsFlow } : {}), ...(phrase ? { phrase } : {}) })).then(finish, finish);
    }
  }

  /**
   * Speed plan #7 (bug 215): the answer's first line is ready while only the call's own cover is playing (a
   * filler, "that'll take a minute"): the cover fades out (the helper's 80 ms barge-in fade, bug 188) and the
   * answer plays next, instead of queuing behind the rest of a ~1.8 s filler (measured: held a median 1.1 s).
   */
  private cutCover(): void {
    if (!this.inFlight || !this.waiting.some((w) => !w.reply.phrase)) return;
    const flying = [...this.flights.values()];
    if (!flying.length || !flying.every((f) => COVER.has(f.w.reply.phrase!) || this.ackLeftMs(f.w) > ACK_FINISH_MS)) return;
    this.speechGen += 1;
    this.d.cancelSpeech();
    this.inFlight = 0;
    this.releaseFlights();
    this.floor = null;
    this.d.mark?.("cover-cut");
  }

  /**
   * Bug 218: how much of a sound is still to play (ms, estimated from its length: ~65 ms a character, measured on
   * the cached takes). An answer ready while more than ACK_FINISH_MS of it is left fades it out like a filler; the
   * tail of one nearly done is let finish (a clipped "oka-" is worse than 150 ms).
   */
  private ackLeftMs(w: Waiting): number {
    if (w.reply.phrase !== "ack" || this.ackAt === null) return -1;
    return w.text.length * ACK_MS_PER_CHAR - (this.d.now() - this.ackAt);
  }

  /** Bug 134 (item 6): a Bot's line that names a teammate hands it the floor next (and lowers its hand, if raised). */
  private handOff(from: string, text: string): void {
    const m = (this.d.members?.() ?? []).filter((x) => x.id !== from);
    if (!m.length) return;
    for (const id of namesIn(text, m)) {
      this.owners.add(id);
      if (this.heldReplies.has(id)) this.goAhead(id);
    }
  }

  /**
   * Speech ran dry: pass the floor on, or go back to listening. The floor is handed on whatever the
   * call state is (voice-stall: a user turn that ended while a Bot was still speaking — the helper's
   * "bot-spoke" end of turn — used to leave the floor with that Bot for good, so another Bot's
   * replies were never spoken again).
   */
  private settle(): void {
    if (this.inFlight > 0) return;
    // A paced reply still has lines of its own waiting: they go next, streaming or not.
    if (this.floor && this.waiting.some((w) => w.reply.botId === this.floor)) return this.pump();
    const r = this.floor ? this.replies.get(this.floor) : undefined;
    if (r && !r.final) return; // the floor Bot is still streaming: its next sentence is coming
    if (r?.final) this.replies.delete(r.botId);
    this.floor = null;
    if (this.waiting.length) return this.pump();
    if (this.state !== "speaking") return; // a user turn is in flight ("thinking"): it owns the state
    // Bug 134: only the call's own line (a filler) has played; the reply is still coming.
    if (this.awaitingReply && this.helperLive) { this.state = "thinking"; return; }
    // If the helper died mid-reply, come back with a live one instead of a dead "listening".
    if (this.helperLive) this.state = "listening";
    else this.listen();
    // Plan item 16: the reply ended on a question — the helper may end a short closed answer ("Yes.") sooner.
    if (this.lastLineAsked) { this.lastLineAsked = false; this.d.expectAnswer?.(); }
  }

  /** Bring listening back after the helper exited, unless it keeps dying straight away. */
  private resume(): void {
    this.restartPending = false;
    const diedFast = this.d.now() - this.sessionStartedAt < LIMITS5.voiceRestartWindowMs;
    if (diedFast && !this.heard) {
      this.emptyRestarts += 1;
      if (this.emptyRestarts >= LIMITS5.voiceRestartCap) return this.fail(STR5.voiceRestartFailed);
    } else this.emptyRestarts = 0;
    this.heard = "";
    this.startedAt = 0;
    this.listen();
  }

  /**
   * Something went wrong with a turn but the call itself is fine: tell the user on the same fault
   * line `fail()` uses, then start listening again rather than leaving a dead microphone.
   */
  private recover(message: string): void {
    this.awaitingReply = this.awaitingFirstLine = false;
    this.heard = "";
    this.startedAt = 0;
    this.sendingSince = 0;
    this.d.notify?.(message);
    this.listen();
  }

  private fail(message: string): void {
    this.speechGen += 1;
    this.d.cancelSpeech();
    this.clearSpeech();
    this.heard = "";
    this.startedAt = 0;
    this.restartPending = false;
    this.helperLive = false;
    this.state = "idle";
    this.d.notify?.(message);
  }

  private listen(): void {
    this.state = "listening";
    this.restartPending = false;
    this.startHelper();
  }

  private startHelper(): void {
    this.helperLive = true;
    this.sessionStartedAt = this.d.now();
    this.d.start();
  }

  private stopHelper(): void {
    this.helperLive = false;
    this.d.stop();
  }
}
