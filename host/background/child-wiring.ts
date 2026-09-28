import type { SubagentType } from "@synapse/shared";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { BotToolDef, BrainWiring, PostToolOutcome, ToolCall } from "../brain/types";
import type { ApprovalGateLike } from "../runner/bot-wiring";
import { fenceOutput, shouldFence } from "../runner/discipline";
import { countersOf, type TurnSlot } from "../runner/turn-slot";

/** TOOL-02: built-ins per child type. No Task/Agent (no grandchildren), no SendMessage, no AskUserQuestion. */
export const CHILD_BUILTINS: Record<SubagentType, string[]> = {
  generalPurpose: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"],
  computerUse: ["Read"],
  browserUse: ["Read"],
};

export interface ChildWiringOptions {
  parentBotId: string;
  childId: string;
  slot(): TurnSlot;
  gate: ApprovalGateLike;
  tools: BotToolDef[];
  flags(): ConformanceFlags;
  /** T16 wraps this with secret redaction; default is fencing only. */
  postToolUse?(call: ToolCall, output: string): Promise<PostToolOutcome>;
}

const short = (call: ToolCall): string => {
  const name = call.toolName.replace(/^mcp__(bot|computer)__/, "");
  const i = call.input;
  const detail = String(i.command ?? i.url ?? i.action ?? i.ref ?? i.file_path ?? i.pattern ?? i.query ?? "").replace(/\s+/g, " ").slice(0, 120);
  return detail ? `${name}: ${detail}` : name;
};

/** TOOL-13, TOOL-02, APR-01: a child's own BrainWiring — every call still goes through the parent's
 *  ApprovalGateLike (with the child's own slot and id via GateCallCtx), browser/connector output is
 *  fenced the same way a parent's would be, and children never nudge (they end with their report, not
 *  a SendMessage) and keep only a short rolling action log for the parent's transcript summary. */
export function createChildWiring(o: ChildWiringOptions): BrainWiring & { actions: string[] } {
  const actions: string[] = [];
  const ctx = () => ({ slot: o.slot(), childId: o.childId });
  return {
    actions,
    // I3: every child call names its child task, so the gate's rehearsal rule (RehearsalRegistry) can see it.
    preToolUse: async (call) => {
      const slot = o.slot();
      slot.toolCallsTotal += 1;
      return o.gate.preToolUse(o.parentBotId, { ...call, childTaskId: o.childId }, ctx());
    },
    canUseTool: (call, signal) => o.gate.canUseTool(o.parentBotId, { ...call, childTaskId: o.childId }, signal, ctx()),
    postToolUse: async (call, output) => {
      actions.push(short(call));
      if (actions.length > 24) actions.splice(0, actions.length - 24);
      if (o.postToolUse) return o.postToolUse(call, output);
      return shouldFence(call.toolName, call.input) ? { replaceOutput: fenceOutput(call.toolName, output) } : {};
    },
    stop: async () => ({ block: false }), // children end with their report; no SendMessage nudges (TOOL-02)
    botTools: () => o.tools,
    turnCounters: () => countersOf(o.slot()),
    flags: o.flags,
  };
}
