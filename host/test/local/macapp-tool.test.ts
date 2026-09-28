import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, MACAPP_ACTIONS, MACAPP_PERMISSION_PREFIX, STR5, STRMA, macAppBindTarget, type LocalExecRequest, type MacAppReply } from "@synapse/shared";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { createLocalTools } from "../../local/local-tools";
import { classifyTool } from "../../review/classify";
import { hostCallStatic } from "../../review/mac-floor";
import { shouldFence } from "../../runner/discipline";
import { isHiddenActivity, stepText } from "../../presence/activity";
import { ENGINEERING_UP_FRONT_TOOLS, EVERYDAY_UP_FRONT_TOOLS } from "../../engineering/lean-profile";

/**
 * mac-apps, host side: the one deferred `MacApp` tool goes over the same bridge as the other Mac tools, is
 * reviewed on the host_shell surface (reads take the fast path), fences anything read out of an app as
 * untrusted, and turns the Mac's refusals into the Mac card — the first-use permission, and the
 * send/delete/spend/security card that Full auto cannot lift.
 */
const computer = { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex", home: "/Users/alex" };
let now = 1_000;
let ws: string;
let published: LocalExecRequest[];
let entries: Map<string, { id: string; message?: { card?: unknown } }>;
const bots = {
  has: () => true,
  appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e),
  updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e),
  getEntry: (_b: string, id: string) => entries.get(id) ?? null,
} as never;
let slotState: { turnNo: number; nextSendK: number; requestId: string; segment: number; source: string; awaitingUserSelection?: boolean };

beforeEach(() => {
  now = 1_000;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "macapp-"));
  published = [];
  entries = new Map();
  slotState = { turnNo: 3, nextSendK: 0, requestId: "req_1", segment: 0, source: "user" };
});

function setup(o: { mode?: "ask" | "accept-edits" | "full-auto" } = {}) {
  const bridge = new LocalBridge({ hub: { publish: (e: { payload: LocalExecRequest }) => published.push(e.payload) } as never, now: () => now, workspace: ws, idleMs: 50 });
  bridge.register(computer);
  bridge.heartbeat("mac");
  const asks = new LocalAsks({ bots, now: () => now });
  const tools = createLocalTools({ botId: "b1", slot: () => slotState as never, bridge, asks, now: () => now, permMode: () => o.mode ?? "ask", botName: () => "Ava" });
  const macapp = tools.find((t) => t.name === "MacApp")!;
  const answer = (r: { result?: MacAppReply; error?: string }) => {
    const req = published[published.length - 1]!;
    bridge.done(req.execId, r.result ? { exitCode: 0, result: JSON.stringify(r.result) } : { exitCode: null, error: r.error });
  };
  return { bridge, asks, macapp, answer };
}
const reply = (o: Partial<MacAppReply> = {}): MacAppReply => ({ text: "Sent to Sam Lee: “running late”", app: "Messages", action: "messages.send", ms: 120, ...o });
const cards = () => [...entries.values()].map((e) => e.message?.card as { kind: string; action?: string; target?: string; description?: string } | undefined).filter(Boolean);

describe("the MacApp tool surface", () => {
  it("is ONE tool with an action field, and loads behind ToolSearch in both profiles", () => {
    const { macapp } = setup();
    expect(macapp).toBeDefined();
    expect(macapp.description).toBe(STRMA.toolDescription);
    expect(Object.keys(macapp.schema).sort()).toEqual(["action", "app", "end", "limit", "list", "page", "people", "query", "ref", "start", "target", "text", "title", "value"]);
    expect(EVERYDAY_UP_FRONT_TOOLS).not.toContain("MacApp");
    expect(ENGINEERING_UP_FRONT_TOOLS).not.toContain("MacApp");
  });

  it("arrives only with a Mac: it is one of the local tools, not a tool every Bot pays for", () => {
    const { macapp } = setup();
    expect(macapp.readOnly).toBe(false);
  });

  it("says app content is untrusted, and the runner fences it", () => {
    expect(STRMA.toolDescription).toMatch(/untrusted/i);
    expect(shouldFence("mcp__bot__MacApp", {})).toBe(true);
  });

  it("never returns an image, whatever the Mac sends", async () => {
    const { macapp, answer } = setup();
    const p = macapp.handler({ action: "ui.outline", app: "Figma" });
    answer({ result: reply({ text: '[e1] button "Send"', app: "Figma", action: "ui.outline" }) });
    const r = await p;
    expect(r).toEqual({ text: '[e1] button "Send"' });
    expect("images" in r).toBe(false);
  });
});

describe("review (the same Auto-review and surface as the other Mac tools)", () => {
  it("is the host_shell surface; reads take the fast path, actions that change an app are reviewed", () => {
    const read = classifyTool({ toolName: "mcp__bot__MacApp", input: { action: "calendar.list" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" });
    expect(read.surface).toBe("host_shell");
    expect(read.sideEffect).toBe(false);
    const send = classifyTool({ toolName: "mcp__bot__MacApp", input: { action: "messages.send", target: "Sam", text: "hi" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" });
    expect(send.sideEffect).toBe(true);
    expect(send.target?.action).toBe("mac-app");
  });

  it("never puts the typed body in what the reviewer or the card sees", () => {
    const c = classifyTool({ toolName: "mcp__bot__MacApp", input: { action: "messages.send", target: "Sam", text: "my bank code is 1234" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" });
    expect(c.command).not.toContain("1234");
    expect(JSON.stringify(c.target)).not.toContain("1234");
    expect(c.command).toContain("Sam");
  });

  it("the Mac floor agrees: a read is read-only and nothing forces a card here (the MAC decides)", () => {
    const read = hostCallStatic({ toolName: "mcp__bot__MacApp", input: { action: "notes.search", query: "x" }, toolUseId: "t" }, "/workspace");
    expect(read.readOnly).toBe(true);
    expect(read.tierHint).toBe(0);
    const act = hostCallStatic({ toolName: "mcp__bot__MacApp", input: { action: "messages.send" }, toolUseId: "t" }, "/workspace");
    expect(act.readOnly).toBe(false);
    expect(act.forceCard).toBe(false);
  });
});

describe("the Mac's refusals become the Mac card", () => {
  it("a first use asks for the Bot's app permission, naming the Bot", async () => {
    const { macapp, answer } = setup();
    const p = macapp.handler({ action: "calendar.list" });
    answer({ error: `${LOCAL_NEEDS_APPROVAL}${STRMA.permissionRefused}` });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toBe(STR5.localAskWaiting);
    const card = cards()[0]!;
    expect(card.action).toBe("mac-app");
    expect(card.target).toContain(MACAPP_PERMISSION_PREFIX);
    expect(card.description).toBe(STRMA.askPermission("Ava"));
  });

  it("a send cards every time, even in Full auto, and the card names the recipient and the exact text", async () => {
    const { macapp, answer } = setup({ mode: "full-auto" });
    const p = macapp.handler({ action: "messages.send", target: "Sam Lee", text: "running late" });
    answer({ error: `${LOCAL_NEEDS_APPROVAL}Send a message to Sam Lee: “running late”. This sends something to another person and can't be taken back.` });
    const r = await p;
    expect(r.isError).toBe(true);
    const card = cards()[0]!;
    expect(card.description).toContain("Sam Lee");
    expect(card.description).toContain("running late");
    expect(card.target).toBe(macAppBindTarget({ action: "messages.send", target: "Sam Lee", text: "running late" }));
  });

  it("the card's target binds the call but never holds the text itself", async () => {
    const { macapp, answer } = setup({ mode: "full-auto" });
    const p = macapp.handler({ action: "messages.send", target: "Sam Lee", text: "the secret" });
    answer({ error: `${LOCAL_NEEDS_APPROVAL}Send a message to Sam Lee` });
    await p;
    expect(cards()[0]!.target).not.toContain("the secret");
  });

  it("the answered card's approval rides the woken Bot's re-run of exactly that call", async () => {
    const { macapp, asks, answer } = setup();
    const p = macapp.handler({ action: "messages.send", target: "Sam Lee", text: "hi" });
    answer({ error: `${LOCAL_NEEDS_APPROVAL}Send a message to Sam Lee` });
    await p;
    const askId = [...entries.values()].map((e) => (e.message?.card as { askId?: string })?.askId).find(Boolean)!;
    asks.resolve("b1", askId, "once");
    const again = macapp.handler({ action: "messages.send", target: "Sam Lee", text: "hi" });
    answer({ result: reply() });
    expect((await again).text).toContain("Sam Lee");
    expect(published[published.length - 1]!.approvalId).toBeTruthy();
  });

  it("local execution never runs unreviewed: with Auto-review off, an action that changes an app cards first", async () => {
    const bridge = new LocalBridge({ hub: { publish: (e: { payload: LocalExecRequest }) => published.push(e.payload) } as never, now: () => now, workspace: ws, idleMs: 50 });
    bridge.register(computer);
    bridge.heartbeat("mac");
    const tools = createLocalTools({ botId: "b1", slot: () => slotState as never, bridge, asks: new LocalAsks({ bots, now: () => now }), now: () => now, permMode: () => "ask", autoReviewOn: () => false, botName: () => "Ava" });
    const macapp = tools.find((t) => t.name === "MacApp")!;
    const r = await macapp.handler({ action: "notes.create", title: "x", text: "y" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(STR5.localAskWaiting);
    expect(published, "nothing reached the Mac").toHaveLength(0);
    // A read still goes straight through: there is nothing to review.
    void macapp.handler({ action: "notes.search", query: "x" });
    await new Promise((res) => setTimeout(res, 0));
    expect(published).toHaveLength(1);
  });

  it("with no Mac connected it says so instead of hanging", async () => {
    const bridge = new LocalBridge({ hub: { publish: () => {} } as never, now: () => now, workspace: ws });
    const tools = createLocalTools({ botId: "b1", slot: () => slotState as never, bridge, asks: new LocalAsks({ bots, now: () => now }), now: () => now });
    const macapp = tools.find((t) => t.name === "MacApp")!;
    expect((await macapp.handler({ action: "calendar.list" })).text).toBe(STR5.localNotConnected);
  });

  it("an unreadable reply is an error, never a half-read result", async () => {
    const { macapp, bridge } = setup();
    const p = macapp.handler({ action: "calendar.list" });
    bridge.done(published[published.length - 1]!.execId, { exitCode: 0, result: "not json at all" });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unreadable");
  });
});

/**
 * SAFETY: every action a Bot takes in the user's own apps is visible afterwards. Bot tools are hidden from
 * the activity log by default, so MacApp has to opt in — otherwise the actions that need no card (most of
 * them: reads, notes, reminders, an ordinary button) would leave no trace at all.
 */
describe("the activity log", () => {
  it("every MacApp action leaves a step, unlike other bot tools", () => {
    expect(isHiddenActivity("mcp__bot__MacApp")).toBe(false);
    expect(isHiddenActivity("mcp__bot__Browser"), "Browser keeps its chat card instead").toBe(true);
  });

  it("the step says what happened in the user's words, for every action", () => {
    for (const action of MACAPP_ACTIONS) {
      const text = stepText("mcp__bot__MacApp", { action, app: "Mail", target: "Sam Lee", title: "Sync", query: "invoice", value: "cmd+s" });
      expect(text, action).toBeTruthy();
      // The machine name never reaches the user. ("tabs" and "music" are also ordinary English words, so
      // only the dotted names can be checked this way — those are the ones that would read as jargon.)
      if (action.includes(".")) expect(text, `${action} leaks the raw action name`).not.toContain(action);
      expect(text[0], `${action} should start with a capital`).toBe(text[0]!.toUpperCase());
    }
  });

  it("names the person and the app, and never the body that was typed", () => {
    const sent = stepText("mcp__bot__MacApp", { action: "messages.send", target: "Sam Lee", text: "my bank code is 1234" });
    expect(sent).toContain("Sam Lee");
    expect(sent).not.toContain("1234");
    expect(stepText("mcp__bot__MacApp", { action: "ui.press", app: "Figma" })).toContain("Figma");
    expect(stepText("mcp__bot__MacApp", { action: "open", app: "Calendar" }, "", true)).toBe("Opening Calendar");
  });
});
