import type { GateCallCtx } from "../approvals/approval-gate";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { BotToolDef, BrainWiring, PermissionDecision, PreToolDecision, ToolCall } from "../brain/types";
import { onPostToolUse, onStop, onToolBatch } from "./discipline";
import type { TurnHooks } from "./hooks";
import type { ExpireCause, PostToolHook } from "./turn-runner";
import { countersOf, type TurnSlot } from "./turn-slot";

/**
 * The one canonical ApprovalGateLike declaration for the app (pre-flight ruling, 2026-09-19:
 * "ONE canonical ApprovalGateLike declaration"). `turn-runner.ts` imports this type rather than
 * declaring its own, so there is never a second, possibly-drifting copy (T9 self-review Finding 5).
 */
export interface ApprovalGateLike {
  preToolUse(botId: string, call: ToolCall, ctx?: GateCallCtx): Promise<PreToolDecision>;
  canUseTool(botId: string, call: ToolCall, signal: AbortSignal, ctx?: GateCallCtx): Promise<PermissionDecision>;
  expireAll(botId: string, cause: ExpireCause): void;
  forgetBot(botId: string): void;
  /** Bug 198: the Bot's pending approval cards; while any is pending a new message interrupts as before. */
  pendingCount?(botId: string): number;
}

export function createBotWiring(r: {
  botId: string;
  slot(): TurnSlot | null;
  gate: () => ApprovalGateLike;
  tools: () => BotToolDef[];
  flags(): ConformanceFlags;
  hooks?: () => TurnHooks;
  postToolHooks?: () => PostToolHook[];
  /** The host clock, for OUT-05's wall-clock silence arm (bug B). */
  now(): number;
  /** Bug 198: holds a side-effect call made before the Bot read the user's new message. */
  steerGate?: (call: ToolCall) => PreToolDecision | null;
}): BrainWiring {
  return {
    preToolUse: async (call) => r.steerGate?.(call) ?? r.hooks?.().preToolUse?.(r.botId, call, r.slot()) ?? r.gate().preToolUse(r.botId, call),
    canUseTool: (call, signal) => r.gate().canUseTool(r.botId, call, signal),
    postToolUse: async (call, output) => {
      const s = r.slot();
      const base = s ? onPostToolUse(s, call, output, r.now) : {};
      const extra = (r.postToolHooks?.() ?? []).map((h) => h(r.botId, s, call, output)).filter((x): x is string => Boolean(x));
      if (!extra.length) return base;
      return { ...base, additionalContext: [base.additionalContext, ...extra].filter(Boolean).join("\n\n") };
    },
    stop: async (info) => {
      const s = r.slot();
      // EVT-19 / bug 2 review round 2: every exit here that tells the CLI block:false is this wiring's
      // own "the turn may genuinely end now" decision, same as onStop's — so it sets endTurnRequested
      // too, not just onStop's own internal return. Without it, a stopNudge-off config or the quietWork
      // auto-send below could end a turn cleanly while isGenuinelyCutOff still read it as cut off.
      if (!s || !r.flags().stopNudge) {
        if (s) s.endTurnRequested = true;
        return { block: false };
      }
      const out = onStop(s, info);
      // coding-parity: in engineering mode a final plain-text answer is the result, as in the CLI. Deliver it
      // through the Bot's own SendMessage instead of a nudge that costs one more full-context call.
      const text = info.lastAssistantText.trim();
      if (out.block && s.quietWork && text) {
        const send = r.tools().find((t) => t.name === "SendMessage");
        const res = send ? await send.handler({ content: text }).catch(() => null) : null;
        if (res && !res.isError) {
          s.endTurnRequested = true;
          return { block: false };
        }
      }
      return out;
    },
    toolBatch: async (calls) => {
      const s = r.slot();
      if (s) s.steerHold = false; // bug 198: the batch is over; the model reads the steering note on its next call
      return s ? onToolBatch(s, calls) : { endTurn: false };
    },
    botTools: () => r.tools(),
    turnCounters: () => countersOf(r.slot()),
    flags: r.flags,
  };
}
