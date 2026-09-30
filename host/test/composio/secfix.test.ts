import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { composioToolReadOnly, STRX, type ApprovalCardView, type SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type GateDeps, type ReviewerLike } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { createComposioServices, runComposioToolForFake } from "../../composio/module";
import { fakeComposio } from "../../composio/fake-composio";
import { ComposioApi } from "../../composio/api";
import { SseHub } from "../../gateway/sse-hub";
import { classifyTool, mcpToolChanges } from "../../review/classify";
import type { ReviewOutcome } from "../../review/types";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const KEY = "ak_test_Zq81xYt4Lm0pRw2vK";
const ALLOW: ReviewOutcome = { kind: "allow", stage: "exact", verdict: null };
const base = { workspace: "/workspace", hostPrivate: "/home/box/.host" };

describe("secfix 400: quiet reads are a fixed allow-list; only listed slugs run", () => {
  it("a read-sounding slug that isn't on the list is a card (GITHUB_REREQUEST_A_CHECK_SUITE, GMAIL_LIST_AND_SEND)", () => {
    for (const t of ["GITHUB_REREQUEST_A_CHECK_SUITE", "GMAIL_GET_AND_FORWARD", "SLACK_LIST_THINGS_NEW", "GITHUB_LIST_EVERYTHING_UNKNOWN"]) {
      expect(composioToolReadOnly(t), t).toBe(false);
      expect(classifyTool({ toolName: `mcp__composio_apps__${t}`, input: {}, toolUseId: "t" }, { ...base, composioBuiltin: true }).target?.action, t).toBe("composio_write");
    }
    expect(composioToolReadOnly("GMAIL_FETCH_EMAILS")).toBe(true);
  });

  it("a slug missing from the app's tool list is refused, after one refresh, and never executed", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const hub = new SseHub();
    const bots = new BotService({ cfg, hub, settings });
    const a = bots.create({ origin: "user", kickstart: false, name: "Scout" });
    const fake = fakeComposio({ activateAfter: 1 });
    const c = createComposioServices({ cfg, hub, bots, now: () => 1 }, { fetch: fake.fetch, pollMs: 60_000, storeKey: randomBytes(32) });
    await c.setKey(KEY); c.acceptDisclosure(); await c.connect("gmail"); await c.poll("gmail"); c.setGrant("gmail", a, true);
    const out = await runComposioToolForFake(c, a, "mcp__composio_apps__GMAIL_MADE_UP_EXFIL", {});
    expect(out).toContain("No such tool");
    expect(fake.requests.filter((r) => r.path.startsWith("/tools?")).length).toBe(2); // listed once, refreshed once
    expect(fake.requests.some((r) => r.path.startsWith("/tools/execute/"))).toBe(false);
    expect(await runComposioToolForFake(c, a, "mcp__composio_apps__GMAIL_SEND_EMAIL", {})).toContain("\"ok\":true");
    c.stop();
  });
});

describe("secfix 401: the sign-in link must be an https Composio link", () => {
  const api = (redirect: string) => new ComposioApi({ key: () => KEY, fetch: (async () => new Response(JSON.stringify({ redirect_url: redirect, connected_account_id: "ca_1" }), { status: 201 })) as FetchLike });
  it("accepts composio.dev hosts and refuses anything else", async () => {
    await expect(api("https://connect.composio.dev/link/lk_1").link("ac_1", "u")).resolves.toMatchObject({ accountId: "ca_1" });
    await expect(api("https://backend.composio.dev/api/v3/s/abc").link("ac_1", "u")).resolves.toBeTruthy();
    for (const bad of ["https://evil.example.com/composio.dev", "https://composio.dev.evil.example/x", "http://connect.composio.dev/x", "https://user@evil.example/x", "javascript:alert(1)"]) {
      await expect(api(bad).link("ac_1", "u"), bad).rejects.toThrow("sign-in link");
    }
  });
});

describe("secfix 402: the built-in identity, not only the name", () => {
  it("mcp__composio_apps__ is the Composio classifier only when this Bot's server is the built-in one", () => {
    // A name that isn't a Composio slug, so only the identity flag decides (a slug is Composio either way: bug 404).
    const call = { toolName: "mcp__composio_apps__lookup", input: {}, toolUseId: "t" };
    expect(classifyTool(call, { ...base, composioBuiltin: true }).target?.action).toBe("composio_write");
    expect(classifyTool(call, { ...base, composioBuiltin: false }).target?.action).toBe("mcp");
  });
});

function gateSetup(d: Partial<GateDeps> = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const me = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const slot = newSlot({ botId: me, requestId: "req_1", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const reviewer: ReviewerLike = { review: async () => ALLOW, clearCache: () => {} };
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {}, permMode: () => "ask", ...d });
  settings.update({ autoReviewEnabled: false });
  const cards = () => bots.tail(me, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval);
  return { gate, me, cards };
}

describe("secfix 403 (pre-existing): an older custom Composio server, and write-verb MCP tools with Auto-review off", () => {
  const hosts: Record<string, string> = { composio: "connect.composio.dev", "composio-2": "backend.composio.dev", notes: "notes.example.com" };
  const serverHost = (id: string) => hosts[id] ?? null;

  it("every tool of a server whose URL is a Composio host goes through the Composio classifier", () => {
    const cls = (t: string) => classifyTool({ toolName: `mcp__composio__${t}`, input: {}, toolUseId: "t" }, { ...base, mcpServerHost: serverHost, mcpReadOnly: () => true });
    expect(cls("GMAIL_SEND_EMAIL").target?.action).toBe("composio_write");
    expect(cls("GMAIL_FETCH_EMAILS").surface).toBeNull();
    expect(classifyTool({ toolName: "mcp__composio-2__SLACK_SEND_MESSAGE", input: {}, toolUseId: "t" }, { ...base, mcpServerHost: serverHost }).target?.action).toBe("composio_write");
  });

  it("in Ask mode with Auto-review off, GMAIL_SEND_EMAIL on the custom Composio server raises a card", async () => {
    const s = gateSetup({ mcpServerHost: serverHost });
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__composio__GMAIL_SEND_EMAIL", input: { recipient_email: "friend@example.com" }, toolUseId: "c1" })).decision).toBe("ask");
    void s.gate.canUseTool(s.me, { toolName: "mcp__composio__GMAIL_SEND_EMAIL", input: { recipient_email: "friend@example.com" }, toolUseId: "c1" }, new AbortController().signal);
    expect(s.cards()[0]?.locationLine).toBe(STRX.cardLocation("Gmail"));
  });

  it("with Auto-review off, any MCP tool named like a send, delete, pay, post, create or update cards; a read doesn't", async () => {
    const s = gateSetup({ mcpServerHost: serverHost });
    for (const [i, t] of ["create_note", "updateNote", "delete_page", "send_invoice", "post_comment", "pay_bill"].entries()) {
      expect((await s.gate.preToolUse(s.me, { toolName: `mcp__notes__${t}`, input: {}, toolUseId: `w${i}` })).decision, t).toBe("ask");
      const perm = s.gate.canUseTool(s.me, { toolName: `mcp__notes__${t}`, input: {}, toolUseId: `w${i}` }, new AbortController().signal);
      s.gate.resolve(s.me, s.cards().at(-1)!.approvalId, "deny");
      await perm;
    }
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__notes__list_notes", input: {}, toolUseId: "r1" })).decision).toBe("allow");
    // Bug 439: a tool Synapse can't judge (no read name, no description, a server it doesn't know) cards in Full auto,
    // so it cards here too: Ask is never weaker than Full auto.
    expect((await s.gate.preToolUse(s.me, { toolName: "mcp__notes__notebook_summary", input: {}, toolUseId: "r2" })).decision).toBe("ask");
  });
});

describe("secfix 404: change stems, the refresh cooldown, and Composio servers without a Composio host", () => {
  it("catches inflected and glued change words", () => {
    for (const t of ["sends", "sending_mail", "deleted_items_purge", "sendmail", "bulkdelete", "HTTPSend", "respond_to_invite", "decline_event", "accept_invite", "reset_password",
      "clear_cache", "unsubscribe", "subscribe_list", "import_contacts", "sync_now", "dm_user", "sms_send", "message_user", "schedule_meeting", "assign_issue", "mark_read",
      "restore_backup", "kick_member", "ban_user", "approve_pr", "merge_pr", "publish_post", "submit_form", "execute_query", "run_job", "trigger_workflow", "label_thread", "star_repo"]) {
      expect(mcpToolChanges(t), t).toBe(true);
    }
  });

  it("keeps plain reads quiet (and says so where a read name carries a change noun: that errs toward a card)", () => {
    for (const t of ["list_notes", "get_page", "search_docs", "read_file", "fetch_rows", "find_user", "view_board", "get_settings", "get_address", "list_repositories", "read_markdown", "get_runtime"]) {
      expect(mcpToolChanges(t), t).toBe(false);
    }
    // Deliberate: a change word as a noun still cards (safe side).
    expect(mcpToolChanges("get_schedule_list")).toBe(true);
    expect(mcpToolChanges("list_messages")).toBe(true);
  });

  it("refreshes an app's tool list for an unlisted slug at most once a minute", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const hub = new SseHub();
    const bots = new BotService({ cfg, hub, settings });
    const a = bots.create({ origin: "user", kickstart: false, name: "Scout" });
    const fake = fakeComposio({ activateAfter: 1 });
    let t = 1_000;
    const c = createComposioServices({ cfg, hub, bots, now: () => t }, { fetch: fake.fetch, pollMs: 60_000, storeKey: randomBytes(32) });
    await c.setKey(KEY); c.acceptDisclosure(); await c.connect("gmail"); await c.poll("gmail"); c.setGrant("gmail", a, true);
    const lists = () => fake.requests.filter((r) => r.path.startsWith("/tools?")).length;
    for (let i = 0; i < 5; i++) await runComposioToolForFake(c, a, `mcp__composio_apps__GMAIL_MADE_UP_${i}`, {});
    expect(lists()).toBe(2); // the first list, plus one refresh
    t += 61_000;
    await runComposioToolForFake(c, a, "mcp__composio_apps__GMAIL_MADE_UP_X", {});
    expect(lists()).toBe(3);
    c.stop();
  });

  it("a server whose command, args or URL mention composio, or whose tools are Composio slugs, is classified as Composio", () => {
    const composioish = (id: string) => id === "npx-composio";
    const cls = (server: string, tool: string, o: Record<string, unknown> = {}) => classifyTool({ toolName: `mcp__${server}__${tool}`, input: {}, toolUseId: "t" }, { ...base, mcpReadOnly: () => true, ...o });
    expect(cls("npx-composio", "send_it", { mcpServerComposio: composioish }).target?.action).toBe("composio_write");
    expect(cls("npx-composio", "GMAIL_FETCH_EMAILS", { mcpServerComposio: composioish }).surface).toBeNull();
    // A proxy on an IP, trusted read-only by the user: the slug shape alone routes it.
    expect(cls("proxy-10-0-0-5", "GMAIL_SEND_EMAIL").target?.action).toBe("composio_write");
    expect(cls("proxy-10-0-0-5", "SLACK_CHAT_POST_MESSAGE").target?.action).toBe("composio_write");
    expect(cls("proxy-10-0-0-5", "GMAIL_FETCH_EMAILS").surface).toBeNull();
    // Not a Composio slug: the ordinary path (here trusted read-only, so quiet).
    expect(cls("notes", "list_notes").surface).toBeNull();
    expect(cls("notes", "FOO_BAR").surface).toBeNull();
  });
});
