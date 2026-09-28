/**
 * fix-mac-gate-and-approval-expiry (Bug B), Auto-review cards: an approval card means the Bot has stopped and waits for
 * the user's choice before the turn goes on. A card no longer
 * expires after 10 minutes or when the session ends; a restart keeps it answerable; the answer resumes the Bot.
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import type { ReviewOutcome } from "../../review/types";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Deletes a folder you may need.", proposedRule: null, verdict: null };

function setup(o: { lane?: "user" | "background"; persist?: boolean } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: o.lane ?? "user", source: o.lane === "background" ? "routine" : "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const deferred: string[] = [];
  const persistFile = o.persist ? path.join(cfg.hostPrivate, "pending-approvals.json") : undefined;
  const reviewer: ReviewerLike = { review: async () => BLOCK, clearCache: () => {} };
  const mk = () => new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: (_b, t) => deferred.push(t), persistFile });
  const gate = mk();
  const view = () => (bots.tail(id, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").at(-1)!.message as { approval: import("@synapse/shared").ApprovalCardView }).approval;
  const call = (command: string, toolUseId = "tu1") => ({ toolName: "Bash", input: { command }, toolUseId });
  const ask = async (g: ApprovalGate, command: string, toolUseId = "tu1", signal = new AbortController().signal) => {
    const pre = await g.preToolUse(id, call(command, toolUseId));
    expect(pre.decision).toBe("ask");
    return { perm: g.canUseTool(id, call(command, toolUseId), signal) };
  };
  return { id, gate, mk, view, call, ask, deferred };
}

afterEach(() => vi.useRealTimers());

describe("Auto-review cards wait for the answer (Bug B)", () => {
  it("a background card answered 30 minutes later still works (was: expired at 10 minutes)", async () => {
    vi.useFakeTimers();
    const s = setup({ lane: "background" });
    const { perm } = await s.ask(s.gate, "rm -rf /workspace/old");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(s.view().status).toBe("pending");
    s.gate.resolve(s.id, s.view().approvalId, "once");
    await expect(perm).resolves.toMatchObject({ behavior: "allow" });
  });

  it("the session ending leaves the card answerable; the answer wakes the Bot, whose re-run is allowed once", async () => {
    const s = setup();
    const ac = new AbortController();
    const { perm } = await s.ask(s.gate, "rm -rf /workspace/old", "tu1", ac.signal);
    ac.abort(); // session end / rollover
    await expect(perm).resolves.toMatchObject({ behavior: "deny", message: expect.stringMatching(/card stays open/) });
    expect(s.view().status).toBe("pending"); // never "expired"
    // the Bot's later turns aren't held behind a card whose turn is gone
    expect((await s.gate.preToolUse(s.id, s.call("touch /workspace/x", "tu2"))).decision).not.toBe("deny");
    s.gate.resolve(s.id, s.view().approvalId, "once");
    expect(s.view().status).toBe("approved");
    expect(s.deferred).toEqual(["[Auto-review] The user approved: Run “rm -rf /workspace/old”. Run exactly that action now."]);
    expect((await s.gate.preToolUse(s.id, s.call("rm -rf /workspace/other", "tu3"))).decision).not.toBe("allow"); // bound to the exact call
    expect((await s.gate.preToolUse(s.id, s.call("rm -rf /workspace/old", "tu4"))).decision).toBe("allow");
    expect((await s.gate.preToolUse(s.id, s.call("rm -rf /workspace/old", "tu5"))).decision).not.toBe("allow"); // one-time
  });

  it("a host restart between the card and the answer: the card comes back pending and the answer resumes the Bot", async () => {
    const s = setup({ persist: true });
    await s.ask(s.gate, "rm -rf /workspace/old");
    s.gate.expireAll(s.id, "quiesce"); // the host is shutting down
    const fresh = s.mk(); // the new host process
    fresh.expirePersistedCards();
    expect(s.view().status).toBe("pending");
    expect(fresh.resolve(s.id, s.view().approvalId, "once")).toBe("approved");
    expect(s.deferred.at(-1)).toMatch(/The user approved: Run “rm -rf \/workspace\/old”/);
    expect((await fresh.preToolUse(s.id, s.call("rm -rf /workspace/old", "tu7"))).decision).toBe("allow");
    expect((await fresh.preToolUse(s.id, s.call("rm -rf /workspace/old", "tu8"))).decision).not.toBe("allow");
  });

  it("a denied late answer resumes the Bot with the denial", async () => {
    const s = setup();
    const ac = new AbortController();
    await s.ask(s.gate, "rm -rf /workspace/old", "tu1", ac.signal);
    ac.abort();
    s.gate.resolve(s.id, s.view().approvalId, "deny");
    expect(s.deferred.at(-1)).toMatch(/^\[Auto-review\] /);
    expect((await s.gate.preToolUse(s.id, s.call("rm -rf /workspace/old", "tu2"))).decision).not.toBe("allow");
  });

  it("an unanswered card is withdrawn only after 7 days (hygiene)", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.ask(s.gate, "rm -rf /workspace/old");
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(s.view().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000);
    expect(s.view()).toMatchObject({ status: "expired", cause: "ttl" });
  });
});
