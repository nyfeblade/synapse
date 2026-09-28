import { generateCorpus, type BenchConfig } from "../corpus";
import { Rng } from "../rng";
import { tok } from "./params";

/**
 * Conversations for the token-cost replay. The words come from the seeded context-recall generator
 * (host/bench/corpus.ts, imported read-only): its user and assistant turns, its sessions and their
 * dates. This file adds what that generator does not model: clock times, tool calls and tool result
 * sizes, per workload profile. Every draw is seeded, so each policy replays the same conversation.
 */
export interface ToolCall {
  /** reply: a SendMessage (the ack or the answer); work: any other tool. */
  kind: "reply" | "work";
  name?: string;
  /** Output tokens of the tool_use block. */
  argTokens: number;
  /** Tokens of the tool_result that goes back into the context. */
  resultTokens: number;
  durationMs: number;
}
export interface Message {
  i: number; session: number; t: number;
  userTokens: number; userChars: number; memorable: boolean;
  tools: ToolCall[];
  /** Pre-drawn uniforms for policy-dependent events, so every policy sees the same draw. */
  recallDraw: number; archiveDraw: number;
}
export interface Conversation { profile: string; days: number; messages: Message[] }

export type Scale = "small" | "full";
export interface WorkloadSpec {
  name: string;
  days: Record<Scale, number>;
  sessions: Record<Scale, number>;
  /** Share of sessions that are tool-heavy work (the rest are casual chat). */
  toolShare: number;
  /** Tool calls per work message, including the ack and the answer (default 3–8, the brief's). */
  toolCalls?: [number, number];
  seed: number;
}
export const PROFILES = {
  /** A few short chats a day [inferred]. The generator's sessions are 5 user messages each. */
  casual: { name: "casual chat", days: { small: 10, full: 30 }, sessions: { small: 24, full: 72 }, toolShare: 0, seed: 1 },
  /** Errands and coding: 3–8 tool calls a message [brief]. */
  toolHeavy: { name: "tool-heavy work", days: { small: 10, full: 30 }, sessions: { small: 14, full: 40 }, toolShare: 1, seed: 2 },
  /** One Bot kept for months: mostly chat, some work [inferred mix]. */
  longLived: { name: "long-lived (90 d)", days: { small: 70, full: 90 }, sessions: { small: 36, full: 180 }, toolShare: 0.3, seed: 3 },
} satisfies Record<string, WorkloadSpec>;

/** Acknowledgements that carry nothing to remember; any other message is memorable if >40 chars or has "?" [assumed]. */
const TRIVIAL = ["ok", "thanks", "thank you", "ok thanks", "cool", "nice", "great", "perfect", "yes", "yep", "sure", "got it", "lol", "done", "good"];
const TRIVIAL_SET = new Set(TRIVIAL);
export function isMemorable(text: string): boolean {
  const t = text.trim();
  const bare = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
  if (TRIVIAL_SET.has(bare)) return false;
  return t.length > 40 || t.includes("?");
}
/** Share of casual user messages that are a bare acknowledgement [inferred]. */
const TRIVIAL_SHARE = 0.15;

/**
 * Tool result sizes in tokens, log-uniform in [lo, hi] [inferred from typical outputs]; a screenshot is
 * ~w·h/750 tokens, 1280×800 ≈ 1,365 [documented: Anthropic vision token formula].
 */
const WORK: { name: string; w: number; result: [number, number]; args: [number, number]; ms: [number, number] }[] = [
  { name: "Shell", w: 30, result: [20, 2_500], args: [30, 120], ms: [1_000, 20_000] },
  { name: "Read", w: 20, result: [300, 6_000], args: [20, 40], ms: [200, 1_000] },
  { name: "WebSearch", w: 15, result: [800, 2_500], args: [20, 40], ms: [1_000, 4_000] },
  { name: "WebFetch", w: 12, result: [1_500, 12_000], args: [20, 40], ms: [2_000, 8_000] },
  { name: "Screenshot", w: 8, result: [1_100, 1_600], args: [5, 10], ms: [1_000, 2_000] },
  { name: "Edit", w: 10, result: [20, 150], args: [150, 2_000], ms: [200, 500] },
  { name: "mcp", w: 5, result: [200, 4_000], args: [40, 150], ms: [1_000, 5_000] },
];
const WORK_WEIGHTS: Record<string, number> = Object.fromEntries(WORK.map((x) => [x.name, x.w]));
const logU = (r: Rng, [lo, hi]: [number, number]) => Math.round(Math.exp(Math.log(lo) + r.next() * (Math.log(hi) - Math.log(lo))));
/** SendMessage: the text plus ~25 tokens of JSON; its result is a short receipt [inferred]. */
const replyCall = (textTokens: number): ToolCall => ({ kind: "reply", name: "SendMessage", argTokens: textTokens + 25, resultTokens: 15, durationMs: 300 });

const DAY = 86_400_000, MIN = 60_000, MIN_SESSIONS = 80;
/**
 * The generator's assistant lines are terse (median 18 tokens). USG's 2-call chat turns output a
 * median ~90 tokens, i.e. a ~55-token reply after the SendMessage JSON and the closing call, so a
 * reply is the generator's text x3 [calibrated on USG]. A work call also carries a line of text or
 * thinking before its tool_use, 20–150 tokens log-uniform: USG's 3–4 call turns output ~350 [calibrated on USG].
 */
export const REPLY_SCALE = 3;
const NARRATION: [number, number] = [20, 150];

export function buildConversation(spec: WorkloadSpec, scale: Scale): Conversation {
  const days = spec.days[scale];
  // The generator plants facts years back, so it keeps its own 5-year span and ≥80 sessions; we take
  // its words in session order (an even stride when the workload is smaller) and lay the sessions
  // out on our own `days`-long clock.
  const cfg: BenchConfig = {
    seed: 20260921 + spec.seed, asOf: "2026-09-21", years: 5, sessions: Math.max(MIN_SESSIONS, spec.sessions[scale]), turnsPerSession: 10,
    compactEvery: 150, summaryMaxTokens: 1500, documents: 1, docPagesMax: 1, pageChars: 200, perKind: 1,
  };
  const corpus = generateCorpus(cfg);
  const r = new Rng(cfg.seed).fork(`cost:${spec.name}`);
  const bySession = new Map<number, typeof corpus.turns>();
  const want = spec.sessions[scale], stride = cfg.sessions / want;
  const keep = new Set(Array.from({ length: want }, (_, j) => Math.floor(j * stride)));
  for (const t of corpus.turns) if (keep.has(t.session)) bySession.set(t.session, [...(bySession.get(t.session) ?? []), t]);

  const messages: Message[] = [];
  let clock = 0;
  const start = Date.parse(`${cfg.asOf}T00:00:00Z`) - days * DAY;
  const sessions = [...bySession.entries()].sort((a, b) => a[0] - b[0]);
  for (const [j, [session, turns]] of sessions.entries()) {
    const work = r.chance(spec.toolShare);
    // Sessions spread evenly over the days, starting between 08:00 and 23:00 [inferred]; never before the previous one ended.
    const day = Math.floor(((j + r.next()) / sessions.length) * days);
    let t = Math.max(start + day * DAY + Math.round((8 + r.next() * 15) * 60) * MIN, clock + 30 * MIN);
    for (let k = 0; k + 1 < turns.length; k += 2) {
      const user = !work && r.chance(TRIVIAL_SHARE) ? r.pick(TRIVIAL) : turns[k]!.text;
      const replyTokens = REPLY_SCALE * tok(turns[k + 1]!.text.length);
      const tools: ToolCall[] = [];
      if (work) {
        const n = r.int(...(spec.toolCalls ?? [3, 8]));
        tools.push(replyCall(r.int(10, 30))); // the acknowledgement reply reminders push for
        for (let j = 0; j < n - 2; j++) {
          const name = r.weighted(WORK_WEIGHTS);
          const w = WORK.find((x) => x.name === name)!;
          tools.push({ kind: "work", name: w.name, argTokens: logU(r, NARRATION) + logU(r, w.args), resultTokens: logU(r, w.result), durationMs: logU(r, w.ms) });
        }
      }
      tools.push(replyCall(replyTokens));
      messages.push({
        i: messages.length, session, t, userTokens: Math.max(1, tok(user.length)), userChars: user.length, memorable: isMemorable(user),
        tools, recallDraw: r.next(), archiveDraw: r.next(),
      });
      // Next message: the work (tools + ~4 s a model call) plus the user's pause, 20 s–8 min log-uniform [inferred].
      const busy = tools.reduce((a, c) => a + c.durationMs + 4_000, 4_000);
      t += busy + logU(r, [20_000, 8 * MIN]);
    }
    clock = t;
  }
  return { profile: spec.name, days: Math.max(days, Math.ceil((clock - messages[0]!.t) / DAY)), messages };
}
