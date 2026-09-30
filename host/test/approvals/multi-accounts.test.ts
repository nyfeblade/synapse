import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalCardView, SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type AccountResolution, type ReviewerLike } from "../../approvals/approval-gate";
import { trustedSendOk } from "../../approvals/smarter";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { WakeSource } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { accountFloor, accountsNamed, fullAutoIntentFloor, recipientsOf } from "../../review/full-auto-intent";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// 4.3b: the account a send uses is the host's resolution, the card names it, the Full-auto intent check holds the
// Bot to the account the owner named, and every connected address is "yourself".

const ME = "me@example.com";
const WORK = "work@acme.example";
const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };

function setup(o: { user?: string; granted?: string[]; mode?: "full-auto" | "ask"; source?: WakeSource } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Chief of Staff" });
  bots.appendEntry(id, { kind: "message", id: "t0u", role: "user", content: o.user ?? "Email Sarah (sarah.lee@example.com) from my work account that I'll be late.", clientNonce: "n0", createdAt: Date.now() });
  const reviewer: ReviewerLike = { review: async () => ALLOW, clearCache: () => {} };
  const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: o.source ?? "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: Date.now() });
  const granted = o.granted ?? [ME, WORK];
  // The host's resolution, as phase5/wire.ts does it: among this Bot's grants only, never a guess.
  const accountFor = (_b: string, call: { input: Record<string, unknown> }, target: { action: string }): AccountResolution | null => {
    if (target.action !== "google_write") return null;
    const asked = typeof call.input.account === "string" ? call.input.account.toLowerCase() : "";
    const hit = asked ? granted.find((g) => g === asked) : granted.length === 1 ? granted[0] : undefined;
    if (!hit) return { error: asked ? `You can't use the Google account “${asked}”.` : "You can use more than one Google account." };
    return { label: hit, granted, all: [ME, WORK] };
  };
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, readFile: () => null, onDeferredResolution: () => {},
    permMode: () => o.mode ?? "full-auto", ownerEmails: () => [ME, WORK], googleBuiltin: () => true, accountFor,
    googleDraftPreview: async () => ({ error: "no drafts here" }),
  });
  let n = 0;
  const run = async (toolName: string, input: Record<string, unknown>) => gate.preToolUse(id, { toolName, input, toolUseId: `c${++n}` });
  const cards = () => bots.tail(id, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval);
  return { run, gate, id, cards };
}

const SARAH = { to: "sarah.lee@example.com", subject: "Running late", body: "Ten minutes late, sorry." };

describe("4.3b: Full auto holds the Bot to the account the owner named", () => {
  it("\"email Sarah from my work account\": the work account runs, the personal one cards and says why", async () => {
    const s = setup();
    expect((await s.run("mcp__google__gmail_send", { ...SARAH, account: WORK })).decision).toBe("allow");
    const wrong = await s.run("mcp__google__gmail_send", { ...SARAH, account: ME });
    expect(wrong).toMatchObject({ decision: "ask" });
    expect((wrong as { reason: string }).reason).toBe(`You asked for ${WORK}, but this uses ${ME}, so it needs your OK.`);
  });

  it("with two accounts and none named, the Bot's own pick of account cards", async () => {
    const s = setup({ user: "Email Sarah (sarah.lee@example.com) that I'll be late." });
    const d = await s.run("mcp__google__gmail_send", { ...SARAH, account: WORK });
    expect(d).toMatchObject({ decision: "ask" });
    expect((d as { reason: string }).reason).toMatch(/didn't say which account/);
  });

  it("one granted account (personal) while the owner asked for work: a mismatch cards", async () => {
    const s = setup({ granted: [ME] });
    const d = await s.run("mcp__google__gmail_send", SARAH); // implied: the only granted one
    expect(d).toMatchObject({ decision: "ask" });
    expect((d as { reason: string }).reason).toContain(`You asked for ${WORK}`);
  });

  it("an ungranted or unnamed-among-several account is refused before any card", async () => {
    const s = setup({ granted: [ME] });
    expect(await s.run("mcp__google__gmail_send", { ...SARAH, account: WORK })).toMatchObject({ decision: "deny" });
    const two = setup();
    expect(await two.run("mcp__google__gmail_send", SARAH)).toMatchObject({ decision: "deny", reason: "You can use more than one Google account." });
    expect(two.cards()).toHaveLength(0);
  });

  it("the card names the sending account", async () => {
    const s = setup({ mode: "ask" });
    const call = { toolName: "mcp__google__gmail_send", input: { ...SARAH, account: WORK }, toolUseId: "tu-1" };
    expect((await s.gate.preToolUse(s.id, call)).decision).toBe("ask");
    const perm = s.gate.canUseTool(s.id, call, new AbortController().signal);
    const card = s.cards().at(-1)!;
    expect(card.locationLine).toBe(`From ${WORK}`);
    s.gate.resolve(s.id, card.approvalId, "deny");
    await perm;
  });

  it("the sending account is never counted as a recipient", () => {
    expect(recipientsOf({ action: "google_write", arguments: { tool: "gmail_send", ...SARAH, account: WORK }, enrichment: null })).toEqual(["sarah.lee@example.com"]);
  });
});

describe("4.3b: every connected address is \"yourself\"", () => {
  it("a send to the owner's other account is a trusted self-send; a stranger still cards", async () => {
    const s = setup({ mode: "ask", user: "Send the notes to my work address." });
    expect((await s.run("mcp__google__gmail_send", { to: WORK, subject: "Notes", body: "n", account: ME })).decision).toBe("allow");
    expect((await s.run("mcp__google__gmail_send", { to: "stranger@else.example", subject: "Notes", body: "n", account: ME })).decision).toBe("ask");
  });

  it("a draft only to either of the owner's addresses needs no card", async () => {
    const s = setup({ mode: "ask" });
    expect((await s.run("mcp__google__gmail_draft", { to: WORK, subject: "Note to self", body: "x", account: ME })).decision).toBe("allow");
    expect((await s.run("mcp__google__gmail_draft", { to: ME, subject: "Note to self", body: "x", account: WORK })).decision).toBe("allow");
  });

  it("trustedSendOk: both addresses count as self on any wake; a trusted other needs the account check", () => {
    const target = { action: "google_write", arguments: { tool: "gmail_send", to: WORK }, enrichment: null };
    const scope = (r: string[]) => ({ recipients: r, channels: [], targets: [] });
    expect(trustedSendOk({ target, builtin: true, scope: scope([WORK, ME]), self: [ME, WORK], trusted: [], origin: "routine", source: "routine" })).toBe(true);
    expect(trustedSendOk({ target, builtin: true, scope: scope(["dana@x.example"]), self: [ME, WORK], trusted: ["dana@x.example"], origin: "user", source: "user", accountOk: false })).toBe(false);
    expect(trustedSendOk({ target, builtin: true, scope: scope(["dana@x.example"]), self: [ME, WORK], trusted: ["dana@x.example"], origin: "user", source: "user", accountOk: true })).toBe(true);
  });
});

describe("4.3b: which account the owner named", () => {
  it("by its address, or a word only that account carries (never a recipient's domain, never gmail)", () => {
    const all = [ME, WORK, "sam.personal@gmail.com"];
    expect(accountsNamed(all, "email John from my work account")).toEqual([WORK]);
    expect(accountsNamed(all, "send it from work@acme.example")).toEqual([WORK]);
    expect(accountsNamed(all, "use the acme one")).toEqual([WORK]);
    expect(accountsNamed(all, "from my personal gmail")).toEqual(["sam.personal@gmail.com"]);
    expect(accountsNamed(all, "email dana@acme.example about lunch")).toEqual([]);
    expect(accountsNamed(all, "send it from gmail")).toEqual([]);
  });

  it("accountFloor: one account is never a question; a match passes; a mismatch or no choice among several cards", () => {
    expect(accountFloor({ used: ME, granted: [ME], all: [ME] }, "email John")).toBeNull();
    expect(accountFloor({ used: WORK, granted: [ME, WORK], all: [ME, WORK] }, "email John from work")).toBeNull();
    expect(accountFloor({ used: ME, granted: [ME, WORK], all: [ME, WORK] }, "email John from work")).toMatch(/^You asked for work@acme\.example/);
    expect(accountFloor({ used: ME, granted: [ME, WORK], all: [ME, WORK] }, "email John")).toMatch(/didn't say which account/);
    expect(accountFloor({ used: ME, granted: [ME], all: [ME, WORK] }, "email John")).toBeNull();
  });

  it("the intent floor puts the account rule before the reviewer", () => {
    const target = { action: "google_write", arguments: { tool: "gmail_send", ...SARAH, account: ME }, enrichment: null };
    const base = { target, source: "user" as const, origin: "user" as const, userMessages: ["Email Sarah (sarah.lee@example.com) from my work account."], outside: { any: false, shingles: new Set<number>(), heads: [], emails: new Set<string>(), links: new Set<string>() }, self: [ME, WORK], resolved: { recipients: [], channels: [] }, sentForRequest: 0 };
    expect(fullAutoIntentFloor({ ...base, account: { used: ME, granted: [ME, WORK], all: [ME, WORK] } })).toContain(`You asked for ${WORK}`);
    expect(fullAutoIntentFloor({ ...base, target: { ...target, arguments: { ...target.arguments, account: WORK } }, account: { used: WORK, granted: [ME, WORK], all: [ME, WORK] } })).toBeNull();
  });
});
