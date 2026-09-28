import { z } from "zod";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BrainWiring, PermissionDecision, PreToolDecision, TurnInput } from "../../brain/types";

export function testWiring(over: Partial<BrainWiring> = {}, counters = { sentMessageCount: 0 }): BrainWiring {
  return {
    preToolUse: async (): Promise<PreToolDecision> => ({ decision: "allow" }),
    canUseTool: async (): Promise<PermissionDecision> => ({ behavior: "allow" }),
    postToolUse: async () => ({}),
    stop: async () => ({ block: false }),
    botTools: () => [{
      name: "SendMessage", description: "send", schema: { content: z.string() }, readOnly: false,
      handler: async (a) => { counters.sentMessageCount++; return { text: `sent ${String(a.content)}` }; },
    }],
    turnCounters: () => ({ sentMessageCount: counters.sentMessageCount, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    flags: () => DEFAULT_FLAGS,
    ...over,
  };
}
export const input = (text = "hi"): TurnInput => ({
  prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "req_1",
  systemAppend: "", model: "claude-sonnet-5", autoReviewEpoch: "continue",
});
