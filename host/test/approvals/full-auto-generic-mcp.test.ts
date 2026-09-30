import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fullAutoAsk, type FullAutoAction } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import type { ReviewOutcome, ReviewRequest } from "../../review/types";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

/**
 * Bug 275 — Full auto: tools from a generic or custom MCP server weren't classified, so some sends and payments ran
 * with no card (a calendar event with guests, a Stripe payment intent, a *_SEND_* tool). The reviewer stub ALLOWS
 * everything, so every card below comes from the host's own checks.
 */
const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };

interface Opts { user?: string; info?: Record<string, { known?: boolean; description?: string }>; noLimits?: boolean; composioBuiltin?: boolean }

function setup(o: Opts = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Chief of Staff" });
  bots.appendEntry(id, { kind: "message", id: "t1u", role: "user", content: o.user ?? "Set up the meeting and pay the invoice.", clientNonce: "n", createdAt: Date.now() });
  const requests: ReviewRequest[] = [];
  const reviewer: ReviewerLike = { review: async (r) => { requests.push(r); return ALLOW; }, clearCache: () => {} };
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: Date.now() });
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, readFile: () => null, onDeferredResolution: () => {},
    permMode: () => "full-auto", noLimits: () => o.noLimits === true, googleEmail: () => "owner@example.com",
    googleBuiltin: () => true, composioBuiltin: () => o.composioBuiltin ?? true,
    mcpReadOnly: () => false,
    mcpToolInfo: (sid, tool) => ({ known: o.info?.[`${sid}/${tool}`]?.known ?? false, description: o.info?.[`${sid}/${tool}`]?.description ?? null }),
    composioRecipients: async () => ({ recipients: [], channels: [] }),
    sentTo: async () => true,
  });
  let n = 0;
  const run = async (toolName: string, input: Record<string, unknown>) => (await gate.preToolUse(id, { toolName, input, toolUseId: `c${++n}` })).decision;
  return { run, requests };
}

describe("Bug 275: a generic MCP server's sends and payments card in Full auto", () => {
  it("a Composio-style calendar event with guests, from a custom server, cards", async () => {
    const s = setup({ info: { "my_tools/googlecalendar_create_event": { description: "Create a Google Calendar event." } } });
    expect(await s.run("mcp__my_tools__googlecalendar_create_event", { summary: "Sync", start_datetime: "2026-10-02T15:45", attendees: ["guest@partner.example"] })).toBe("ask");
    expect(await s.run("mcp__my_tools__googlecalendar_create_event", { summary: "Sync", event: { guests: [{ email: "guest@partner.example" }] } })).toBe("ask");
    // The same event with nobody else on it stays on the owner's own calendar: no card.
    expect(await s.run("mcp__my_tools__googlecalendar_create_event", { summary: "Focus block", start_datetime: "2026-10-02T15:45" })).toBe("allow");
  });

  it("a payment intent cards, from a custom server or as a Composio slug, even in No limits", async () => {
    const s = setup({ noLimits: true });
    expect(await s.run("mcp__payments__create_payment_intent", { amount: 4000, currency: "usd" })).toBe("ask");
    expect(await s.run("mcp__payments__STRIPE_CREATE_PAYMENT_INTENT", { amount: 4000, currency: "usd", customer: "cus_acme" })).toBe("ask");
    expect(await s.run("mcp__composio_apps__STRIPE_CREATE_PAYMENT_INTENT", { amount: 4000, currency: "usd" })).toBe("ask");
    for (const tool of ["createCharge", "send_invoice", "create_transfer", "issue_refund", "create_payout"]) expect(await s.run(`mcp__payments__${tool}`, { id: "x" }), tool).toBe("ask");
  });

  it("a generic *_SEND_* tool cards, and so does a send hidden behind a Composio meta tool", async () => {
    const s = setup();
    expect(await s.run("mcp__acme_hub__ACME_SEND_NOTICE", { text: "Hi" })).toBe("ask");
    expect(await s.run("mcp__acme_hub__acme_send_notice", { text: "Hi" })).toBe("ask");
    expect(await s.run("mcp__rube__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "x@partner.example" } }] })).toBe("ask");
  });

  it("recipient fields and the tool's own description card a tool whose name looks harmless", async () => {
    const s = setup({ info: { "crm/sync_record": { description: "Syncs a record and sends a copy to the contact." }, "crm/update_note": { description: "Update a note." } } });
    expect(await s.run("mcp__crm__sync_record", { id: "r1" })).toBe("ask");
    expect(await s.run("mcp__crm__update_note", { id: "r1", cc: ["boss@partner.example"] })).toBe("ask");
    expect(await s.run("mcp__crm__update_note", { id: "r1", body: "Called back" })).toBe("allow");
  });

  it("unknown means card: a change on an unknown server with no description cards; a known server's doesn't", async () => {
    expect(await setup().run("mcp__weird__frobnicate_widget", { id: "w1" })).toBe("ask");
    expect(await setup({ info: { "weird/frobnicate_widget": { known: true } } }).run("mcp__weird__frobnicate_widget", { id: "w1" })).toBe("allow");
  });

  it("a plain read stays quiet and never asks the reviewer", async () => {
    const s = setup();
    expect(await s.run("mcp__payments__list_payment_intents", { limit: 10, currency: "usd" })).toBe("allow");
    expect(await s.run("mcp__my_tools__googlecalendar_list_events", { calendar_id: "primary" })).toBe("allow");
    expect(await s.run("mcp__chat__get_channel_history", { channel: "C123" })).toBe("allow");
    expect(await s.run("mcp__mail__search_emails", { query: "invoice" })).toBe("allow");
    expect(s.requests).toHaveLength(0);
  });

  it("an allow-listed send slug on a custom server never skips the card by intent (only the built-in connector can)", async () => {
    const s = setup({ user: "Email Sarah (sarah.lee@example.com) that I'll be ten minutes late." });
    const input = { recipient_email: "sarah.lee@example.com", subject: "Late", body: "Ten minutes late." };
    expect(await s.run("mcp__proxy_1__GMAIL_SEND_EMAIL", input)).toBe("ask");
    expect(s.requests).toHaveLength(0);
    expect(await s.run("mcp__composio_apps__GMAIL_SEND_EMAIL", input)).toBe("allow");
    expect(s.requests).toHaveLength(1);
  });
});

describe("Bug 275: the shared classifier on connector tools", () => {
  const mcp = (tool: string, args: Record<string, unknown> = {}, meta?: { known: boolean; description?: string | null }): FullAutoAction => ({ kind: "tool", action: "mcp", args: { server: "x", tool, arguments: args }, ...(meta ? { mcp: meta } : {}) });
  const ctx = { home: "/Users/alex", workspaces: ["/workspace"] };
  const cat = (a: FullAutoAction) => { const r = fullAutoAsk(a, ctx); return r.ask ? r.category : null; };

  it("money words beyond 'pay'", () => {
    for (const t of ["create_payment_intent", "charge_card", "create_invoice", "create_transfer", "create_refund", "create_payout", "createSubscription", "place_order"]) expect(cat(mcp(t)), t).toBe("money");
    expect(cat(mcp("update_record", { amount: 10 }, { known: true, description: "Update a record." }))).toBe("money");
    expect(cat({ kind: "tool", action: "composio_write", args: { tool: "STRIPE_CREATE_PAYMENT_INTENT", arguments: { amount: 1 } } })).toBe("money");
    expect(cat({ kind: "tool", action: "composio_write", args: { tool: "PAYPAL_CREATE_PAYOUT", arguments: {} } })).toBe("money");
  });

  it("sends, posts, invites and shares", () => {
    for (const t of ["send_message", "SLACK_SEND_MESSAGE", "invite_user", "share_document", "publish_post", "add_attendee"]) expect(cat(mcp(t)), t).toBe("send");
    for (const k of ["to", "cc", "bcc", "attendees", "guests", "recipients", "email", "channel"]) expect(cat(mcp("update_item", { [k]: "a@b.example" }, { known: true, description: "Update an item." })), k).toBe("send");
  });

  it("deletes", () => {
    for (const t of ["delete_file", "remove_member", "PurgeCache", "drop_table"]) expect(cat(mcp(t)), t).toBe("destruction");
  });

  it("reads stay quiet, unless their own description says otherwise", () => {
    for (const t of ["list_payments", "get_invoice", "search_messages", "fetch_emails", "list_removed_items", "get_channel_history"]) expect(cat(mcp(t, { channel: "C1" })), t).toBeNull();
    expect(cat(mcp("get_quote", {}, { known: false, description: "Sends the quote to the customer by email." }))).toBe("send");
    // A read that carries message text is not a read.
    expect(cat(mcp("get_thread", { channel: "C1", text: "hi all" }))).toBe("send");
  });

  it("an unknown change cards and No limits doesn't lift it; a described harmless change runs", () => {
    expect(fullAutoAsk(mcp("frobnicate"), ctx)).toMatchObject({ ask: true, rule: "send.unknown-tool" });
    expect(fullAutoAsk(mcp("frobnicate"), { ...ctx, noLimits: true }).ask).toBe(true);
    expect(fullAutoAsk(mcp("send_message"), { ...ctx, noLimits: true }).ask).toBe(false); // bug 258 unchanged
    expect(cat(mcp("frobnicate", {}, { known: false, description: "Rotate the widget in the local cache." }))).toBeNull();
  });
});

describe("Bug 275: the approval eval's generic-MCP cases card deterministically, before any model", () => {
  const cases = readFileSync(path.resolve(__dirname, "../../evals/reviewer/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; user: string; mustBlock?: boolean; target?: { action: string; arguments: { server: string; tool: string; arguments: Record<string, unknown> } } });
  const mcpCases = cases.filter((c) => c.target?.action === "mcp");
  it("has them", () => expect(mcpCases.map((c) => c.id)).toEqual(["FA16", "FA17", "FA18"]));
  for (const c of mcpCases) {
    it(`${c.id} cards with an allow-everything reviewer`, async () => {
      const s = setup({ user: c.user });
      const t = c.target!.arguments;
      expect(c.mustBlock).toBe(true);
      expect(await s.run(`mcp__${t.server}__${t.tool}`, t.arguments)).toBe("ask");
    });
  }
});
