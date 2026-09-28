import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS, type ConformanceFlags } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };
const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Holds a fare with your account.", proposedRule: null, verdict: null };

function setup(outcome: ReviewOutcome, identities: (string | null)[] = [], flags: Partial<ConformanceFlags> = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const parent = newSlot({ botId: id, requestId: "req_p", turnNo: 4, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const child = newSlot({ botId: id, requestId: "child:sub-1", turnNo: bots.nextTurnNo(id) + 100, lane: "background", source: "subagent-done", hidden: true, silenceAllowed: true, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const reviewer: ReviewerLike = { review: async () => outcome, clearCache: () => {} };
  let n = 0;
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer, slot: () => parent, flags: () => ({ ...DEFAULT_FLAGS, ...flags }), onDeferredResolution: () => {},
    displayIdentity: async () => identities[Math.min(n++, identities.length - 1)] ?? null,
  });
  const click = { toolName: "mcp__computer__Computer", input: { action: "click", x: 10, y: 20, description: "Hold the fare" }, toolUseId: "c1" };
  return { bots, id, parent, child, gate, click, settings };
}

/** The private Map is intentionally reached into for this white-box leak test; there is no public
 * accessor and adding one would widen the class's surface just for a test. */
function ctxMapSize(gate: ApprovalGate): number {
  return (gate as unknown as { ctxByToolUse: Map<string, unknown> }).ctxByToolUse.size;
}

describe("ApprovalGate — computer surface and children", () => {
  it("APR-07: a reviewer allow is followed by a display recheck; a changed page is denied with the spec text", async () => {
    const s = setup(ALLOW, ["page-A", "page-B"]);
    expect(await s.gate.preToolUse(s.id, s.click)).toEqual({ decision: "deny", reason: "The page has changed since it was reviewed; take a new browser_snapshot and try the action again." });
  });

  it("an unchanged page is allowed", async () => {
    const s = setup(ALLOW, ["page-A", "page-A"]);
    expect(await s.gate.preToolUse(s.id, s.click)).toEqual({ decision: "allow" });
  });

  it("a child's card lands in the parent's transcript with the child's turn numbers, a TTL, and never touches the parent's slot", async () => {
    const s = setup(BLOCK, ["page-A"]);
    const ctx = { slot: s.child, childId: "sub-1" };
    expect((await s.gate.preToolUse(s.id, s.click, ctx)).decision).toBe("ask");
    void s.gate.canUseTool(s.id, s.click, new AbortController().signal, ctx);
    const card = s.bots.tail(s.id, 10).find((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval")!;
    expect(card.id).toBe(`t${s.child.turnNo}s1`);
    expect(card.message).toMatchObject({ approval: { title: "Held for Your OK", summary: "Click at (10, 20) on Bots' computer to hold the fare", locationLine: "Runs on Bots' computer" } });
    expect(s.parent.nextSendK).toBe(0);
    expect(s.parent.awaitingUserSelection).toBe(false);
    // TOOL-07: the Bot now has a pending card, so the parent can't start a new side effect either
    expect(await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command: "touch x" }, toolUseId: "p1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/waiting on Auto-review/) });
  });
});

describe("ApprovalGate — ctxByToolUse does not leak on fast paths (fix round 1, finding 1)", () => {
  const ctx = (s: ReturnType<typeof setup>) => ({ slot: s.child, childId: "sub-1" });

  it("no surface/target: preToolUse allows and forgets the ctx", async () => {
    const s = setup(BLOCK);
    const call = { toolName: "WebFetch", input: { url: "https://x.com" }, toolUseId: "w1" };
    expect((await s.gate.preToolUse(s.id, call, ctx(s))).decision).toBe("allow");
    expect(ctxMapSize(s.gate)).toBe(0);
  });

  it("Auto-review disabled: preToolUse allows and forgets the ctx", async () => {
    const s = setup(BLOCK);
    s.settings.update({ autoReviewEnabled: false });
    expect((await s.gate.preToolUse(s.id, s.click, ctx(s))).decision).toBe("allow");
    expect(ctxMapSize(s.gate)).toBe(0);
  });

  it("hardDeny and the parallel-side-effect barrier both forget the ctx", async () => {
    const s = setup(BLOCK);
    const xdotool = { toolName: "Bash", input: { command: "xdotool key a" }, toolUseId: "x1" };
    expect((await s.gate.preToolUse(s.id, xdotool, ctx(s))).decision).toBe("deny");
    expect(ctxMapSize(s.gate)).toBe(0);

    s.child.quiescing = true;
    expect((await s.gate.preToolUse(s.id, { ...s.click, toolUseId: "q1" }, ctx(s))).decision).toBe("deny");
    expect(ctxMapSize(s.gate)).toBe(0);
  });

  it("deferApproved fast-allow: the re-run of an already-approved deferred action forgets the ctx", async () => {
    const s = setup(BLOCK, [], { approvalPath: "defer" });
    // the defer branch raises its card via an internal canUseTool call, synchronously, before
    // preToolUse itself returns the "defer" decision — no separate canUseTool call needed here.
    const first = await s.gate.preToolUse(s.id, s.click, ctx(s));
    expect(first.decision).toBe("defer");
    const card = s.bots.tail(s.id, 10).find((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval")!;
    s.gate.resolve(s.id, (card.message as { approval: { approvalId: string } }).approval.approvalId, "once");
    await new Promise((r) => setTimeout(r, 0));
    // ctx from the original call was consumed by settle(); this is the resumed retry, on a fresh
    // (non-awaiting) child slot, hitting the deferApproved fast-allow path (line 145) with its own ctx.
    const resumedChild = newSlot({ botId: s.id, requestId: "child:sub-1", turnNo: s.child.turnNo, lane: "background", source: "approval-resume", hidden: true, silenceAllowed: true, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
    const second = await s.gate.preToolUse(s.id, { ...s.click, toolUseId: "c2" }, { slot: resumedChild, childId: "sub-1" });
    expect(second.decision).toBe("allow");
    expect(ctxMapSize(s.gate)).toBe(0);
  });

  it("immediate reviewer allow (non-computer surface, no display recheck) forgets the ctx", async () => {
    const s = setup(ALLOW);
    const shell = { toolName: "Bash", input: { command: "ls /workspace" }, toolUseId: "b1" };
    expect((await s.gate.preToolUse(s.id, shell, ctx(s))).decision).toBe("allow");
    expect(ctxMapSize(s.gate)).toBe(0);
  });

  it("canUseTool forgets the ctx when the record is already settled or when there is nothing to review", async () => {
    const s = setup(BLOCK, ["page-A"]);
    expect((await s.gate.preToolUse(s.id, s.click, ctx(s))).decision).toBe("ask");
    const perm = s.gate.canUseTool(s.id, s.click, new AbortController().signal, ctx(s));
    const card = s.bots.tail(s.id, 10).find((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval")!;
    s.gate.resolve(s.id, (card.message as { approval: { approvalId: string } }).approval.approvalId, "once");
    await perm;
    expect(ctxMapSize(s.gate)).toBe(0);
    // record now settled: a repeat canUseTool for the same toolUseId hits the "existing, not pending" fast path
    await s.gate.canUseTool(s.id, s.click, new AbortController().signal, ctx(s));
    expect(ctxMapSize(s.gate)).toBe(0);
    // a toolUseId with no matching review at all hits the "no pr found" fast path
    await s.gate.canUseTool(s.id, { ...s.click, toolUseId: "never-reviewed" }, new AbortController().signal, ctx(s));
    expect(ctxMapSize(s.gate)).toBe(0);
  });
});
