import { isAgentMessage, type SseEvent, type TranscriptEntry } from "@synapse/shared";
import { REMEMBER_MS, STUCK_MS, toolAct, type Transient } from "./living-pose";
import { livingHandoff, livingReading } from "./living-bus";

// Living Bots (bug 226): the few moments the avatars react to that are not in a BotSummary, read from
// the SSE stream the app already receives — no new host events, zero tokens:
//  - a tool call that ended in error → the Bot looks stuck for a moment;
//  - the memory tool running → the Bot remembers (the dots settle);
//  - one Bot messaging or delegating to another → the hand-off orb;
//  - a long reply from the open Bot landing → every avatar holds still while the user reads it.

const transient = new Map<string, Transient>();
const subs = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const EMPTY: Transient = Object.freeze({});
/** A hand-off between the same two Bots within this window is one hand-off (the sender's copy and
 *  the receiver's copy of the same message both arrive). */
const HANDOFF_DEDUPE_MS = 2000;
const recent = new Map<string, number>();
/** A reply at least this long makes the user a reader; reading time at ~25 characters a second. */
export const LONG_REPLY_CHARS = 400;
export function readingMs(chars: number): number { return Math.round(Math.min(25_000, Math.max(4_000, (chars / 25) * 1000))); }

function emit(): void { for (const f of subs) f(); }
function mark(botId: string, patch: Transient, ms: number): void {
  transient.set(botId, { ...(transient.get(botId) ?? {}), ...patch });
  emit();
  // One re-render when the moment ends, so the pose returns to the tool stream's.
  const old = timers.get(botId);
  if (old) clearTimeout(old);
  timers.set(botId, setTimeout(() => { timers.delete(botId); transient.set(botId, { ...transient.get(botId) }); emit(); }, ms + 20)); // a new snapshot, so it re-renders
}

/** React: subscribe (useSyncExternalStore). */
export function subscribeTransient(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }
/** A Bot's transient moments (a stable object until they change). */
export function transientFor(botId: string): Transient { return transient.get(botId) ?? EMPTY; }

function handoff(from: string, to: string, at: number): void {
  const key = `${from}>${to}`;
  const last = recent.get(key);
  if (last !== undefined && at - last < HANDOFF_DEDUPE_MS) return;
  recent.set(key, at);
  livingHandoff(from, to);
}

/**
 * Apply one SSE event (exported for tests; `installLivingEvents` feeds it the live stream).
 * `activeBotId` is the chat the user has open; `nowMs` the wall clock.
 */
export function applyLivingEvent(e: SseEvent, activeBotId: string | null, nowMs = Date.now()): void {
  if (e.channel === "agent-upserted") {
    const b = e.payload.agent;
    if (toolAct(b.activity?.tool) === "remember" && b.activity?.tool) {
      const t = transient.get(b.id)?.rememberAt;
      if (t === undefined || nowMs - t > REMEMBER_MS) mark(b.id, { rememberAt: nowMs }, REMEMBER_MS);
    }
    return;
  }
  if (e.channel !== "transcript") return;
  const p = e.payload;
  if (p.op === "typing") return;
  const entry: TranscriptEntry = p.entry;
  if (entry.kind === "tool-call" && entry.status === "error" && !entry.hidden) {
    const t = transient.get(p.botId)?.stuckAt;
    if (t === undefined || nowMs - t > STUCK_MS) mark(p.botId, { stuckAt: nowMs }, STUCK_MS);
    return;
  }
  if (isAgentMessage(entry) && p.op === "append") {
    if (entry.toAgent) handoff(p.botId, entry.toAgent.id, nowMs);
    else if (entry.fromAgent) handoff(entry.fromAgent.id, p.botId, nowMs);
    return;
  }
  if (p.op === "append" && p.botId === activeBotId && entry.kind === "send-message" && entry.message.type === "text") {
    const n = entry.message.content.length;
    if (n >= LONG_REPLY_CHARS) livingReading(readingMs(n));
  }
}

/** Wire the live stream (main.tsx), with the store's open chat. Returns the unsubscribe. */
export function installLivingEvents(onEvent: (cb: (e: SseEvent) => void) => () => void, activeBotId: () => string | null): () => void {
  return onEvent((e) => applyLivingEvent(e, activeBotId()));
}

/** Tests. */
export function resetLivingEvents(): void {
  transient.clear(); recent.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
