import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { originOf } from "../../approvals/origin";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS, type ConformanceFlags } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool } from "../../review/classify";
import type { ReviewOutcome, ReviewRequest } from "../../review/types";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { RehearsalRegistry } from "../../teach/rehearsal-registry";
import { tmpConfig } from "../helpers";

const O = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Sends mail to a new person.", proposedRule: null, verdict: null };
const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };

function setup(outcome: ReviewOutcome, flags: Partial<ConformanceFlags> = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const requests: ReviewRequest[] = [];
  const reviewer: ReviewerLike = { review: async (req) => { requests.push(req); return outcome; }, clearCache: () => {} };
  let slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const rehearsals = new RehearsalRegistry();
  const deferred: string[] = [];
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => ({ ...DEFAULT_FLAGS, ...flags }), readFile: () => null, onDeferredResolution: (_b, text) => deferred.push(text), rehearsals });
  const cards = () => bots.tail(id, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval");
  const view = () => (cards().at(-1)!.message as { approval: import("@synapse/shared").ApprovalCardView }).approval;
  return { id, gate, requests, cards, view, deferred, rehearsals, setSlot: (p: Partial<TurnSlot>) => { slot = { ...slot, ...p }; } };
}

describe("classification of Phase 4 tools (APR-02, APR-03, ORIG-17)", () => {
  it("reviews routine create/update/resume as automation_write with the APR-03 summary", () => {
    const c = classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "create", name: "overnight-watch", schedule: "CRON_TZ=America/New_York */30 0-7 * * *", prompt: "Check the build", enabled: true } }, O);
    expect(c).toMatchObject({ surface: "automation_write", sideEffect: true });
    expect(c.summary).toBe("Save the routine “overnight-watch” (active) to run CRON_TZ=America/New_York */30 0-7 * * *: “Check the build”");
    expect(classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "resume", id: "digest" } }, O).surface).toBe("automation_write");
    expect(classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "pause", id: "digest" } }, O).surface).toBeNull();
    expect(classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "delete", id: "digest" } }, O).surface).toBeNull();
  });
  it("does not throw when trigger is explicitly null", () => {
    expect(() => classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "create", name: "watch", trigger: null, prompt: "go" } }, O)).not.toThrow();
    const c = classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "create", name: "watch", trigger: null, prompt: "go" } }, O);
    expect(c.summary).toContain("its saved schedule");
  });
  it("does not render the literal word 'null' when schedule is explicitly null", () => {
    const c = classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "create", name: "watch", schedule: null, prompt: "go" } }, O);
    expect(c.summary).not.toContain("null");
    expect(c.summary).toContain("its saved schedule");
    expect(c.command).not.toContain("null");
    const withTrigger = classifyTool({ toolName: "mcp__bot__update_state", toolUseId: "t", input: { target: "routine", action: "create", name: "watch", schedule: null, trigger: { onFileChange: {} }, prompt: "go" } }, O);
    expect(withTrigger.summary).not.toContain("null");
    expect(withTrigger.summary).toContain("on onFileChange events");
  });
  it("reviews DeleteAgent on the control_plane surface", () => {
    const c = classifyTool({ toolName: "mcp__bot__DeleteAgent", toolUseId: "t", input: { agent_id: "abc", confirm: true } }, O);
    expect(c).toMatchObject({ surface: "control_plane", target: { action: "delete_agent", arguments: { agent_id: "abc" } } });
  });
});

describe("originOf (ORIG-01 §01.6 origin)", () => {
  it("maps wake sources to reviewer origins", () => {
    expect(originOf("user")).toBe("user");
    expect(originOf("kickstart")).toBe("user");
    expect(originOf("routine")).toBe("routine");
    expect(originOf("agent")).toBe("peer");
    expect(originOf("agent-error")).toBe("peer");
    expect(originOf("group-member")).toBe("group");
    expect(originOf("restart-resume")).toBe("revival");
    expect(originOf("listener-connected")).toBe("revival");
  });
});

describe("ApprovalGate with Phase 4 context", () => {
  it("sends the wake origin to the reviewer", async () => {
    const s = setup(ALLOW);
    s.setSlot({ source: "routine", lane: "background" });
    await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command: "touch /tmp/x" }, toolUseId: "a" });
    expect(s.requests[0]!.origin).toBe("routine");
  });

  it("never raises a card in a group-member turn (GRP-07)", async () => {
    const s = setup(BLOCK);
    s.setSlot({ source: "group-member", context: { chainId: null, wake: null, group: { groupId: "g", roomTurnId: "rt", epoch: 1 }, routineRun: null, rehearsal: false, sideEffects: 0 } });
    const pre = await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command: "rm -rf /workspace/old" }, toolUseId: "b" });
    expect(pre).toEqual({ decision: "deny", reason: STR.groupApprovalUnavailable });
    expect(s.cards()).toHaveLength(0);
  });

  it("adds the F4 floor hit to DeleteAgent", async () => {
    const s = setup(BLOCK);
    await s.gate.preToolUse(s.id, { toolName: "mcp__bot__DeleteAgent", input: { agent_id: "x", confirm: true }, toolUseId: "c" });
    expect(s.requests[0]!.staticResult.floorHits).toContain("F4");
    expect(s.requests[0]!.surface).toBe("control_plane");
  });

  it("denies (never asks) risky actions during a rehearsal and allows read-only ones", async () => {
    const s = setup(BLOCK);
    s.rehearsals.start(s.id, "child-1");
    const risky = await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command: "rm -rf /workspace/reports" }, toolUseId: "d", childTaskId: "child-1" });
    expect(risky).toEqual({ decision: "deny", reason: STR.rehearsalStopped });
    const ok = setup(ALLOW);
    ok.rehearsals.start(ok.id, "child-2");
    expect((await ok.gate.preToolUse(ok.id, { toolName: "Bash", input: { command: "ls /workspace" }, toolUseId: "e", childTaskId: "child-2" })).decision).toBe("allow");
    s.rehearsals.end("child-1");
    expect(s.rehearsals.active(s.id, { toolName: "Bash", input: {}, toolUseId: "f", childTaskId: "child-1" }, null)).toBe(false);
  });

  it("still denies a rehearsal replay of a fingerprint the human already defer-approved for real use (ORIG-08 §08.3 beats deferApproved)", async () => {
    const s = setup(BLOCK, { approvalPath: "defer" });
    const command = "rm -rf /workspace/old";
    // Real (non-rehearsal) turn: the human approves once via the defer flow, populating deferApproved.
    expect((await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command }, toolUseId: "real1" })).decision).toBe("defer");
    s.gate.resolve(s.id, s.view().approvalId, "once");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.deferred[0]).toContain("The user approved");
    s.setSlot({ awaitingUserSelection: false });
    // A rehearsal (teach-a-task dry-run) now replays the identical call under a child task.
    s.rehearsals.start(s.id, "child-3");
    const rehearsed = await s.gate.preToolUse(s.id, { toolName: "Bash", input: { command }, toolUseId: "reh1", childTaskId: "child-3" });
    expect(rehearsed).toEqual({ decision: "deny", reason: STR.rehearsalStopped });
  });
});
