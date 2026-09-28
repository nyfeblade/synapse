/**
 * mac-browser, end to end in-process: the REAL host Browser tool + bridge + asks, the REAL Mac daemon + policy store,
 * and a stub browser controller. The Mac keeps its own record of "May use the browser on your Mac" (per Bot, off by
 * default); first use asks; consequential actions ask unless the user made an always-allow rule for the site.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STR5, STRB, type BrowserArgs, type LocalComputer, type SseEvent } from "@synapse/shared";
import { LocalExecDaemon, type BrowserCall } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { LocalAsks } from "../../../host/local/asks";
import { LocalBridge } from "../../../host/local/bridge";
import { createLocalTools } from "../../../host/local/local-tools";

let dir: string;
let ws: string;
const key = Buffer.alloc(32, 9);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brgate-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "brgate-ws-"));
});

function world(o: { hostMode?: "ask" | "full-auto" } = {}) {
  const entries = new Map<string, { message?: { card?: { askId: string; status: string; action: string; target: string; description: string | null } } }>();
  const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
  let daemon: LocalExecDaemon | null = null;
  const bridge = new LocalBridge({ hub: { publish: (e: SseEvent) => daemon?.onEvent(e) } as never, now: () => Date.now(), workspace: ws, idleMs: 60_000 });
  const asks = new LocalAsks({ bots, now: () => Date.now() });
  const call = async (cmd: string, args: unknown): Promise<unknown> => {
    const a = args as Record<string, unknown>;
    if (cmd === "registerLocalComputer") { bridge.register(a.computer as LocalComputer); return {}; }
    if (cmd === "localExecHeartbeat") return { pending: [] };
    if (cmd === "localExecDone") { bridge.done(String(a.execId), a as never); return {}; }
    if (cmd === "resolveLocalToolPermission") return { status: asks.resolve(String(a.id), String(a.askId), a.choice as never) };
    throw new Error(`unexpected ${cmd}`);
  };
  const policy = new LocalPolicyStore(dir, Date.now, key, { home: () => os.tmpdir() });
  const seen: BrowserCall[] = [];
  /** The stub controller: "e7" is a Pay button (consequential) on shop.test. */
  const browser = async (c: BrowserCall) => {
    seen.push(c);
    if (c.args.ref === "e7" && !c.approved && !c.origins.includes("shop.test")) return { ok: false as const, needsApproval: true, error: STRB.consequential("Click “Pay now”", "shop.test") };
    return { ok: true as const, reply: { text: `did ${c.args.action}`, title: "Shop", url: "https://shop.test/", session: "w_1", steps: seen.length, status: "active" as const } };
  };
  daemon = new LocalExecDaemon({ call, policy, executor: new LocalExecutor({ root: () => os.tmpdir(), fullAccess: () => true }), heartbeatMs: 3_600_000, browser, browserOrigin: async () => "shop.test" });
  bridge.register(policy.current());
  bridge.heartbeat(policy.current().computerId);
  const tool = createLocalTools({ botId: "b1", slot: () => ({ turnNo: 1, nextSendK: 0, requestId: "r", segment: 0, source: "user" }) as never, bridge, asks, now: () => Date.now(), permMode: () => o.hostMode ?? "ask", botName: () => "Ava" }).find((t) => t.name === "Browser")!;
  const run = (a: BrowserArgs) => tool.handler(a as never);
  const pendingCard = () => [...entries.values()].map((e) => e.message?.card).find((c) => c && c.status === "pending") ?? null;
  const answer = async (choice: "once" | "always" | "never" | "deny") => {
    const c = pendingCard()!;
    return daemon!.intercept("resolveLocalToolPermission", { id: "b1", askId: c.askId, choice, action: c.action, target: c.target });
  };
  return { daemon: daemon!, policy, run, pendingCard, answer, seen };
}

describe("the per-Bot browser permission (off by default, first use asks)", () => {
  it("first use raises the permission card; nothing reaches the browser", async () => {
    const w = world();
    const r = await w.run({ action: "open", url: "https://shop.test/" });
    expect(r).toMatchObject({ isError: true, text: STR5.localAskWaiting });
    expect(w.seen).toEqual([]);
    expect(w.pendingCard()).toMatchObject({ action: "browser", description: STRB.permissionAsk("Ava") });
    expect(await w.daemon.intercept("getLocalBrowserAllowed", { id: "b1" })).toEqual({ handled: true, result: { allowed: false } });
  });

  it("Allow once runs that one call; the next call asks again", async () => {
    const w = world();
    await w.run({ action: "open", url: "https://shop.test/" });
    await w.answer("once");
    const r = await w.run({ action: "open", url: "https://shop.test/" });
    expect(r).toMatchObject({ text: "did open" });
    expect(w.seen[0]).toMatchObject({ approved: false, botName: "Ava" }); // a permission answer approves no consequential action
    const again = await w.run({ action: "snapshot" });
    expect(again).toMatchObject({ isError: true, text: STR5.localAskWaiting });
  });

  it("Always allow turns the Bot's setting on (on this Mac); the setting can turn it off again", async () => {
    const w = world();
    await w.run({ action: "open", url: "https://shop.test/" });
    await w.answer("always");
    expect(await w.run({ action: "open", url: "https://shop.test/" })).toMatchObject({ text: "did open" });
    expect(await w.run({ action: "snapshot" })).toMatchObject({ text: "did snapshot" });
    expect(await w.daemon.intercept("getLocalBrowserAllowed", { id: "b1" })).toEqual({ handled: true, result: { allowed: true } });
    await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: false });
    expect(await w.run({ action: "snapshot" })).toMatchObject({ isError: true });
  });

  it("the setting in Bot settings allows it up front; another Bot is still off", async () => {
    const w = world();
    expect(await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: true })).toEqual({ handled: true, result: { allowed: true } });
    expect(await w.run({ action: "snapshot" })).toMatchObject({ text: "did snapshot" });
    expect(w.policy.checkBrowser({ execId: "x", botId: "b2", approvalId: null, op: "browser", browser: { action: "snapshot" } })).toMatchObject({ ok: false });
  });

  it("'Never' on a browser card never switches the whole Mac to Never allow", async () => {
    const w = world();
    await w.run({ action: "open", url: "https://shop.test/" });
    await w.answer("never");
    expect(w.policy.current().executionPolicy).toBe("ask");
  });

  it("the Mac's Never allow blocks the browser too", async () => {
    const w = world();
    await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: true });
    w.policy.update({ executionPolicy: "never" });
    expect(w.policy.checkBrowser({ execId: "x", botId: "b1", approvalId: null, op: "browser", browser: { action: "snapshot" } })).toEqual({ ok: false, reason: STR5.macRefused.neverPolicy });
  });

  it("a deleted Bot's browser permission and site rules go", async () => {
    const w = world();
    await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: true });
    w.policy.addBrowserOrigin("b1", "shop.test");
    w.policy.forgetBot("b1");
    expect(w.policy.granted("b1", "browser")).toBe(false);
    expect(w.policy.browserOrigins("b1")).toEqual([]);
  });
});

describe("consequential actions", () => {
  it("ask every time: the card names the action and site, Allow once runs exactly that call", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: true });
    const r = await w.run({ action: "click", ref: "e7" });
    expect(r).toMatchObject({ isError: true, text: STR5.localAskWaiting });
    expect(w.pendingCard()).toMatchObject({ action: "browser", description: STRB.consequential("Click “Pay now”", "shop.test") });
    await w.answer("once");
    expect(await w.run({ action: "click", ref: "e7" })).toMatchObject({ text: "did click" });
    expect(w.seen[w.seen.length - 1]).toMatchObject({ approved: true });
    // the next purchase asks again
    expect(await w.run({ action: "click", ref: "e7" })).toMatchObject({ isError: true });
  });

  it("Always allow on that card is an explicit always-allow rule for the site (this Bot only)", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setLocalBrowserAllowed", { id: "b1", allowed: true });
    await w.run({ action: "click", ref: "e7" });
    await w.answer("always");
    expect(w.policy.browserOrigins("b1")).toEqual(["shop.test"]);
    expect(await w.run({ action: "click", ref: "e7" })).toMatchObject({ text: "did click" });
    expect(await w.run({ action: "click", ref: "e7" })).toMatchObject({ text: "did click" });
    expect(w.policy.browserOrigins("b2")).toEqual([]);
  });
});
