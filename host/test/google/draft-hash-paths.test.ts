import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalCardView, SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type GateDeps } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS, type ConformanceFlags } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { hashDraftPreview, type DraftPreview } from "../../google/tools";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// Final secfix item 1: every approval path pins the enriched draft_hash onto the executed input.

const ALLOW: ReviewOutcome = { kind: "allow", stage: "exact", verdict: null };
const PREVIEW: DraftPreview = { to: "dana@example.org", cc: "", bcc: "", subject: "Deck", bodyPreview: "Hello", body: "Hello", attachmentIds: [], attachmentCount: 0 };

function setup(flags: Partial<ConformanceFlags>, preview: GateDeps["googleDraftPreview"] = async () => ({ preview: PREVIEW })) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const me = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  let slot = newSlot({ botId: me, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const deferred: string[] = [];
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer: { review: async () => ALLOW, clearCache: () => {} }, slot: () => slot, flags: () => ({ ...DEFAULT_FLAGS, ...flags }),
    onDeferredResolution: (_b, t) => deferred.push(t), googleEmail: () => "me@example.com", googleBuiltin: () => true, googleDraftPreview: preview,
  });
  const cards = () => bots.tail(me, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval);
  const resume = () => { slot = newSlot({ botId: me, requestId: "req_2", turnNo: 3, lane: "user", source: "approval-resume", hidden: true, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 }); };
  return { gate, me, cards, deferred, resume, slot: () => slot };
}

const call = (tu: string) => ({ toolName: "mcp__google__gmail_send", input: { draft_id: "d9" }, toolUseId: tu });
const HASH = hashDraftPreview(PREVIEW);

describe("item 1: gmail_send(draft_id) carries the enriched draft_hash on every approval path", () => {
  it("canUseTool path", async () => {
    const s = setup({ approvalPath: "canUseTool" });
    expect((await s.gate.preToolUse(s.me, call("a1"))).decision).toBe("ask");
    const perm = s.gate.canUseTool(s.me, call("a1"), new AbortController().signal);
    s.gate.resolve(s.me, s.cards()[0]!.approvalId, "once");
    expect(await perm).toMatchObject({ behavior: "allow", updatedInput: { draft_id: "d9", draft_hash: HASH } });
  });

  it("hook path", async () => {
    const s = setup({ approvalPath: "hook" });
    const pre = s.gate.preToolUse(s.me, call("b1"));
    await new Promise((r) => setTimeout(r, 10));
    s.gate.resolve(s.me, s.cards()[0]!.approvalId, "once");
    expect(await pre).toMatchObject({ decision: "allow", updatedInput: { draft_id: "d9", draft_hash: HASH } });
  });

  it("defer path: the re-issued call after the hidden resume is pinned too", async () => {
    const s = setup({ approvalPath: "defer" });
    expect((await s.gate.preToolUse(s.me, call("c1"))).decision).toBe("defer");
    s.gate.resolve(s.me, s.cards()[0]!.approvalId, "once");
    await new Promise((r) => setTimeout(r, 10));
    s.resume();
    expect(await s.gate.preToolUse(s.me, call("c2"))).toMatchObject({ decision: "allow", updatedInput: { draft_id: "d9", draft_hash: HASH } });
  });

  it("batch path: sibling draft sends are never pre-decided; each gets its own enriched card", async () => {
    const s = setup({ approvalPath: "canUseTool" });
    for (const tu of ["e1", "e2"]) s.slot().toolUses.set(tu, { messageId: "m", name: "mcp__google__gmail_send", input: { draft_id: "d9" } } as never);
    await s.gate.preToolUse(s.me, call("e1"));
    const p = s.gate.canUseTool(s.me, call("e1"), new AbortController().signal);
    expect(s.cards()[0]!.items).toEqual([]);
    s.gate.resolve(s.me, s.cards()[0]!.approvalId, "once");
    expect(await p).toMatchObject({ behavior: "allow", updatedInput: { draft_hash: HASH } });
    expect((await s.gate.preToolUse(s.me, call("e2"))).decision).toBe("ask");
  });
});

describe("item 1: the draft hash covers the full body, recipients, subject and attachment ids", () => {
  it("a change past the 200-char preview changes the hash", () => {
    const long = "a".repeat(300);
    const a = { ...PREVIEW, body: long, bodyPreview: `${long.slice(0, 200)}…` };
    const b = { ...a, body: `${long}TAIL` };
    expect(hashDraftPreview(a)).not.toBe(hashDraftPreview(b));
  });

  it("swapping an attachment (same count) changes the hash", () => {
    const a = { ...PREVIEW, attachmentIds: ["att-1"], attachmentCount: 1 };
    const b = { ...PREVIEW, attachmentIds: ["att-2"], attachmentCount: 1 };
    expect(hashDraftPreview(a)).not.toBe(hashDraftPreview(b));
  });
});
