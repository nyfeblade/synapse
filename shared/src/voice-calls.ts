import type { VoiceCallView } from "./phase5";

type None = Record<string, never>;

/** A Bot calling the user: at most one ring per Bot, 30 s each, 3 placed an hour across all Bots. */
export const BOT_CALL_LIMITS = { ringMs: 30_000, perHour: 3, reasonMax: 300 } as const;

export interface IncomingCallView {
  callId: string;
  botId: string;
  /** What the Bot says it is calling about; spoken as the call's first line when the user picks up. */
  reason: string;
  since: number;
  expiresAt: number;
  /** The Bot has never been allowed to call: the ring asks whether it may (accepting allows it). */
  firstCall: boolean;
}
export interface BotCallsView { calls: IncomingCallView[] }
export type BotCallAnswer = "accept" | "decline" | "message" | "missed";

/** Screen sharing on a call: the shared frame is sent as an image attachment on the user's turn. */
export const LOOK_LIMITS = { maxEdge: 1280, jpegQuality: 70 } as const;

/**
 * Call-behaviour (plan item 4): what a user says over a talking Bot to make it stop. Over the Bot it is a silent yield:
 * the reply is cut on the partial, nothing is sent and nobody says "sorry, go ahead". "Stop the timer" is a request
 * (it doesn't match), and over a question the Bot just asked the words are an answer (the loop's guard).
 * Review round 1: pure stop words only ("stop", "shh", "enough"). "Cancel that", "forget it" and "never mind" are
 * always sent as a turn — the voice may need to cancel a task that is running (delegate a cancel), or just say okay.
 */
export const STOP_WORDS = /^(?:(?:ok(?:ay)?|no|oh|hey|please|just|alright|all right)[,\s]+)*(?:stop(?: it| talking| there)?|that'?s enough|enough|shh+|hush)(?:[,\s]+(?:please|thanks|thank you))?[.!?,\s]*$/i;

export type VoiceCallsSseEvent =
  | { channel: "bot-calls"; payload: BotCallsView }
  /** A Bot on a call asked to see the user's shared screen (SendMessage call: "look"). */
  | { channel: "call-look"; payload: { botId: string } }
  /** Call-behaviour (plan item 27): the Bot's voice chose to say nothing this turn ([quiet]); the call stops waiting. */
  | { channel: "call-quiet"; payload: { botId: string } }
  /** Bug 158: the host changed a live call's roster without the app asking (a Bot took another Bot off). */
  | { channel: "call-roster"; payload: VoiceCallView };

declare module "./gateway" {
  interface GatewayCommands {
    listBotCalls: { args: None; result: BotCallsView };
    /** allow: false = "Don't allow calls from <Bot>"; a first call that is accepted allows future ones. why: the app's reason for not ringing. */
    answerBotCall: { args: { callId: string; answer: BotCallAnswer; allow?: boolean; why?: string }; result: { botId: string; reason: string } };
    /** Settings → Voice: whether a Bot may call (null = ask on its first call). */
    setBotCallPermission: { args: { id: string; mayCall: boolean | null }; result: None };
    /** A Bot's pick-up greetings (authored once, cached; the stock set until then). userName: the Mac account's first name. */
    getCallGreetings: { args: { id: string; userName?: string }; result: CallGreetingsView };
    /**
     * Hang-up: a substantial call (at least 30 s, with a request in it) gets ONE short helper call that
     * returns the Bot's spoken one-line wrap-up and posts a compact summary with action items to the
     * chat. A trivial call returns { line: null } with no model call. Idempotent per call.
     */
    wrapUpCall: { args: { callId: string; durationMs?: number }; result: { line: string | null; botId?: string } };
    /** Bug 142: the helper's likely end of turn on a fast-path call: the Bot's voice starts its reply now, held back until the final confirms it. */
    voiceSpeculate: { args: { id: string; specId: string; text: string }; result: { started: boolean } };
    /** Bug 142: the user kept talking: the early reply is dropped (its tokens are counted and logged). */
    voiceSpeculateCancel: { args: { id: string; specId: string }; result: None };
    /** 5.8: a voice latency REGRESSION against the owner's own baseline — the last calls, or the nightly check (on) — or back to normal (off). */
    voiceLatencyNotice: { args: { on: boolean; kind?: "calls" | "selftest"; p50Ms?: number; baselineMs?: number; calls?: number }; result: None };
  }
}

// ---- calls that feel like calling teammates (bug-log 134) ----

export type TimeOfDay = "morning" | "afternoon" | "evening";
/** One way a Bot picks up. `when` absent = any time of day. */
export interface CallGreeting { text: string; when?: TimeOfDay }
/**
 * A Bot's pick-up greetings. `authored` = written once in the Bot's own personality (one short helper
 * call, cached per Bot, re-authored when its profile or the user's name changes); false = the stock set,
 * used until the authored one exists. `version` changes whenever the set does (the Mac's audio cache key).
 */
export interface CallGreetingsView { botId: string; greetings: CallGreeting[]; version: string; authored: boolean }
/** The compact summary a substantial call leaves in its chat. */
export interface CallSummary { summary: string; actions: string[]; durationMs: number }

/**
 * Bug 151: what makes a line a greeting and not a claim. A Bot picks up knowing nothing — it hasn't read
 * the chat, done any work or looked at anything — so a pick-up line that says it did ("Hi, I've drafted
 * three replies for you.") is false most times it plays. A greeting is a hello, optionally the user's
 * name, optionally the time of day, and at most a short open question. Returns why a line is NOT one, or
 * null when it passes. Used when a Bot's set is authored, when a cached set is loaded, and on the Mac
 * when the rendered audio of an older set is found.
 */
const GREETING_BANS: [RegExp, string][] = [
  [/\d/, "a count or number"],
  [/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rb|go|rs|java|sh|zsh|ya?ml|toml|html?|css|scss|sql|csv|tsv|txt|pdf|png|jpe?g|gif|svg|zip|tar|gz|docx?|xlsx?|pptx?|log|env)\b/i, "a file name"],
  [/(?:^|\s)(?:~|\.{1,2})?\/[\w.-]/, "a path"],
  [/\bI\s?[''‘’]\s?ve\b|\bI have\b|\bI'?m done\b/i, "\"I've\" / \"I have\""],
  [/\bhere\s?[''‘’]\s?s\b/i, "\"here's\""],
  [/\byour\s+[\p{L}''‘’-]+\s+(?:is|are|was|were|has|have|looks|needs|went|came)\b/iu, "a claim about the user's things"],
  [/\b(?:drafted|finished|sent|found|fixed|ran|wrote|written|updated|booked|replied|scheduled|completed|prepared|emailed|pushed|merged|deleted|saved|filed|organised|organized)\b/i, "a first-person work verb"],
  [/\b(?:AI|assistant|language model|LLM)\b/i, "mentions being an AI"],
  [/\p{Extended_Pictographic}/u, "an emoji"],
];

/**
 * Why `text` claims something a Bot picking up cannot know (a number, a file, work it says it did), or
 * null. Length is not judged here: the Mac uses this alone on lines it already rendered, where only the
 * claim matters.
 */
export function greetingClaimReason(text: unknown): string | null {
  if (typeof text !== "string") return "not text";
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t) return "empty";
  for (const [re, why] of GREETING_BANS) if (re.test(t)) return why;
  return null;
}

/** Why `text` is not a usable pick-up greeting, or null when it is one. */
export function greetingRejectReason(text: unknown): string | null {
  const claim = greetingClaimReason(text);
  if (claim) return claim;
  const t = (text as string).normalize("NFKC").replace(/\s+/g, " ").trim();
  if (t.length > CALL_FEEL.greetingMaxChars) return "too long to say in 2 seconds";
  if (t.split(" ").length > CALL_FEEL.greetingMaxWords) return "too many words";
  return null;
}

/** True when `text` is a plain, context-free greeting (see `greetingRejectReason`). */
export function isGenericGreeting(text: unknown): boolean {
  return greetingRejectReason(text) === null;
}

export const CALL_FEEL = {
  greetingsMin: 12,
  greetingsMax: 15,
  /** Fewer than this many greetings survive the checks = ask once more, then the built-in set (bug 151). */
  greetingsUsableMin: 8,
  /** About 2 s spoken: 7 words at most. */
  greetingMaxWords: 7,
  greetingMaxChars: 48,
  /** A greeting is never one of the last 3 used for that Bot. */
  greetingNoRepeat: 3,
  /** No first sentence this long after the end of the user's turn: a filler plays. */
  fillerAfterMs: 1_500,
  /** A turn still working this long after the user's turn ended, with nothing playing: "That'll take a minute…", once a turn. */
  longTaskAfterMs: 12_000,
  /** A raised hand is let go after this long. */
  handExpiresMs: 20_000,
  /** "Sorry, go ahead" at most this often, and only after a short or questioning barge-in. */
  sorryMinGapMs: 90_000,
  /** A call shorter than this, or with no request in it, gets no wrap-up (and no model call). */
  wrapUpMinMs: 30_000,
  /** How long hang-up waits for the one-line wrap-up before a stock goodbye is said instead. */
  wrapUpLineWaitMs: 4_000,
  wrapUpLineMaxChars: 160,
  summaryMaxChars: 400,
  actionsMax: 5,
  actionMaxChars: 120,
  /** Voicemail audio stays on the Mac this long. */
  voicemailKeepMs: 30 * 24 * 60 * 60_000,
  voicemailMaxChars: 400,
  /** Group calls on speakers: the widest seat's pan (−1 = left, 1 = right); the helper maps each seat's azimuth to it (bug 213). */
  spatialPan: 0.4,
} as const;

/** 5–11 morning, 12–17 afternoon, otherwise evening (late night reads as evening, never "morning" at 2 a.m.). */
export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/**
 * Bug 213: the half-width of the seat arc (degrees, 0 = straight ahead) by how many Bots are on the
 * call. Picked by ear for voices on headphones: 30° is a clear left/right for two without either
 * sounding "in one ear"; 40° leaves room for a centre seat between them; the arc grows to ±60° for 5–6,
 * so neighbours stay at least 24° apart (well past the few degrees where two talkers blur) while no one
 * sits hard to the side (past ~60° a voice starts to sound lop-sided on headphones). Speakers map the
 * same azimuths to the old gentle pan (see the helper), so the widest seat is still today's ±0.4.
 */
export const SEAT_ARC_DEG: readonly number[] = [0, 0, 30, 40, 50, 55, 60];

/** Bug 213: the seats of `n` Bots, left to right (degrees; negative = left), evenly spread over the arc. */
export function seatAzimuths(n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  const w = SEAT_ARC_DEG[Math.min(n, SEAT_ARC_DEG.length - 1)]!;
  return Array.from({ length: n }, (_, i) => Math.round((-w + (2 * w * i) / (n - 1)) * 10) / 10 + 0);
}

export interface CallSeats {
  /** Left to right: the order the avatars are drawn in, and the order their voices sit in. */
  order: string[];
  /** Each Bot's seat in degrees (negative = left). */
  azimuth: Record<string, number>;
}

/**
 * Bug 213: where each Bot on a call sits, so the picture matches the sound. Bots keep their
 * left-to-right order for the whole call; the arc widens as the call grows (1 centre, 2 at ±30°,
 * 3 at −40/0/+40…). A newcomer takes the place that moves the voices already there the least (the
 * third Bot sits between the first two, not off to one side), rightmost on a tie; someone leaving
 * closes the gap. A call that starts with several Bots seats them in roster order.
 */
export function callSeats(ids: string[], previousOrder: string[] = []): CallSeats {
  const order = previousOrder.filter((id, i) => ids.includes(id) && previousOrder.indexOf(id) === i);
  if (order.length === 0) order.push(...ids.filter((id, i) => ids.indexOf(id) === i));
  for (const id of ids) {
    if (order.includes(id)) continue;
    if (order.length === 0) { order.push(id); continue; }
    const before = seatAzimuths(order.length), after = seatAzimuths(order.length + 1);
    let best = order.length, bestCost = Infinity;
    for (let at = 0; at <= order.length; at++) {
      let cost = 0;
      for (let j = 0; j < order.length; j++) cost += (after[j < at ? j : j + 1]! - before[j]!) ** 2;
      if (cost <= bestCost + 1e-9) { best = at; bestCost = Math.min(cost, bestCost); }
    }
    order.splice(best, 0, id);
  }
  const az = seatAzimuths(order.length);
  return { order, azimuth: Object.fromEntries(order.map((id, i) => [id, az[i]!])) };
}
