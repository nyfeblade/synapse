import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_PERMISSION_PREFIX, LOCAL_NEEDS_APPROVAL, STR5, STRB, browserBindTarget, type BrowserReply, type LocalExecRequest } from "@synapse/shared";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { BrowserCards } from "../../local/browser-cards";
import { createLocalTools } from "../../local/local-tools";
import { classifyTool } from "../../review/classify";
import { hostCallStatic } from "../../review/mac-floor";
import { shouldFence } from "../../runner/discipline";
import { loadPrompt } from "../../prompts";
import { ENGINEERING_UP_FRONT_TOOLS, EVERYDAY_UP_FRONT_TOOLS } from "../../engineering/lean-profile";

/**
 * mac-browser, host side: the one deferred `Browser` tool goes over the same bridge as the Mac tools, is reviewed on
 * the host_shell surface (reads take the fast path), fences page text as untrusted, turns the Mac's refusals into the
 * Mac card (first-use permission, consequential action), and keeps a session card + usage (screenshots apart).
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
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "brw-"));
  published = [];
  entries = new Map();
  slotState = { turnNo: 3, nextSendK: 0, requestId: "req_1", segment: 0, source: "user" };
});

function setup(o: { mode?: "ask" | "accept-edits" | "full-auto"; review?: boolean; lastUser?: string } = {}) {
  const bridge = new LocalBridge({ hub: { publish: (e: { payload: LocalExecRequest }) => published.push(e.payload) } as never, now: () => now, workspace: ws, idleMs: 50 });
  bridge.register(computer);
  bridge.heartbeat("mac");
  const asks = new LocalAsks({ bots, now: () => now });
  const cards = new BrowserCards({ bots, now: () => now });
  const tools = createLocalTools({
    botId: "b1", slot: () => slotState as never, bridge, asks, now: () => now, permMode: () => o.mode ?? "ask", autoReviewOn: () => o.review ?? true,
    botName: () => "Ava", lastUserMessage: () => o.lastUser ?? "find me a flight", browserCards: cards,
  });
  const browser = tools.find((t) => t.name === "Browser")!;
  /** Answer the latest request the way the Mac would. */
  const answer = (r: { result?: BrowserReply; error?: string }) => {
    const req = published[published.length - 1]!;
    bridge.done(req.execId, r.result ? { exitCode: 0, result: JSON.stringify(r.result) } : { exitCode: null, error: r.error });
  };
  return { bridge, asks, cards, browser, answer };
}
const reply = (o: Partial<BrowserReply> = {}): BrowserReply => ({ text: 'Page: Home — https://x.test/\n[e1] button "Go"', title: "Home", url: "https://x.test/", session: "w_1", steps: 1, status: "active", ...o });
const cardsOf = (kind: string) => [...entries.values()].map((e) => e.message?.card as { kind: string } | undefined).filter((c) => c?.kind === kind);

describe("the Browser tool surface", () => {
  it("is one tool with an action field, and loads behind ToolSearch in both profiles", () => {
    const { browser } = setup();
    expect(browser).toBeDefined();
    expect(browser.description).toBe(STRB.toolDescription);
    expect(browser.description.length).toBeLessThan(700);
    expect(Object.keys(browser.schema).sort()).toEqual(["action", "ref", "submit", "text", "url", "value"]);
    expect(EVERYDAY_UP_FRONT_TOOLS).not.toContain("Browser");
    expect(ENGINEERING_UP_FRONT_TOOLS).not.toContain("Browser");
  });

  it("says page text is untrusted, and the runner fences it", () => {
    expect(STRB.toolDescription).toMatch(/untrusted/i);
    expect(shouldFence("mcp__bot__Browser", {})).toBe(true);
  });

  it("says the window is on the user's Mac, and that logins go through Sign in to sites (bug-log 150)", () => {
    expect(STRB.toolDescription).toMatch(/on the user's Mac/);
    expect(STRB.toolDescription).toMatch(/not your computer/i);
    expect(STRB.toolDescription).toContain(STRB.signinButton);
    const base = loadPrompt("base.md");
    expect(base).toMatch(/Browser tool[^\n]*Chrome on the user's Mac/);
    expect(base).toContain(STRB.signinButton);
  });
});

describe("review (the same Auto-review and modes as the Mac tools)", () => {
  it("is the host_shell surface; reads take the fast path, page-changing actions are reviewed", () => {
    const c = classifyTool({ toolName: "mcp__bot__Browser", input: { action: "click", ref: "e3" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" });
    expect(c).toMatchObject({ surface: "host_shell", sideEffect: true, target: { action: "browser", arguments: { action: "click", ref: "e3" } } });
    expect(classifyTool({ toolName: "mcp__bot__Browser", input: { action: "snapshot" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" }).sideEffect).toBe(false);
    expect(hostCallStatic({ toolName: "mcp__bot__Browser", input: { action: "snapshot" }, toolUseId: "t" }, "/workspace")).toMatchObject({ readOnly: true, tierHint: 0, forceCard: false });
    expect(hostCallStatic({ toolName: "mcp__bot__Browser", input: { action: "type", ref: "e3", text: "hi", submit: true }, toolUseId: "t" }, "/workspace")).toMatchObject({ readOnly: false, tierHint: 2 });
  });

  it("never puts typed text in the review target or the card (length + hash only)", () => {
    const c = classifyTool({ toolName: "mcp__bot__Browser", input: { action: "type", ref: "e3", text: "hunter2" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" });
    expect(JSON.stringify(c)).not.toContain("hunter2");
    expect(browserBindTarget({ action: "type", ref: "e3", text: "hunter2" })).not.toContain("hunter2");
  });

  it("Ask mode with Auto-review off: a page-changing action gets the Mac card first (never unreviewed); a read doesn't", async () => {
    const { browser } = setup({ mode: "ask", review: false });
    const r = await browser.handler({ action: "click", ref: "e3" });
    expect(r).toMatchObject({ isError: true, text: STR5.localAskWaiting });
    expect(published).toEqual([]);
    expect(cardsOf("local-tool-permission")).toMatchObject([{ action: "browser", target: browserBindTarget({ action: "click", ref: "e3" }) }]);
    const read = setup({ mode: "ask", review: false });
    const p = read.browser.handler({ action: "snapshot" });
    await new Promise((res) => setTimeout(res, 5));
    read.answer({ result: reply() });
    expect((await p).isError).toBeFalsy();
  });
});

describe("the bridge request", () => {
  it("carries the action, the Bot's name, the turn and no permission of its own", async () => {
    const { browser, answer } = setup();
    const p = browser.handler({ action: "open", url: "https://x.test/" });
    await new Promise((res) => setTimeout(res, 5));
    expect(published[0]).toMatchObject({ op: "browser", botId: "b1", approvalId: null, botName: "Ava", browser: { action: "open", url: "https://x.test/" }, explicit: false, turn: "req_1", userTurn: true });
    answer({ result: reply() });
    expect(await p).toMatchObject({ text: reply().text });
  });

  it("marks typing explicit only when the user gave that exact value in this turn's message", async () => {
    const said = setup({ lastUser: "log in with my password hunter2 please" });
    void said.browser.handler({ action: "type", ref: "e9", text: "hunter2" });
    await new Promise((res) => setTimeout(res, 5));
    expect(published[published.length - 1]).toMatchObject({ explicit: true });
    const not = setup({ lastUser: "log in for me" });
    void not.browser.handler({ action: "type", ref: "e9", text: "hunter2" });
    await new Promise((res) => setTimeout(res, 5));
    expect(published[published.length - 1]).toMatchObject({ explicit: false });
    slotState.source = "routine";
    const routine = setup({ lastUser: "hunter2" });
    void routine.browser.handler({ action: "type", ref: "e9", text: "hunter2" });
    await new Promise((res) => setTimeout(res, 5));
    expect(published[published.length - 1]).toMatchObject({ explicit: false, userTurn: false });
  });
});

describe("the Mac's refusals become the Mac card", () => {
  it("first use: the per-Bot browser permission card, bound to this call", async () => {
    const { browser, answer } = setup();
    const p = browser.handler({ action: "open", url: "https://x.test/" });
    await new Promise((res) => setTimeout(res, 5));
    answer({ error: `${LOCAL_NEEDS_APPROVAL}${STRB.permissionRefused}` });
    expect(await p).toMatchObject({ isError: true, text: STR5.localAskWaiting });
    expect(slotState.awaitingUserSelection).toBe(true);
    expect(cardsOf("local-tool-permission")).toMatchObject([{ action: "browser", target: `${BROWSER_PERMISSION_PREFIX}${browserBindTarget({ action: "open", url: "https://x.test/" })}`, description: STRB.permissionAsk("Ava") }]);
  });

  it("a consequential action: the card says what and where", async () => {
    const { browser, answer } = setup({ mode: "full-auto" });
    const p = browser.handler({ action: "click", ref: "e7" });
    await new Promise((res) => setTimeout(res, 5));
    answer({ error: `${LOCAL_NEEDS_APPROVAL}${STRB.consequential("Click “Pay now”", "shop.test")}` });
    expect(await p).toMatchObject({ isError: true });
    expect(cardsOf("local-tool-permission")).toMatchObject([{ action: "browser", target: browserBindTarget({ action: "click", ref: "e7" }), description: STRB.consequential("Click “Pay now”", "shop.test") }]);
  });

  it("the re-run after the card carries the recorded approval", async () => {
    const { browser, answer, asks } = setup();
    const p = browser.handler({ action: "click", ref: "e7" });
    await new Promise((res) => setTimeout(res, 5));
    answer({ error: `${LOCAL_NEEDS_APPROVAL}${STRB.consequential("Click “Pay now”", "shop.test")}` });
    await p;
    const card = cardsOf("local-tool-permission")[0] as unknown as { askId: string };
    asks.resolve("b1", card.askId, "once");
    const again = browser.handler({ action: "click", ref: "e7" });
    await new Promise((res) => setTimeout(res, 5));
    expect(published[published.length - 1]!.approvalId).toBe(card.askId);
    answer({ result: reply({ steps: 2 }) });
    expect((await again).isError).toBeFalsy();
  });
});

describe("the session card and usage", () => {
  it("posts one compact card per session and updates its title and steps", async () => {
    const { browser, answer } = setup();
    for (const [i, a] of [{ action: "open", url: "https://x.test/" }, { action: "click", ref: "e1" }].entries()) {
      const p = browser.handler(a);
      await new Promise((res) => setTimeout(res, 5));
      answer({ result: reply({ steps: i + 1, title: i ? "Results" : "Home" }) });
      await p;
    }
    expect(cardsOf("browser-session")).toEqual([{ kind: "browser-session", session: "w_1", title: "Results", url: "https://x.test/", steps: 2, screenshots: 0, status: "active" }]);
  });

  it("returns a screenshot as an image and counts it apart from text actions", async () => {
    const { browser, answer, cards } = setup();
    const p = browser.handler({ action: "screenshot" });
    await new Promise((res) => setTimeout(res, 5));
    answer({ result: reply({ image: "SlBFRw==", text: "Screenshot of Home" }) });
    const r = await p;
    expect(r.images).toEqual([{ data: "SlBFRw==", mimeType: "image/jpeg" }]);
    const u = cards.usage();
    expect(u).toMatchObject({ actions: 1, screenshots: 1 });
    expect(u.byBot.b1).toMatchObject({ screenshots: 1 });
    expect(cardsOf("browser-session")[0]).toMatchObject({ screenshots: 1 });
  });
});
