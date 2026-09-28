import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toSdkHooks } from "../../brain/sdk-wiring";
import { SEND_TOOL } from "../../brain/tool-policy";
import type { BrainWiring, ToolCall } from "../../brain/types";
import { onPostToolUse, onStop, onToolBatch } from "../../runner/discipline";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";

/** Token diet (1) at unit level; the wire-level call counts are in end-turn-on-send.cli.integration.test.ts. */
const slot = (): TurnSlot => newSlot({ botId: "b", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
const call = (toolName: string, id = toolName): ToolCall => ({ toolName, input: {}, toolUseId: id });
const sent = (s: TurnSlot, endTurn: boolean) => { s.sentMessageCount += 1; s.sentTextThisTurn = true; s.toolCallsSinceSend = 0; s.endTurnRequested = endTurn; };

describe("onToolBatch: when a delivered reply ends the turn", () => {
  it("ends after a sends-only batch whose send asked for it, exactly where onStop would let the turn end", () => {
    const s = slot();
    sent(s, true);
    onPostToolUse(s, call(SEND_TOOL), "Message sent.");
    expect(onToolBatch(s, [call(SEND_TOOL)])).toEqual({ endTurn: true });
    expect(onStop(s, { lastAssistantText: "" })).toEqual({ block: false });
  });

  it("never ends without end_turn, and the request is spent once a batch has run", () => {
    const s = slot();
    sent(s, false);
    expect(onToolBatch(s, [call(SEND_TOOL)])).toEqual({ endTurn: false });
    sent(s, true);
    expect(onToolBatch(s, [call(SEND_TOOL), call("Bash")])).toEqual({ endTurn: false });
    expect(s.endTurnRequested).toBe(false);
    expect(onToolBatch(s, [call(SEND_TOOL)])).toEqual({ endTurn: false });
  });

  it("does not end a turn that still owes a tool result to the model", () => {
    const s = slot();
    sent(s, true);
    s.toolCallsSinceSend = 1;
    expect(onToolBatch(s, [call(SEND_TOOL)])).toEqual({ endTurn: false });
  });
});

describe("the SDK PostToolBatch hook", () => {
  const wiring = (endTurn: boolean, note?: string): BrainWiring => ({
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), stop: async () => ({ block: false }),
    postToolUse: async () => (note ? { additionalContext: note } : {}), toolBatch: async () => ({ endTurn }),
    botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }), flags: () => DEFAULT_FLAGS,
  });
  const opts = { signal: new AbortController().signal };
  const batch = { hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: SEND_TOOL, tool_input: { content: "hi", end_turn: true }, tool_use_id: "t1" }] };

  it("stops the CLI before its next model call when the wiring says the reply is done", async () => {
    const h = toSdkHooks(wiring(true));
    expect(await h.PostToolBatch![0]!.hooks[0]!(batch as never, undefined, opts)).toEqual({ continue: false, stopReason: "reply delivered" });
    expect(await toSdkHooks(wiring(false)).PostToolBatch![0]!.hooks[0]!(batch as never, undefined, opts)).toEqual({});
  });

  it("keeps going when a tool result in the batch carries a note the model has to read", async () => {
    const h = toSdkHooks(wiring(true, "<system_reminder>disk nearly full</system_reminder>"));
    await h.PostToolUse![0]!.hooks[0]!({ hook_event_name: "PostToolUse", tool_name: SEND_TOOL, tool_input: {}, tool_use_id: "t1", tool_response: "Message sent." } as never, "t1", opts);
    expect(await h.PostToolBatch![0]!.hooks[0]!(batch as never, undefined, opts)).toEqual({});
  });

  it("bug 198: a held call's steering note rides beside the denial and keeps the turn going", async () => {
    const w: BrainWiring = { ...wiring(true), preToolUse: async () => ({ decision: "deny", reason: "Not run", additionalContext: "<system_reminder>steer</system_reminder>" }) };
    const h = toSdkHooks(w);
    const out = await h.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: SEND_TOOL, tool_input: {}, tool_use_id: "t1" } as never, "t1", opts);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Not run", additionalContext: "<system_reminder>steer</system_reminder>" } });
    expect(await h.PostToolBatch![0]!.hooks[0]!(batch as never, undefined, opts)).toEqual({});
  });
});
