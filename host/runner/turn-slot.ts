import type { RoomReview } from "../groups/member-prompt";
import type { ToolCallEntry } from "@synapse/shared";
import type { Lane, TurnCounters, WakeSource } from "../brain/types";
import { emptyContext, type TurnContext } from "./turn-context";

/** Per-turn state the hooks, canUseTool and bot tools read (ORIG-16 §16.2 "current-turn slot"). */
export interface TurnSlot {
  botId: string;
  /** saving-settings: a call this Bot is on was live when the turn started (usage.db's callLive column). */
  callLive?: boolean;
  requestId: string;
  turnNo: number;
  lane: Lane;
  source: WakeSource;
  hidden: boolean;
  silenceAllowed: boolean;
  userSeqMax: number;
  ackToken: string | null;
  sentMessageCount: number;
  reacted: boolean;
  awaitingUserSelection: boolean;
  toolCallsSinceSend: number;
  toolCallsTotal: number;
  /** OUT-05 wall-clock arm: when the user last actually saw something — the turn start, then every send. */
  lastSendAt: number;
  /** OUT-05 wall-clock arm: when the silence reminder last fired, so it repeats at most once a window. */
  lastSilenceNoteAt: number;
  sentTextThisTurn: boolean;
  /**
   * coding-parity: an engineering-mode Bot's turn. It works like the CLI: no ack-first, per-call-count or
   * early-result reminders; one progress reminder only after ENGINEERING_QUIET_MS of silence (discipline.ts).
   */
  quietWork?: boolean;
  /** The SendMessage being delivered asked to notify the user (scheduled and triggered runs are quiet otherwise). */
  notifyRequested?: boolean;
  earlyResultReminded: boolean;
  stopBlocks: number;
  closingNudged: boolean;
  /** Ruling (d): a SendToAgent request/question/handoff sent this turn is pending (its result or the new owner replies). A blocker is not. */
  pendingDelegation: boolean;
  /** Token diet (1): a SendMessage with end_turn: true was delivered in the current tool batch. */
  endTurnRequested: boolean;
  dispatched: boolean;
  replyTo: string | null;        // CHAT-11: auto-thread target for this turn's sends
  sentTexts: string[];           // SendMessage texts of this turn (memory extraction input)
  firstEventAt: number | null;   // resume latency (ORIG-07 §07.5)
  nextSendK: number;
  nextActK: number;
  segment: number;
  quiescing: boolean;
  /** Bug 198: the user asked this turn to stop (a "stop" message or the Stop button); nothing more steers it. */
  stopRequested?: boolean;
  /** Bug 198: this turn's random tag for the user's steering words (a tool's output can't guess it). */
  steerNonce?: string;
  /** Bug 198: a steering note was delivered in the current tool batch; its remaining non-read-only calls are
   *  held until the batch ends (PostToolBatch), since the model reads the note only on its next call. */
  steerHold?: boolean;
  userMessageEpoch: number;
  startedAt: number;
  partialJson: string;
  untrusted: string[]; // fenced tool outputs of this turn, for the reviewer's untrusted_excerpts (§01.6)
  toolUses: Map<string, { messageId: string; name: string; input: Record<string, unknown> }>;
  toolEntries: Map<string, ToolCallEntry>;
  context: TurnContext;
  visibleWritten: boolean;     // CHAT-23: set on the first visible entry of the turn
  wakeText: string;            // I2: the wake prompt this turn started from (the reviewer's wake block)
  /** A subagent's slot: the wake source of the parent turn that launched it, which the reviewer's origin follows
   *  (its own source stays "subagent-done"). Unset → the slot's own source. */
  reviewSource?: WakeSource;
  /** Bug 434 follow-up: a room member turn's posts with their structured authors, for Auto-review's trust (never
   *  from display names). Set by the group orchestrator; a follow-up or subagent of that turn inherits it. */
  roomReview?: RoomReview;
}

export function newSlot(
  p: Pick<TurnSlot, "botId" | "requestId" | "turnNo" | "lane" | "source" | "hidden" | "silenceAllowed" | "userSeqMax" | "ackToken" | "userMessageEpoch" | "startedAt"> & { context?: Partial<TurnContext> },
): TurnSlot {
  const { context, ...rest } = p;
  return {
    ...rest, sentMessageCount: 0, reacted: false, awaitingUserSelection: false, toolCallsSinceSend: 0, toolCallsTotal: 0,
    lastSendAt: p.startedAt, lastSilenceNoteAt: p.startedAt,
    sentTextThisTurn: false, earlyResultReminded: false, stopBlocks: 0, closingNudged: false, pendingDelegation: false, endTurnRequested: false, dispatched: false,
    replyTo: null, sentTexts: [], firstEventAt: null,
    nextSendK: 0, nextActK: 0, segment: 0, quiescing: false, partialJson: "", untrusted: [], toolUses: new Map(), toolEntries: new Map(),
    context: { ...emptyContext(), ...(context ?? {}) }, visibleWritten: false, wakeText: "",
  };
}

export function countersOf(slot: TurnSlot | null): TurnCounters {
  if (!slot) return { sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false };
  return {
    sentMessageCount: slot.sentMessageCount,
    reacted: slot.reacted,
    awaitingUserSelection: slot.awaitingUserSelection,
    endedOnSilentToolCalls: slot.sentTextThisTurn && slot.toolCallsSinceSend > 0,
  };
}
