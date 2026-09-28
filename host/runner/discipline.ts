import { LIMITS } from "@synapse/shared";
import { SEND_TOOL } from "../brain/tool-policy";
import type { PostToolOutcome, StopOutcome, ToolBatchOutcome, ToolCall } from "../brain/types";
import { nudgeText, reminder } from "./prompt-collector";
import type { TurnSlot } from "./turn-slot";

/**
 * Engineering mode (slot.quietWork): how long a Bot may work without a word before one progress reminder.
 *
 * Bug 1 (mixed signals, hand-test after a long engineering build): the prompt said progress notes are
 * rare, but this used to be both the quiet threshold AND the repeat gate at 2 minutes — a nudge every 2
 * minutes for as long as a build stayed silent, i.e. constant on anything that took a while. 4 minutes is
 * a real quiet stretch before the first one; ENGINEERING_QUIET_REPEAT_MS, not this constant, gates repeats.
 */
export const ENGINEERING_QUIET_MS = 240_000;
/** At most one more progress reminder per this many ms after the first (bug 1: was the same 2 minutes). */
export const ENGINEERING_QUIET_REPEAT_MS = 600_000;

/**
 * EVT-19 / bug 2 (hand-test after a long engineering build): "Continue from where you left off" fired on
 * the next boot even though the Bot had already sent its result — a clean end_turn is not a cut-off.
 * quiesce() used to call any bot with a live slot "busy" regardless of what that slot had already
 * delivered, so a resume marker could be written the instant the SendMessage that ended the turn
 * completed, before the host's own trailing bookkeeping (settle, afterSettle) let the slot go — a moment
 * with nothing left to re-run.
 *
 * Review round 1 (blocking): a send-counter formula (owed / a tool in flight / toolCallsSinceSend > 0)
 * missed the most common real cut-off — a progress note, then a long tool call still running — because
 * toolCallsSinceSend only moves once the POST hook fires, so a started-but-unfinished tool never showed
 * up in it.
 *
 * Review round 2 (blocking): that same counter-based formula ALSO misjudged the opposite case — a
 * progress note, then the model mid-thought with no tool running and no end requested — as a clean stop,
 * because on send counters alone it is IDENTICAL to a genuine clean stop (both read sentMessageCount > 0,
 * toolCallsSinceSend: 0, nothing in flight). Ruling: decide on "has the turn asked to end", never on
 * what has or hasn't run since the last send. `endTurnRequested` is that answer, and every path that
 * lets a turn genuinely stop now sets it before the slot can go idle: a SendMessage carrying
 * `end_turn: true` (bot-tools.ts), the PostToolBatch fast path's own "yes, ending" decision, and the Stop
 * hook's own "nothing more to say" and "this turn doesn't need to say anything" returns (onStop, onToolBatch
 * below) — every OTHER path leaves it false. So: cut off = the slot is live and has NOT asked to end.
 */
export function isGenuinelyCutOff(slot: Pick<TurnSlot, "endTurnRequested">): boolean {
  return !slot.endTurnRequested;
}

export function shouldFence(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "WebFetch" || tool === "WebSearch") return true;
  if (tool.startsWith("mcp__") && !tool.startsWith("mcp__bot__")) return true;
  // P5 review minor: the user's Mac and the plugin catalogs are outside content too.
  // mac-browser: page text is outside content (prompt injection); the Bot reads it as data.
  // mac-apps: so is anything read out of an app — a message, an email, a note, a button's own label.
  if (["mcp__bot__ExternalRead", "mcp__bot__ExternalShell", "mcp__bot__AwaitExternalShell", "mcp__bot__GetPlugin", "mcp__bot__SearchPlugins", "mcp__bot__Browser", "mcp__bot__MacApp"].includes(tool)) return true;
  if (tool === "Read") return /\/workspace\/uploads\/|\/workspace\/\.host-out\/(uploads|events|mcp-output)\/|(^|\/)\.bot\/mcp-output\//.test(String(input.file_path ?? ""));
  return false;
}

export function fenceOutput(tool: string, output: string): string {
  const safe = output.replace(/<(\/?)untrusted_data/g, "<$1untrusted_data_redacted");
  return `<untrusted_data source="${tool}">\n${safe}\n</untrusted_data>`;
}

/**
 * OUT-04, OUT-05 via PostToolUse additionalContext; TOOL-03 via updatedToolOutput.
 *
 * `now` is the host clock, for OUT-05's wall-clock silence arm. It is optional only so that a caller
 * with no clock (and the pre-existing count-only unit tests) keeps exactly the old behaviour: without
 * one, the wall-clock arm is off and only the call-count arm runs. Production always passes it —
 * see createBotWiring.
 */
export function onPostToolUse(slot: TurnSlot, call: ToolCall, output: string, now?: () => number): PostToolOutcome {
  const isSend = call.toolName === SEND_TOOL;
  slot.toolCallsTotal += 1;
  if (!isSend) slot.toolCallsSinceSend += 1;
  const out: PostToolOutcome = {};
  if (shouldFence(call.toolName, call.input)) {
    out.replaceOutput = fenceOutput(call.toolName, output);
    slot.untrusted = [...slot.untrusted, output.slice(0, 4000)].slice(-10);
  }
  if (isSend || slot.silenceAllowed) return out;
  const n = slot.toolCallsSinceSend;
  const notes: string[] = [];
  if (slot.quietWork) {
    // coding-parity: engineering mode works like the CLI (no ack first, no note every few calls); only a long
    // silence, timed from the turn start or the last send, earns one progress reminder, repeated at most
    // once per ENGINEERING_QUIET_REPEAT_MS (bug 1: these used to be the same 2-minute constant, so the
    // reminder repeated every 2 minutes for as long as the Bot stayed quiet).
    const t = now?.();
    if (t !== undefined && t - slot.lastSendAt >= ENGINEERING_QUIET_MS) {
      // A note already fired since the last send: gate the next one at the wider repeat interval.
      // Nothing noted yet this quiet stretch: the first-nudge threshold is the gate.
      const gate = slot.lastSilenceNoteAt > slot.lastSendAt ? ENGINEERING_QUIET_REPEAT_MS : ENGINEERING_QUIET_MS;
      if (t - slot.lastSilenceNoteAt >= gate) {
        slot.lastSilenceNoteAt = t;
        out.additionalContext = reminder("engineering-silence");
      }
    }
    return out;
  }
  if (!slot.sentTextThisTurn && n > LIMITS.startAckThreshold && (n - (LIMITS.startAckThreshold + 1)) % 2 === 0) notes.push(reminder("start-ack"));
  // OUT-05 has two arms. The call-count arm fires after >6 calls since the last send, then every 6.
  // The wall-clock arm is ours: bug B — a turn made of a few slow calls (a Shell, a subagent Task, a web
  // fetch) never reaches 7 calls, so the user watched minutes of silence with the count arm never firing.
  // It only runs after the Bot has acknowledged, because before that start-ack already nudges every 2
  // calls and two reminders in one tool result would just be noise.
  const t = now?.();
  const quiet = t !== undefined && slot.sentTextThisTurn
    && n >= LIMITS.silenceQuietMinCalls
    && t - slot.lastSendAt >= LIMITS.silenceQuietMs
    && t - slot.lastSilenceNoteAt >= LIMITS.silenceQuietMs;
  const byCount = n > LIMITS.silenceThreshold && (n - (LIMITS.silenceThreshold + 1)) % LIMITS.silenceThreshold === 0;
  if (byCount || quiet) {
    notes.push(reminder("silence"));
    if (t !== undefined) slot.lastSilenceNoteAt = t;
  }
  if (slot.sentTextThisTurn && !slot.earlyResultReminded && n === 3) {
    slot.earlyResultReminded = true;
    notes.push(reminder("early-result"));
  }
  if (notes.length) out.additionalContext = notes.join("\n");
  return out;
}

/**
 * OUT-07 through the Stop hook: at most LIMITS.stopBlocksMax blocks (1 for kickstart), plus one closing-send nudge.
 *
 * EVT-19 / bug 2 review round 2: every `{ block: false }` here is the Stop hook agreeing the turn may
 * genuinely end now, EXCEPT giving up on an owed reply after stopBlocksMax nudges — that is a dead end
 * with nothing delivered, not a clean finish, so it does NOT set endTurnRequested (isGenuinelyCutOff
 * below reads this as still cut off, the conservative choice for a turn that never said anything).
 */
export function onStop(slot: TurnSlot, info: { lastAssistantText: string }): StopOutcome {
  if (slot.silenceAllowed || slot.awaitingUserSelection || slot.quiescing) {
    slot.endTurnRequested = true;
    return { block: false };
  }
  const owed = slot.sentMessageCount === 0 && !slot.reacted;
  const max = slot.source === "kickstart" ? 1 : LIMITS.stopBlocksMax;
  if (owed) {
    if (slot.stopBlocks >= max) return { block: false }; // gave up with nothing delivered: not a clean end
    slot.stopBlocks += 1;
    return { block: true, reason: nudgeText("reply", info.lastAssistantText) };
  }
  // Ruling (d): a turn that ends waiting on a SendToAgent result gets no closing nudge; that result's wake replies.
  if (slot.sentTextThisTurn && slot.toolCallsSinceSend > 0 && !slot.closingNudged && !slot.pendingDelegation && slot.source !== "kickstart") {
    slot.closingNudged = true;
    return { block: true, reason: nudgeText("closing", info.lastAssistantText) };
  }
  slot.endTurnRequested = true;
  return { block: false };
}

/**
 * Token diet (1): a batch made only of SendMessage calls, one of which was delivered with end_turn, ends
 * the turn with no further model call. onStop would let such a turn end anyway (a send was made and no
 * tool ran after it), so nothing the Stop hook enforces is skipped. Any other tool in the batch keeps
 * the turn going: its result has to reach the model. The request is spent either way.
 *
 * EVT-19 / bug 2 review round 2: `slot.endTurnRequested` is both this function's own input (did a send
 * in this batch ask to end) and, once this decides, the OUTPUT signal isGenuinelyCutOff reads later — so
 * it is now set to the actual decision (true only when really ending) instead of being unconditionally
 * reset to false. A batch that is not ending (mixed tools, or nothing asked) leaves it false: more work
 * is coming, so a restart mid-batch is still a genuine cut-off.
 */
export function onToolBatch(slot: TurnSlot, calls: ToolCall[]): ToolBatchOutcome {
  const wanted = slot.endTurnRequested;
  if (!wanted || calls.length === 0) {
    slot.endTurnRequested = false;
    return { endTurn: false };
  }
  const endTurn = calls.every((c) => c.toolName === SEND_TOOL) && slot.sentMessageCount > 0 && slot.toolCallsSinceSend === 0;
  slot.endTurnRequested = endTurn;
  return { endTurn };
}
