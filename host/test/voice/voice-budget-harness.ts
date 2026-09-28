import { vi } from "vitest";
import { STRV } from "@synapse/shared";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import fixture from "./fixtures/voice-budget.json";
import { VoiceLoop, type PhraseKind } from "../../../app/src/renderer/voice/voice-loop";
import { phraseBags } from "../../../app/src/renderer/voice/call-phrases";
import { VoiceFronts } from "../../voice/front";
import { ScriptedFrontSession } from "../../voice/front-session";

/**
 * The voice latency budget harness (speed plan §4, test-reports/voice-smooth). A 1:1 fast-path call on a FAKE
 * clock, end to end through the real parts:
 *
 * - the real VoiceLoop (and its real SentenceChunker);
 * - the real host VoiceFronts coordinator (speculate / userPost / cancel), with a ScriptedFrontSession that
 *   answers after the time to first text the user's own calls saw (voice.log) and streams the real Sonnet 5
 *   replies word by word;
 * - the real helper's recorded turn taking (36 utterances: speech start, likely end, end of turn, final);
 * - a fake speech engine with the length model fitted to voice.log (first chunk 70 ms + 5 ms a character, one
 *   line rendered at a time, one FIFO player, cached lines out in 5 ms, an 80 ms fade on a cut).
 *
 * No model, no network, no audio. Everything it reports is "ms after the user's speech ended".
 */

type Utt = (typeof fixture.utterances)[number];
const M = fixture.model;

export interface Line { text: string; phrase?: PhraseKind; queuedAt: number; audioStart: number | null; audioEnd: number | null; cutAt: number | null; pauseMs: number; turn: number }
export interface Turn {
  id: string;
  /** Absolute times. */
  speechEnd: number;
  /** ms after the end of speech (null: nothing played). */
  firstAudio: number | null;
  answerAudio: number | null;
  /** ms from the answer's first line being handed to speech to its audio. */
  answerQueuedToAudio: number | null;
  phrases: PhraseKind[];
  /** Lines of the Bot's answer audible while the user was still talking. */
  overUser: number;
  /** The call's own sounds (the end-of-turn "mm", a filler) audible while the user was still talking. */
  phraseOverUser: number;
  /** The helper closed the turn mid-thought (a recorded cut-in: the user went on after a pause). */
  cutIn: boolean;
  /** The helper's (last) final, ms after the end of speech: the earliest anything can answer. */
  finalAfterSpeechMs: number;
  /** The host said, answering the send, that the reply it held already had words (bug 218: no sound then). */
  hostReady: boolean;
  speculations: number;
  speculationCancels: number;
  /** Front-session model runs started for this turn (the token cost proxy). */
  frontRuns: number;
  /** Call behaviour: user turns the loop sent to the host (a cut-in turn sent as two is 2). */
  sends: number;
  /** Replies of the voice with at least one line heard (answering a fragment and then the whole: 2). */
  repliesHeard: number;
  /** Lines of an answer that started before the user's last final (the Bot answered a half-finished thought). */
  answerBeforeLastFinal: number;
  /** Characters of answer the user heard this turn. */
  spokenChars: number;
  /** The answer to only part of what the user said was heard (a cut-in turn answered as a fragment). */
  fragmentHeard: boolean;
}

export interface Options {
  /** Extra VoiceLoop deps (the fixes add some). */
  loop?: Partial<ConstructorParameters<typeof VoiceLoop>[0]>;
  /** Per-kind phrase texts (bags cycle in order, so a run is deterministic). */
  phrases?: Partial<Record<string, string[]>>;
  /** Utterances to run (default: all 36), and how many rounds over them. */
  only?: (u: Utt) => boolean;
  rounds?: number;
  /**
   * "whisper": the final is written the way Whisper writes it in Full mode (bug 220) — digits for number words,
   * "what is" for "what's", a capital and a full stop — while the partials (and so the speculative start) stay Apple's.
   */
  finalAs?: "whisper";
  /** false: the Bot never makes the end-of-turn sound (bug 218), to measure without it. */
  acks?: boolean;
  /** Override the time to first text (ms, as the host's voice sees it) for turn i. */
  firstTextMs?: (i: number) => number;
  /** Which end-of-turn sounds are rendered in the Bot's voice (default: all — they are stock lines, pre-rendered). */
  ackRendered?: (text: string) => boolean;
  /** Extra output latency on every line (a Bluetooth route: ~150-250 ms between the player and the ear). */
  outputLatencyMs?: number;
  /** Override what the voice says on turn i (default: the 12 real Sonnet 5 replies, in turn). */
  replyText?: (i: number) => string;
}

export async function runCall(o: Options = {}): Promise<{ turns: Turn[]; lines: Line[]; tokens: number; canceledTokens: number; kept: number; sessions: ScriptedFrontSession[] }> {
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  try {
    return await run(o);
  } finally {
    vi.useRealTimers();
  }
}

async function run(o: Options) {
  const now = () => Date.now();
  // ---------------- the fake speech engine ----------------
  const lines: Line[] = [];
  let synthFreeAt = 0;
  let playEnd = 0;
  const live = new Map<Line, { timers: ReturnType<typeof setTimeout>[]; resolve: () => void }>();
  let loop: VoiceLoop;
  const speak = (text: string, s?: { phrase?: PhraseKind; pauseMs?: number }) => new Promise<void>((resolve) => {
    const t = now();
    const line: Line = { text, phrase: s?.phrase, queuedAt: t, audioStart: null, audioEnd: null, cutAt: null, pauseMs: s?.pauseMs ?? 0, turn: turnIndex };
    lines.push(line);
    const chars = text.length;
    let firstChunk: number;
    if (s?.phrase) firstChunk = t + M.tts.cachedFirstAudioMs; // the call's own lines are pre-rendered
    else {
      const start = Math.max(t, synthFreeAt);
      firstChunk = start + M.tts.firstChunkBaseMs + M.tts.firstChunkPerCharMs * chars;
      synthFreeAt = Math.max(firstChunk, start + chars * 5);
    }
    const audioStart = Math.max(firstChunk, playEnd) + (playEnd <= t ? o.outputLatencyMs ?? 0 : 0);
    const audioEnd = audioStart + chars * M.tts.playMsPerChar;
    playEnd = audioEnd + (s?.pauseMs ?? 0);
    const end = playEnd;
    const timers = [
      setTimeout(() => { line.audioStart = audioStart; loop.onAudioOut(); }, audioStart - t),
      setTimeout(() => { line.audioEnd = audioEnd; }, audioEnd - t),
      setTimeout(() => { live.delete(line); resolve(); }, end - t),
    ];
    live.set(line, { timers, resolve });
  });
  const cancelSpeech = () => {
    const t = now();
    for (const [line, l] of live) {
      for (const x of l.timers) clearTimeout(x);
      if (line.audioStart !== null && line.audioEnd === null) { line.cutAt = t; line.audioEnd = t + M.tts.fadeMs; }
      l.resolve();
    }
    live.clear();
    playEnd = t; // a new line ends the fade and plays at once (bug 188)
    synthFreeAt = t; // "cancel all" on the sidecar
  };

  // ---------------- the host: the real coordinator, a scripted voice ----------------
  const bot = { id: "nova", profile: { name: "Nova", title: "Chief of Staff", description: "Warm, quick.", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const sessions: ScriptedFrontSession[] = [];
  const replies: { turn: number; text: string }[] = [];
  let sends = 0;
  let lastWord = "";
  let reply = { text: "", firstTextMs: 500 };
  let turnNo = 0;
  const fronts = new VoiceFronts({
    bots: {
      has: (id) => id === "nova", summary: () => bot,
      appendEntry: (_id, e) => {
        if (e.kind === "send-message" && e.message.type === "text") { const text = e.message.content; replies.push({ turn: turnIndex, text }); setTimeout(() => loop.onBotText(text, "nova", e.id), M.hostToAppMs); }
      },
      publishTyping: (_id, typing, p) => { setTimeout(() => loop.onBotStream("nova", typing ? p : null), M.hostToAppMs); },
      tail: () => [] as TranscriptEntry[], nextTurnNo: () => ++turnNo,
    },
    runner: { recordVoiceUtterance: () => ({ entryId: `u${turnNo}` }), enqueueWake: () => "w" },
    gate: null,
    calls: { roster: () => ["nova"] },
    factory: (spec) => {
      // A reply to only part of the utterance (a recorded cut-in: the user went on after a pause) is the same reply in
      // capitals — the same length and sentences, so the same timings — so the call can tell every line of an answer
      // to a fragment from the answer to the whole thought.
      const s = new ScriptedFrontSession(spec, (m) => {
        const said = /(?:^|\n)User: (.*)$/s.exec(m)?.[1] ?? "";
        const whole = !lastWord || said.toLowerCase().replace(/[.,!?]/g, "").includes(lastWord);
        return { text: whole ? reply.text : reply.text.toUpperCase(), firstTextMs: reply.firstTextMs };
      }, { chunkMs: M.wordMs });
      sessions.push(s);
      return s;
    },
    enabled: () => true,
    now,
  });
  fronts.callChanged("nova");

  // ---------------- the app: the real loop ----------------
  const bags = new Map<string, number>();
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; // deterministic shuffle
  const ackBags = phraseBags({ ready: (_who, t) => (o.ackRendered ? o.ackRendered(t) : true), rand });
  const phraseTexts: Record<string, string[]> = { filler: STRV.fillers, sorry: STRV.sorryLines, "long-task": STRV.longTaskLines, ...o.phrases } as unknown as Record<string, string[]>;
  let specId: string | null = null;
  let specSeq = 0;
  let hostReady = false;
  let turnIndex = -1;
  const marks: { what: string; at: number }[] = [];
  loop = new VoiceLoop({
    start: () => {}, stop: () => {},
    send: (text, _d, extra) => {
      sends += 1;
      const id = extra?.speculated ? specId : null;
      specId = null;
      // The gateway call: the host takes it after appToHostMs, and its answer is back hostToAppMs later.
      return new Promise((resolve) => setTimeout(() => {
        const r = fronts.userPost("nova", text, `n${now()}`, { ...(id ? { speculationId: id } : {}), ...(extra?.continues ? { continues: true } : {}) });
        if (r.ready) hostReady = true;
        setTimeout(() => resolve(r), M.hostToAppMs);
      }, M.appToHostMs));
    },
    speculate: (text) => { const id = `s${++specSeq}`; specId = id; setTimeout(() => fronts.speculate("nova", id, text), M.appToHostMs); },
    cancelSpeculation: () => { const id = specId; specId = null; if (id) setTimeout(() => fronts.cancelSpeculation("nova", id), M.appToHostMs); },
    speak: (text, s) => speak(text, s),
    cancelSpeech,
    now, silenceMs: 700, helperEndpoints: true,
    phrase: (kind, who, mood) => {
      if (kind === "ack" && o.acks === false) return null;
      // Review 1: the app's own bags, gated by what is rendered in the Bot's voice (the call's `voice.phrases.has`).
      if (kind === "ack") return ackBags.next("ack", who, mood);
      const list = phraseTexts[kind] ?? [];
      const k = `${kind}:${mood ?? ""}:${who}`;
      const i = bags.get(k) ?? 0;
      bags.set(k, i + 1);
      return list.length ? list[i % list.length]! : null;
    },
    members: () => [{ id: "nova", name: "Nova" }],
    mark: (what) => marks.push({ what, at: now() }),
    after: (ms, fn) => { setTimeout(fn, ms); },
    ...o.loop,
  });
  const tick = setInterval(() => loop.tick(), 200);
  loop.begin();

  // ---------------- the user ----------------
  const utts = fixture.utterances.filter(o.only ?? (() => true));
  const rounds = o.rounds ?? 3;
  const turns: Turn[] = [];
  let i = 0;
  let t0 = 1_000;
  for (let r = 0; r < rounds; r++) {
    for (const u of utts) {
      const sample = fixture.realFirstTextMs[i % fixture.realFirstTextMs.length]!;
      const v = fixture.voice[i % fixture.voice.length]!;
      reply = { text: o.replyText ? o.replyText(i) : v.text, firstTextMs: o.firstTextMs ? o.firstTextMs(i) : Math.max(250, sample - M.appToHostMs - M.hostToAppMs) };
      i++;
      await vi.advanceTimersByTimeAsync(Math.max(0, t0 - now()));
      const base = now();
      hostReady = false;
      turnIndex += 1;
      const runsBefore = sessions.reduce((n, s) => n + s.messages.length, 0);
      const sendsBefore = sends;
      lastWord = u.words.at(-1)!.w.toLowerCase().replace(/[.,!?]/g, "");
      const linesBefore = lines.length;
      const marksBefore = marks.length;
      scheduleUtterance(loop, u, base, o.finalAs === "whisper" ? whisperStyle : undefined);
      const speechEnd = base + u.speechEndMs;
      // Let it play out: the reply spoken to the end and the loop listening again.
      await vi.advanceTimersByTimeAsync(Math.max(...u.events.map((e) => e.t)) + 200);
      for (let k = 0; k < 120 && (live.size > 0 || loop.state !== "listening"); k++) await vi.advanceTimersByTimeAsync(250);
      const mine = lines.slice(linesBefore);
      const heard = mine.filter((l) => l.audioStart !== null && l.audioStart >= speechEnd - 50);
      // The answer to what the user said (a cut-in turn: to the whole thought, not the fragment's reply).
      const answer = heard.find((l) => !l.phrase && !isFragmentLine(l));
      const firstAudio = heard.length ? Math.min(...heard.map((l) => l.audioStart!)) - speechEnd : null;
      const m = marks.slice(marksBefore);
      // The user's own speech: from each word's start (≈ the previous word's end) to its end.
      const talking = u.words.map((w, k) => [base + (k ? u.words[k - 1]!.endAt : w.endAt - 250), base + w.endAt] as const).filter(([a, b]) => b - a < 1_500);
      const over = mine.filter((l) => l.audioStart !== null && talking.some(([a, b]) => l.audioStart! < b && (l.audioEnd ?? Infinity) > a));
      const overUser = over.filter((l) => !l.phrase).length;
      turns.push({
        id: u.id, speechEnd,
        firstAudio, answerAudio: answer ? answer.audioStart! - speechEnd : null,
        answerQueuedToAudio: answer ? answer.audioStart! - answer.queuedAt : null,
        phrases: mine.filter((l) => l.phrase && l.audioStart !== null).map((l) => l.phrase!),
        overUser, phraseOverUser: over.length - overUser, cutIn: u.cutIns > 0, hostReady,
        finalAfterSpeechMs: Math.max(...u.events.filter((e) => e.type === "final").map((e) => e.t)) - u.speechEndMs,
        speculations: m.filter((x) => x.what === "speculate").length,
        speculationCancels: m.filter((x) => x.what === "speculate-cancel").length,
        frontRuns: sessions.reduce((n, s) => n + s.messages.length, 0) - runsBefore,
        sends: sends - sendsBefore,
        repliesHeard: replies.filter((x) => x.turn === turnIndex && mine.some((l) => !l.phrase && l.audioStart !== null && x.text.includes(l.text))).length,
        fragmentHeard: mine.some((l) => !l.phrase && l.audioStart !== null && isFragmentLine(l)),
        answerBeforeLastFinal: mine.filter((l) => !l.phrase && l.audioStart !== null && l.audioStart < base + Math.max(...u.events.filter((e) => e.type === "final").map((e) => e.t))).length,
        spokenChars: mine.filter((l) => !l.phrase && l.audioStart !== null).reduce((n, l) => n + l.text.length, 0),
      });
      t0 = now() + 1_500;
    }
  }
  clearInterval(tick);
  loop.end();
  fronts.callEnded("nova");
  const st = fronts.lastStats.get("nova")!;
  return { turns, lines, tokens: st.tokens, canceledTokens: st.canceledTokens, kept: st.speculationsCommitted, sessions };
}

/** A line of the scripted voice's reply to a fragment (the harness writes those in capitals). */
function isFragmentLine(l: Line): boolean {
  return /[A-Z].*[A-Z].*[A-Z]/.test(l.text) && l.text === l.text.toUpperCase();
}

/** The helper's side of one utterance: speech start, Apple's partials (trailing the words), likely end, final. */
function scheduleUtterance(loop: VoiceLoop, u: Utt, base: number, finalAs?: (t: string) => string) {
  const byU = new Map<number, { start: number; final: number }>();
  for (const e of u.events) {
    const x = byU.get(e.u) ?? { start: Infinity, final: Infinity };
    if (e.type === "start") x.start = Math.min(x.start, e.t);
    if (e.type === "final") x.final = Math.min(x.final, e.t);
    byU.set(e.u, x);
  }
  // Each helper utterance owns the words spoken between its start and its final.
  const owner = (endAt: number) => { for (const [k, x] of [...byU].sort((a, b) => a[0] - b[0])) if (endAt <= x.final) return k; return [...byU.keys()].at(-1)!; };
  const words = u.words.map((w) => ({ ...w, u: owner(w.endAt) }));
  const textAt = (uid: number, t: number) => words.filter((w) => w.u === uid && Math.min(w.endAt + M.partialLagMs, byU.get(uid)!.final - 5) <= t).map((w) => w.w).join(" ");
  const at = (t: number, fn: () => void) => setTimeout(fn, Math.max(0, base + t - Date.now()));
  for (const [uid, x] of byU) {
    at(x.start, () => loop.onSpeechStart());
    const own = words.filter((w) => w.u === uid);
    own.forEach((w, k) => at(Math.min(w.endAt + M.partialLagMs, x.final - 5), () => loop.onPartial(own.slice(0, k + 1).map((y) => y.w).join(" "))));
  }
  for (const e of u.events) {
    if (e.type === "likely") at(e.t, () => { const t = textAt(e.u, e.t); if (t) loop.onLikelyEnd(t); });
    if (e.type === "final") at(e.t, () => { const t = words.filter((w) => w.u === e.u).map((w) => w.w).join(" "); loop.onFinal(finalAs ? finalAs(t) : t); });
  }
}

const NUM: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twenty: "20" };
/** Whisper's way of writing the same words (fixture: the 18 utterances' number words, contractions and punctuation). */
export function whisperStyle(t: string): string {
  const w = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/gi, (m) => NUM[m.toLowerCase()]!).replace(/\bwhat's\b/gi, "what is").replace(/\bhow's\b/gi, "how is");
  const c = w.charAt(0).toUpperCase() + w.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/**
 * Silence inside a reply beyond the pause its line asked for: the next sentence wasn't ready when the one before
 * had finished (inventory #6, "chops between sentences").
 */
export function joins(lines: Line[]): { joins: number; joinGapsOver150: number; joinGapP90: number | null } {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!, b = lines[i]!;
    if (a.phrase || b.phrase || a.turn !== b.turn || a.cutAt !== null || a.audioEnd === null || b.audioStart === null) continue;
    gaps.push(Math.max(0, b.audioStart - (a.audioEnd + a.pauseMs)));
  }
  return { joins: gaps.length, joinGapsOver150: gaps.filter((g) => g > 150).length, joinGapP90: pct(gaps, 0.9) };
}

/** p50 / p90 the way analyze-log.mjs takes them. */
export function pct(xs: (number | null)[], p: number): number | null {
  const s = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null;
}

export function summary(r: Awaited<ReturnType<typeof runCall>>) {
  const t = r.turns;
  return {
    turns: t.length,
    answerP50: pct(t.map((x) => x.answerAudio), 0.5), answerP90: pct(t.map((x) => x.answerAudio), 0.9),
    anyP50: pct(t.map((x) => x.firstAudio), 0.5), anyP90: pct(t.map((x) => x.firstAudio), 0.9),
    fillerRate: t.filter((x) => x.phrases.includes("filler")).length / t.length,
    ackRate: t.filter((x) => x.phrases.includes("ack")).length / t.length,
    phraseRate: t.filter((x) => x.phrases.length > 0).length / t.length,
    overUser: t.reduce((n, x) => n + x.overUser, 0),
    phraseOverUser: t.reduce((n, x) => n + x.phraseOverUser, 0),
    speculations: t.reduce((n, x) => n + x.speculations, 0), cancels: t.reduce((n, x) => n + x.speculationCancels, 0), kept: r.kept,
    frontRunsPerTurn: t.reduce((n, x) => n + x.frontRuns, 0) / t.length,
    // Call behaviour: answering a half-finished thought, answering twice, and how much is said.
    doubleSends: t.filter((x) => x.sends > 1).length,
    fragmentAnswered: t.filter((x) => x.answerBeforeLastFinal > 0).length,
    answeredTwice: t.filter((x) => x.fragmentHeard && x.repliesHeard > 1).length,
    fragmentHeard: t.filter((x) => x.fragmentHeard).length,
    // The same figures without the 18 recorded cut-ins (on those, "first audio" before this branch was often the Bot
    // answering the fragment while the user was still talking — the clunk itself, not speed).
    anyP50Whole: pct(t.filter((x) => !x.cutIn).map((x) => x.firstAudio), 0.5), anyP90Whole: pct(t.filter((x) => !x.cutIn).map((x) => x.firstAudio), 0.9),
    answerP50Whole: pct(t.filter((x) => !x.cutIn).map((x) => x.answerAudio), 0.5), answerP90Whole: pct(t.filter((x) => !x.cutIn).map((x) => x.answerAudio), 0.9),
    answerP50CutIn: pct(t.filter((x) => x.cutIn).map((x) => x.answerAudio), 0.5), answerMaxCutIn: Math.max(...t.filter((x) => x.cutIn).map((x) => x.answerAudio ?? 0)),
    spokenCharsP50: pct(t.map((x) => x.spokenChars), 0.5), spokenCharsP90: pct(t.map((x) => x.spokenChars), 0.9),
    sorryRate: t.filter((x) => x.phrases.includes("sorry")).length / t.length,
    tokens: r.tokens, canceledTokens: r.canceledTokens,
    // (No tokens figure: the scripted voice's counts are estimates from text length, not the model's.)
    ...joins(r.lines),
  };
}
