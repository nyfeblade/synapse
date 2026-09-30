import { createHash } from "node:crypto";
import type { TurnEvent, WakeSource } from "../brain/types";
import { SEND_TOOL } from "../brain/tool-policy";
import { stepTarget } from "../presence/activity";

/**
 * 5.7 "stop on repeated failure": the thresholds. Enforced here, in the runner, for every brain (Claude or any
 * provider that emits TurnEvents); nothing about it lives in a prompt.
 */
export const LOOP_LIMITS = {
  /** The same tool failing the same way this many times in a row, with no change in between, stops the Bot. */
  sameErrorMax: 4,
  /** ...unless every retry waited first (a sleep, or a gap that grew by backoffGrowth): a backoff gets this many. */
  backoffErrorMax: 8,
  /** The identical call returning the identical result this many times, with no change and no wait in between. */
  sameCallMax: 5,
  /** Identical results with a wait before each (polling a long job): only this many is a loop. */
  pollMax: 60,
  /** This many automatic turns in a row that did work and failed, or repeated the turn before exactly. */
  noProgressTurnsMax: 3,
  /** A gap this long between two identical calls counts as a wait (polling without a sleep call). */
  waitGapMs: 20_000,
  /** A retry whose gap is at least this times the last one's is backing off. */
  backoffGrowth: 1.5,
  /** ...and is at least this long (tries back to back are never a backoff). */
  backoffMinGapMs: 1_000,
} as const;

export type LoopKind = "same-error" | "same-call" | "no-progress";
export interface LoopTrip {
  kind: LoopKind;
  /** What it kept failing at, short ("npm install"). */
  step: string;
  tries: number;
  /** API dollars the loop cost: from its first try to the trip (this turn's live meter, or the turns' recorded costs). */
  spentUsd: number;
}

/** Tools whose results show the Bot something but change nothing: a new one isn't progress, a repeat still counts. */
const READ_ONLY = new Set([
  "Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite", "ToolSearch", "NotebookRead",
  "mcp__bot__Screenshot", "mcp__bot__ReadState", "mcp__bot__ListAgents",
]);
/** Scheduled sources repeat by design; only their failures count toward no-progress turns. */
const SCHEDULED = new Set<WakeSource>(["routine", "heartbeat", "maintenance"]);
/** Refusals the runner itself made (a steering hold, this guard's own hold) are not the Bot failing. */
const OWN_REFUSALS = [/^Not run: the user just sent you a message/, /^Not run: Synapse paused this Bot/];
export const LOOP_HELD = "Not run: Synapse paused this Bot because the same step kept failing. Wait for the user.";

const WAIT_TOOL = /(^|__)(sleep|wait|await\w*|monitor|poll)$/i;
const SLEEPS = /\b(sleep|timeout|wait)\s+\d|\bwatch\s|--watch\b|\buntil\b.*\bdo\b/;

const hash = (s: string) => createHash("sha1").update(s).digest("base64url").slice(0, 16);
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "";
};
const commandOf = (input: Record<string, unknown>) => (typeof input.command === "string" ? input.command : "");

/** "Similar" errors: numbers, ids, hex, quoted values and whitespace don't make two failures different. */
export function errorSignature(output: string): string {
  return output
    .slice(0, 600)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/(["'`]).*?\1/g, "'…'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isWaitCall(name: string, input: Record<string, unknown>): boolean {
  if (WAIT_TOOL.test(name)) return true;
  return /^sleep\s+\d+(\.\d+)?[smh]?\s*$/.test(commandOf(input).trim());
}

interface Streak { count: number; firstUsd: number; lastAt: number; lastGap: number | null; backoff: boolean; step: string }
interface TurnState {
  source: WakeSource;
  usd: number;
  calls: Map<string, { name: string; input: Record<string, unknown>; at: number }>;
  errors: Map<string, Streak>;
  repeats: Map<string, Streak>;
  seen: Set<string>;
  lastWaitAt: number;
  progressed: boolean;
  toolOk: number;
  toolErr: number;
  failedStep: string | null;
  prints: string[];
}
interface BotState { turn: TurnState | null; lastPrint: string | null; dull: number; dullUsd: number; dullStep: string | null }

/**
 * Detects a Bot stuck in a loop from its turn events, brain-agnostic:
 *  - the same tool erroring the same (or a similar) way N times in a row;
 *  - the same call returning the same result N times with nothing changed in between;
 *  - automatic turns in a row that did work and failed, or repeated the previous turn exactly.
 * A backoff (each retry waited longer, or slept) and polling (a wait before each identical check) get far higher
 * limits, and any new result from a tool that changes something (an edit, a new command's output) is progress and
 * clears the counts, so a test re-run after an edit never trips it.
 */
export class LoopGuard {
  private bots = new Map<string, BotState>();
  constructor(private now: () => number = Date.now) {}

  private bot(botId: string): BotState {
    let b = this.bots.get(botId);
    if (!b) { b = { turn: null, lastPrint: null, dull: 0, dullUsd: 0, dullStep: null }; this.bots.set(botId, b); }
    return b;
  }

  turnStart(botId: string, source: WakeSource): void {
    const b = this.bot(botId);
    // The user's own message is the user watching: turns before it don't count toward a no-progress run.
    if (source === "user") { b.dull = 0; b.dullUsd = 0; b.lastPrint = null; }
    b.turn = {
      source, usd: 0, calls: new Map(), errors: new Map(), repeats: new Map(), seen: new Set(), lastWaitAt: 0,
      progressed: false, toolOk: 0, toolErr: 0, failedStep: null, prints: [],
    };
  }

  /** The running turn's live spend so far (from the brain's `spend` events), or 0. */
  turnUsd(botId: string): number {
    return this.bots.get(botId)?.turn?.usd ?? 0;
  }

  event(botId: string, e: TurnEvent): LoopTrip | null {
    const t = this.bots.get(botId)?.turn;
    if (!t) return null;
    const at = this.now();
    if (e.kind === "spend") { if (Number.isFinite(e.turnUsd) && e.turnUsd > t.usd) t.usd = e.turnUsd; return null; }
    if (e.kind === "tool_start") { t.calls.set(e.toolUseId, { name: e.name, input: e.input, at }); return null; }
    if (e.kind !== "tool_end" || e.name === SEND_TOOL) return null;
    const call = t.calls.get(e.toolUseId);
    t.calls.delete(e.toolUseId);
    const name = call?.name ?? e.name;
    const input = call?.input ?? {};
    if (e.isError && OWN_REFUSALS.some((r) => r.test(e.output))) return null;
    if (isWaitCall(name, input)) { if (!e.isError) t.lastWaitAt = at; return null; }
    const sig = `${name}|${hash(stable(input))}`;
    const step = stepTarget(name, input).replace(/\s+/g, " ").trim().slice(0, 60) || name;
    const waited = (s: Streak) => t.lastWaitAt > s.lastAt || SLEEPS.test(commandOf(input)) || at - s.lastAt >= LOOP_LIMITS.waitGapMs;
    if (e.isError) {
      t.toolErr += 1;
      t.failedStep = step;
      const key = `${name}|${errorSignature(e.output)}`;
      t.prints.push(`E:${key}`);
      const s = t.errors.get(key);
      if (!s) { t.errors.set(key, { count: 1, firstUsd: t.usd, lastAt: at, lastGap: null, backoff: true, step }); return null; }
      const gap = at - s.lastAt;
      // A first retry can't show a backoff yet; every later one must have waited, or waited longer than the last.
      s.backoff &&= waited(s) || s.lastGap === null || gap >= Math.max(LOOP_LIMITS.backoffMinGapMs, s.lastGap * LOOP_LIMITS.backoffGrowth);
      s.lastGap = gap;
      s.lastAt = at;
      s.count += 1;
      s.step = step;
      return s.count >= (s.backoff ? LOOP_LIMITS.backoffErrorMax : LOOP_LIMITS.sameErrorMax) ? this.trip(t, "same-error", s) : null;
    }
    t.toolOk += 1;
    const key = `${sig}|${hash(e.output.slice(0, 4000))}`;
    t.prints.push(`R:${key}`);
    if (!t.seen.has(key)) {
      t.seen.add(key);
      if (!READ_ONLY.has(name)) { t.progressed = true; t.errors.clear(); t.repeats.clear(); }
      t.repeats.set(key, { count: 1, firstUsd: t.usd, lastAt: at, lastGap: null, backoff: true, step });
      return null;
    }
    const s = t.repeats.get(key);
    if (!s) { t.repeats.set(key, { count: 1, firstUsd: t.usd, lastAt: at, lastGap: null, backoff: true, step }); return null; }
    s.backoff &&= waited(s);
    s.lastAt = at;
    s.count += 1;
    return s.count >= (s.backoff ? LOOP_LIMITS.pollMax : LOOP_LIMITS.sameCallMax) ? this.trip(t, "same-call", s) : null;
  }

  /**
   * The turn ended. `costUsd` is what the turn recorded (usage.db), when known. A run of automatic turns that did work
   * and failed, or did exactly what the turn before did, trips it.
   */
  turnEnd(botId: string, r: { error: boolean; aborted: boolean; toolCalls: number; sentTexts: string[]; costUsd?: number }): LoopTrip | null {
    const b = this.bots.get(botId);
    const t = b?.turn;
    if (!b || !t) return null;
    b.turn = null;
    if (t.source === "user" || r.aborted) return null;
    const usd = Math.max(t.usd, r.costUsd ?? 0);
    const worked = r.toolCalls > 0 || usd > 0;
    const failed = worked && (r.error || (t.toolErr > 0 && t.toolOk === 0));
    const print = worked ? [...t.prints.sort(), ...r.sentTexts.map((s) => `S:${hash(s)}`)].join(",") : "";
    const repeated = !SCHEDULED.has(t.source) && print !== "" && print === b.lastPrint;
    b.lastPrint = print || b.lastPrint;
    if (!failed && !repeated) { b.dull = 0; b.dullUsd = 0; b.dullStep = null; return null; }
    b.dull += 1;
    b.dullUsd += usd;
    b.dullStep = t.failedStep ?? b.dullStep;
    if (b.dull < LOOP_LIMITS.noProgressTurnsMax) return null;
    const trip: LoopTrip = { kind: "no-progress", step: b.dullStep ?? "its task", tries: b.dull, spentUsd: round(b.dullUsd) };
    b.dull = 0; b.dullUsd = 0; b.dullStep = null; b.lastPrint = null;
    return trip;
  }

  /** Continue, Stop, or a new message from the user: every count starts over. */
  reset(botId: string): void {
    const b = this.bots.get(botId);
    if (!b) return;
    b.dull = 0; b.dullUsd = 0; b.dullStep = null; b.lastPrint = null;
    if (b.turn) { b.turn.errors.clear(); b.turn.repeats.clear(); }
  }

  forget(botId: string): void {
    this.bots.delete(botId);
  }

  private trip(t: TurnState, kind: LoopKind, s: Streak): LoopTrip {
    t.errors.clear();
    t.repeats.clear();
    return { kind, step: s.step, tries: s.count, spentUsd: round(Math.max(0, t.usd - s.firstUsd)) };
  }
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;
