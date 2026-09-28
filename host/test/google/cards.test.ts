import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalCardView, SendMessageEntry } from "@synapse/shared";
import { ApprovalGate } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { GoogleApi } from "../../google/api";
import { googleCardFacts } from "../../google/card-facts";
import { fakeConsent, startFakeGoogle, type FakeGoogle } from "../../google/fake-google";
import { GoogleAuth } from "../../google/oauth";
import { GoogleStore } from "../../google/store";
import { classifyTool } from "../../review/classify";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// Final secfix item 9: cards show what the call really does, fetched host-side.

let g: FakeGoogle;
let api: GoogleApi;
beforeEach(async () => {
  g = await startFakeGoogle();
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "gcards-"));
  const auth = new GoogleAuth({ store: new GoogleStore(path.join(hp, "account.json"), new Uint8Array(randomBytes(32))), endpoints: () => g.endpoints, now: () => 1_000_000 });
  auth.setClient("1-x.apps.googleusercontent.com", "GOCSPX-secret-value");
  await auth.complete(fakeConsent(g, auth.start()));
  api = new GoogleApi({ auth, endpoints: () => g.endpoints });
  g.state.messages.push({ id: "m9", threadId: "t9", from: "Dana Reyes <dana@example.org>", replyTo: "Ops Desk <ops@example.org>", to: "me@example.com", subject: "Invoice", date: "Thu, 17 Sep 2026 10:00:00 -0700", body: "See attached.", messageId: "<m9@example.org>" });
  g.state.files.push({ id: "fo1", name: "Team folder", mimeType: "application/vnd.google-apps.folder", content: "", shared: true });
});
afterEach(() => g.close());

const ALLOW: ReviewOutcome = { kind: "allow", stage: "exact", verdict: null };
function gate() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const me = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const slot = newSlot({ botId: me, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const gt = new ApprovalGate({
    cfg, bots, settings, reviewer: { review: async () => ALLOW, clearCache: () => {} }, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {},
    googleEmail: () => "me@example.com", googleBuiltin: () => true, googleCardFacts: (tool, input) => googleCardFacts(api, tool, input).catch((e: Error) => ({ error: e.message })),
  });
  const cards = () => bots.tail(me, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval);
  return { gt, me, cards };
}
const ask = async (s: ReturnType<typeof gate>, tool: string, input: Record<string, unknown>) => {
  const c = { toolName: `mcp__google__${tool}`, input, toolUseId: `tu-${tool}` };
  expect((await s.gt.preToolUse(s.me, c)).decision).toBe("ask");
  const perm = s.gt.canUseTool(s.me, c, new AbortController().signal);
  return { card: s.cards().at(-1)!, perm };
};

describe("final secfix 9: a reply send shows (and is pinned to) the real recipient", () => {
  it("uses Reply-To when the original message has one", async () => {
    const s = gate();
    const { card, perm } = await ask(s, "gmail_send", { reply_to_id: "m9", subject: "Re: Invoice", body: "Paid." });
    expect(card.summary).toContain("ops@example.org");
    expect(card.summary).not.toContain("the original sender");
    expect(card.details).toContain("To: Ops Desk <ops@example.org>");
    s.gt.resolve(s.me, card.approvalId, "once");
    expect(await perm).toMatchObject({ behavior: "allow", updatedInput: { to: ["Ops Desk <ops@example.org>"] } });
  });

  it("falls back to From; a reply draft to someone else shows them too", async () => {
    const s = gate();
    const send = await ask(s, "gmail_send", { reply_to_id: "m3", subject: "Re: Lunch", body: "Yes." });
    expect(send.card.details).toContain("To: Sam Lee <sam@example.net>");
    s.gt.resolve(s.me, send.card.approvalId, "deny");
    await send.perm;
    const draft = await ask(s, "gmail_draft", { reply_to_id: "m3", subject: "Re: Lunch", body: "Yes." });
    expect(draft.card.summary).toContain("sam@example.net");
  });
});

describe("final secfix 9: calendar_update/delete show the event title and time (fetched host-side)", () => {
  it.each(["calendar_delete", "calendar_update"])("%s", async (tool) => {
    const s = gate();
    const { card } = await ask(s, tool, { id: "e1", ...(tool === "calendar_update" ? { summary: "Moved" } : {}) });
    expect(card.summary).toContain("Team sync");
    expect(card.details).toContain("Event: “Team sync”");
    expect(card.details).toContain("2026-09-21T10:00:00-07:00 → 2026-09-21T10:30:00-07:00");
  });

  it("an event that can't be fetched denies instead of a blind card", async () => {
    const s = gate();
    const d = await s.gt.preToolUse(s.me, { toolName: "mcp__google__calendar_delete", input: { id: "nope" }, toolUseId: "x" });
    expect(d.decision).toBe("deny");
    expect(s.cards()).toHaveLength(0);
  });
});

describe("final secfix 9: drive_upload shows the target folder name and its sharing state", () => {
  it("a shared folder", async () => {
    const s = gate();
    const { card } = await ask(s, "drive_upload", { path: "r.md", folder: "fo1" });
    expect(card.summary).toContain("Team folder");
    expect(card.details).toContain("Folder: Team folder");
    expect(card.details).toMatch(/Sharing: shared with other people/);
  });

  it("no folder: My Drive, private", async () => {
    const s = gate();
    const { card } = await ask(s, "drive_upload", { path: "r.md" });
    expect(card.details).toContain("Folder: My Drive");
    expect(card.details).toMatch(/Sharing: private/);
  });
});

describe("final secfix 9: UpdateAgent with description + model shows both", () => {
  it("the summary names both changes and the target (fingerprint) carries the model", () => {
    const c = classifyTool({ toolName: "mcp__bot__UpdateAgent", input: { agent_id: "b2", description: "Be terse.", model: "claude-opus-5" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host", botId: "b1" });
    expect(c.summary).toContain("Be terse.");
    expect(c.summary).toContain("claude-opus-5");
    expect(c.target?.arguments.model).toBe("claude-opus-5");
  });
});
