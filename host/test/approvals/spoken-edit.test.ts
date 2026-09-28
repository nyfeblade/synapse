import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { TEXT } from "../../review/texts";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// Bug 142: spoken approvals on a call. A plain yes / no resolves the card as today; anything else goes to the
// Bot's voice, which EDITS the pending action: the card is declined with the user's change as a note, so the Bot
// redoes it with that change and the new card is read back for a final yes.

const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Sends a message as you.", proposedRule: null, verdict: null };

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const reviewer: ReviewerLike = { review: async () => BLOCK, clearCache: () => {} };
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, readFile: () => null, onDeferredResolution: () => {} });
  const call = { toolName: "Bash", input: { command: "rm -rf /workspace/old" }, toolUseId: "tu1" };
  return { bots, id, gate, call };
}

describe("spoken approvals: the pending cards, and a decline that carries the user's change", () => {
  it("pending() lists the Bot's pending cards (what the call reads aloud)", async () => {
    const s = setup();
    expect(s.gate.pending(s.id)).toEqual([]);
    await s.gate.preToolUse(s.id, s.call);
    const perm = s.gate.canUseTool(s.id, s.call, new AbortController().signal);
    const [card] = s.gate.pending(s.id);
    expect(card).toMatchObject({ status: "pending", summary: expect.stringContaining("rm -rf /workspace/old") });
    s.gate.resolve(s.id, card!.approvalId, "once");
    await perm;
    expect(s.gate.pending(s.id)).toEqual([]);
  });

  it("deny with a note: the Bot is told the user's change and to redo it (so a new card comes back)", async () => {
    const s = setup();
    await s.gate.preToolUse(s.id, s.call);
    const perm = s.gate.canUseTool(s.id, s.call, new AbortController().signal);
    const [card] = s.gate.pending(s.id);
    expect(s.gate.resolve(s.id, card!.approvalId, "deny", "Say 10 minutes, not 5.")).toBe("denied");
    const d = (await perm) as { behavior: string; message: string };
    expect(d.behavior).toBe("deny");
    expect(d.message).toContain("Say 10 minutes, not 5.");
    expect(d.message).not.toBe(TEXT.userDeny);
    expect(d.message).toMatch(/change/i);
    const entry = s.bots.tail(s.id, 20).find((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval");
    expect((entry!.message as { approval: { status: string } }).approval.status).toBe("denied");
  });

  it("a plain deny keeps the plain text", async () => {
    const s = setup();
    await s.gate.preToolUse(s.id, s.call);
    const perm = s.gate.canUseTool(s.id, s.call, new AbortController().signal);
    s.gate.resolve(s.id, s.gate.pending(s.id)[0]!.approvalId, "deny");
    expect(((await perm) as { message: string }).message).toBe(TEXT.userDeny);
  });
});
