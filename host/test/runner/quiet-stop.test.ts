import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BotToolDef } from "../../brain/types";
import { createBotWiring } from "../../runner/bot-wiring";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";

/**
 * coding-parity: coding bench 2026-09-22 run 1 (per-call trace): 2 of 3 engineering tasks ended with the
 * result written as plain text, like the CLI's; the Stop hook then blocked ("You wrote this but never sent
 * it") and the Bot spent one more full-context call only to pass the same text to SendMessage. In
 * engineering mode (slot.quietWork) the host now delivers that final text itself, through the Bot's own
 * SendMessage tool, and lets the turn end. Standard Bots keep the nudge.
 */
function setup(quietWork: boolean, sendFails = false) {
  const slot: TurnSlot = { ...newSlot({ botId: "b", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 }), quietWork };
  const sent: Record<string, unknown>[] = [];
  const send: BotToolDef = {
    name: "SendMessage", description: "", schema: {}, readOnly: false,
    handler: async (a) => {
      if (sendFails) return { text: "not delivered", isError: true };
      sent.push(a);
      slot.sentMessageCount += 1;
      return { text: "Sent." };
    },
  };
  const allow = { preToolUse: async () => ({ decision: "allow" as const }), canUseTool: async () => ({ behavior: "allow" as const, updatedInput: {} }), expireAll: () => {}, forgetBot: () => {} };
  const w = createBotWiring({ botId: "b", slot: () => slot, gate: () => allow as never, tools: () => [send], flags: () => DEFAULT_FLAGS, now: () => 0 });
  return { w, sent, slot };
}

describe("engineering mode: the final plain-text answer is delivered, not nudged (coding-parity)", () => {
  it("sends the last assistant text as the reply and ends the turn with no extra model call", async () => {
    const s = setup(true);
    const out = await s.w.stop({ lastAssistantText: "Fixed: the parser now handles doubled quotes. 54/54 tests pass.\n", stopHookActive: false });
    expect(out).toEqual({ block: false });
    expect(s.sent).toEqual([{ content: "Fixed: the parser now handles doubled quotes. 54/54 tests pass." }]);
  });

  it("also after an earlier progress note (the closing case)", async () => {
    const s = setup(true);
    Object.assign(s.slot, { sentMessageCount: 1, sentTextThisTurn: true, toolCallsSinceSend: 3 });
    expect(await s.w.stop({ lastAssistantText: "All green now.", stopHookActive: false })).toEqual({ block: false });
    expect(s.sent).toHaveLength(1);
  });

  it("still nudges when there is no text to deliver, or the send fails", async () => {
    expect((await setup(true).w.stop({ lastAssistantText: "  ", stopHookActive: false })).block).toBe(true);
    const f = setup(true, true);
    expect((await f.w.stop({ lastAssistantText: "Done.", stopHookActive: false })).block).toBe(true);
  });

  it("a standard Bot is unchanged: nudged, nothing sent for it", async () => {
    const s = setup(false);
    const out = await s.w.stop({ lastAssistantText: "Done.", stopHookActive: false });
    expect(out.block).toBe(true);
    expect(s.sent).toEqual([]);
  });

  it("a turn that already delivered its result and ran no tool after is left alone", async () => {
    const s = setup(true);
    Object.assign(s.slot, { sentMessageCount: 1, sentTextThisTurn: true, toolCallsSinceSend: 0 });
    expect(await s.w.stop({ lastAssistantText: "Sent.", stopHookActive: false })).toEqual({ block: false });
    expect(s.sent).toEqual([]);
  });
});
