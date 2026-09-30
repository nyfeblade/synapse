import path from "node:path";
import { describe, expect, it } from "vitest";
import { composioToolReadOnly, type ApprovalCardView, type SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool } from "../../review/classify";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ALLOW: ReviewOutcome = { kind: "allow", stage: "exact", verdict: null };
const BLOCK: ReviewOutcome = { kind: "block", stage: "floor", reason: "no", proposedRule: null, verdict: null };
const cls = (tool: string, input: Record<string, unknown> = {}) =>
  classifyTool({ toolName: `mcp__composio_apps__${tool}`, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host", composioBuiltin: true });

const READS = ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS", "GMAIL_GET_ATTACHMENT", "GMAIL_LIST_DRAFTS", "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_EVENTS_LIST",
  "SLACK_FETCH_CONVERSATION_HISTORY", "GITHUB_GET_A_REPOSITORY", "NOTION_QUERY_DATABASE", "LINEAR_LIST_LINEAR_ISSUES", "GOOGLEDRIVE_FIND_FILE"];
const WRITES = ["GMAIL_SEND_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_REPLY_TO_THREAD", "GMAIL_MOVE_TO_TRASH", "GMAIL_ADD_LABEL_TO_EMAIL", "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT", "SLACK_SEND_MESSAGE", "SLACK_CHAT_POST_MESSAGE", "GITHUB_CREATE_AN_ISSUE", "GITHUB_MERGE_A_PULL_REQUEST", "NOTION_UPDATE_PAGE",
  "LINEAR_CREATE_LINEAR_ISSUE", "GOOGLEDRIVE_UPLOAD_FILE", "GITHUB_GET_AND_DELETE_A_BRANCH", "SLACK_UNKNOWN_THING", "GMAIL_BATCH_MODIFY_MESSAGES"];

describe("classifying Composio tools", () => {
  it("reads are quiet: no card surface, no side effect", () => {
    for (const t of READS) {
      expect(composioToolReadOnly(t), t).toBe(true);
      expect(cls(t, { query: "x" }), t).toMatchObject({ surface: null, sideEffect: false, target: null, hardDeny: null });
    }
  });

  it("anything that sends or changes (and anything unrecognised) is a composio_write", () => {
    for (const t of WRITES) {
      expect(composioToolReadOnly(t), t).toBe(false);
      expect(cls(t), t).toMatchObject({ surface: "mcp", sideEffect: true, target: { action: "composio_write", arguments: { tool: t } } });
    }
    expect(cls("GMAIL_SEND_EMAIL", { recipient_email: "friend@example.com", subject: "Deck" }).summary).toBe("Gmail through Composio: send email to friend@example.com “Deck”");
  });
});

function setup(outcome: ReviewOutcome, mode: "ask" | "full-auto" = "ask") {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const me = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const slot = newSlot({ botId: me, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  let reviews = 0;
  const reviewer: ReviewerLike = { review: async () => { reviews++; return outcome; }, clearCache: () => {} };
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {}, permMode: () => mode, composioBuiltin: () => true });
  const cards = () => bots.tail(me, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval);
  return { settings, gate, me, cards, reviews: () => reviews };
}

describe("the gate on Composio tools", () => {
  it("with Auto-review OFF, GMAIL_SEND_EMAIL still raises a card that names the app; Allow once runs exactly that call", async () => {
    const s = setup(ALLOW);
    s.settings.update({ autoReviewEnabled: false });
    const c = { toolName: "mcp__composio_apps__GMAIL_SEND_EMAIL", input: { recipient_email: "friend@example.com", subject: "Deck", body: "hi" }, toolUseId: "tu1" };
    expect((await s.gate.preToolUse(s.me, c)).decision).toBe("ask");
    const perm = s.gate.canUseTool(s.me, c, new AbortController().signal);
    expect(s.cards()).toHaveLength(1);
    expect(s.cards()[0]).toMatchObject({ status: "pending", hasProposedRule: false, locationLine: "Acts on your Gmail account through Composio" });
    s.gate.resolve(s.me, s.cards()[0]!.approvalId, "once");
    expect(await perm).toMatchObject({ behavior: "allow" });
    expect(s.reviews()).toBe(0);
  });

  it("with Auto-review ON, a reviewer 'allow' can't skip the card for a write", async () => {
    const s = setup(ALLOW);
    for (const [i, t] of ["SLACK_SEND_MESSAGE", "GOOGLECALENDAR_DELETE_EVENT", "GITHUB_CREATE_AN_ISSUE"].entries()) {
      const c = { toolName: `mcp__composio_apps__${t}`, input: {}, toolUseId: `w${i}` };
      expect((await s.gate.preToolUse(s.me, c)).decision, t).toBe("ask");
      const perm = s.gate.canUseTool(s.me, c, new AbortController().signal);
      s.gate.resolve(s.me, s.cards().at(-1)!.approvalId, "deny");
      expect(await perm).toMatchObject({ behavior: "deny" });
    }
    expect(s.reviews()).toBe(0);
  });

  it("reads pass without a card even when the reviewer would block", async () => {
    const s = setup(BLOCK);
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__composio_apps__GMAIL_FETCH_EMAILS", input: { query: "deck" }, toolUseId: "r1" })).decision).toBe("allow");
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__composio_apps__SLACK_FETCH_CONVERSATION_HISTORY", input: {}, toolUseId: "r2" })).decision).toBe("allow");
    expect(s.cards()).toHaveLength(0);
  });

  it("in Full auto a write still asks and a read stays quiet", async () => {
    const s = setup(ALLOW, "full-auto");
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__composio_apps__NOTION_UPDATE_PAGE", input: {}, toolUseId: "f1" })).decision).toBe("ask");
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__composio_apps__NOTION_QUERY_DATABASE", input: {}, toolUseId: "f2" })).decision).toBe("allow");
  });
});
