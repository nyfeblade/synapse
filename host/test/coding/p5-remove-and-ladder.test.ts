import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingAgents, type ChildFactory, umaskGit } from "../../coding/coding-agents";
import { codingHooks } from "../../coding/module";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { FollowupStore } from "../../followups/store";
import { removeBotPhase5 } from "../../phase5/remove-bot";
import { AsyncQueue } from "../../util/async-queue";

function originRepo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "origin-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: r });
  g("init", "-q", "-b", "main"); fs.writeFileSync(path.join(r, "README.md"), "hi\n"); g("add", "-A"); g("commit", "-qm", "init");
  return r;
}
let ws: string;
let feeds: AsyncQueue<{ type: string; [k: string]: unknown }>[];
let allowed: boolean;
let usage: { botId: string; costUsd?: number }[];
const child: ChildFactory = () => { const q = new AsyncQueue<{ type: string; [k: string]: unknown }>(); feeds.push(q); return { push: () => {}, interrupt: async () => {}, close: () => q.end(), messages: q }; };
const mk = () => new CodingAgents({ workspace: ws, registryFile: path.join(ws, ".reg.json"), now: () => Date.now(), git: umaskGit, child, model: () => "claude-sonnet-5", onChange: () => {}, onDone: () => {},
  ladder: () => ({ allowsBackground: () => allowed }), onUsage: (botId, _m, u) => usage.push({ botId, costUsd: u.costUsd }) });
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-")); feeds = []; allowed = true; usage = []; });

describe("coding agents follow the usage ladder and count toward spend (I13)", () => {
  it("launch and reply are refused while the ladder holds background work", async () => {
    allowed = false;
    await expect(mk().launch("b1", { repo: `file://${originRepo()}`, task: "x" })).rejects.toThrow(/usage/i);
    allowed = true;
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "x" });
    allowed = false;
    await expect(agents.reply(a.id, "more")).rejects.toThrow(/usage/i);
  });

  it("a finished agent's usage is recorded for its Bot", async () => {
    const agents = mk();
    await agents.launch("b1", { repo: `file://${originRepo()}`, task: "x" });
    feeds[0]!.push({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(usage).toEqual([{ botId: "b1", costUsd: 0.42 }]);
  });

  it("ruling (c): a done-wake held by the ladder is deferred, then delivered once the ladder allows (flush on ladder change)", () => {
    const woke: string[] = [];
    let allowed = false;
    const ctx = { bots: { has: () => true }, enqueueHidden: (b: string, sp: { text: string }) => woke.push(`${b}:${sp.text.includes("c1")}`), ladder: () => ({ allowsBackground: () => allowed }) } as never;
    const hooks = codingHooks(ctx, new Map(), () => ({ dumpPath: () => "/x" }) as never);
    hooks.onDone({ id: "c1", botId: "b1", title: "t", status: "done", branch: "b", summary: "s" } as never);
    expect(woke).toEqual([]);
    hooks.flushDeferred();
    expect(woke).toEqual([]); // still held
    allowed = true;
    hooks.flushDeferred();
    expect(woke).toEqual(["b1:true"]);
    hooks.flushDeferred();
    expect(woke).toEqual(["b1:true"]); // delivered once
    hooks.dispose();
  });

  it("ruling (c): a deferred wake is also retried on a timer (the ladder can drop without an event), and dropped for a deleted Bot", () => {
    vi.useFakeTimers();
    try {
      const woke: string[] = [];
      let allowed = false;
      const alive = new Set(["b1", "b2"]);
      const ctx = { bots: { has: (b: string) => alive.has(b) }, enqueueHidden: (b: string) => woke.push(b), ladder: () => ({ allowsBackground: () => allowed }) } as never;
      const hooks = codingHooks(ctx, new Map(), () => ({ dumpPath: () => "/x" }) as never);
      hooks.onDone({ id: "c1", botId: "b1", title: "t", status: "done", branch: "b", summary: "s" } as never);
      hooks.onDone({ id: "c2", botId: "b2", title: "t", status: "done", branch: "b", summary: "s" } as never);
      alive.delete("b2");
      allowed = true;
      vi.advanceTimersByTime(60_000);
      expect(woke).toEqual(["b1"]);
      hooks.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("delete cleanup for Phase 5 (I12)", () => {
  it("cancels coding agents, expires local asks, kills Mac execs and drops follow-ups, dreaming and card state", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${originRepo()}`, task: "x" });
    const published: { channel: string; payload: { op?: string; command?: string } }[] = [];
    const bridge = new LocalBridge({ hub: { publish: (e: never) => published.push(e) } as never, now: () => Date.now(), workspace: ws });
    const { execId, done } = bridge.request({ botId: "b1", approvalId: null, op: "run-command", command: "sleep 100" });
    const entries = new Map<string, unknown>();
    const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e), updateEntry: () => {}, getEntry: () => null } as never;
    const asks = new LocalAsks({ bots, now: () => Date.now() });
    const ask = asks.ask("b1", { turnNo: 1, nextSendK: 0, requestId: "r", segment: 0 } as never, { action: "run-command", target: "ls" });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
    const followups = new FollowupStore(dataRoot, () => 1);
    followups.add("b1", { what: "ping", dueAt: 5 });
    const cardIds = new Map([["c1", { botId: "b1", entryId: "e1" }], ["c2", { botId: "b2", entryId: "e2" }]]);
    const forgotten: string[] = [];
    await removeBotPhase5("b1", { agents, asks, bridge, followups, dreamer: { forgetBot: (b: string) => forgotten.push(b) }, cardIds });
    expect(agents.get(a.id)).toBeNull();
    await expect(ask).resolves.toMatchObject({ outcome: "expired" });
    await expect(done).resolves.toMatchObject({ error: expect.stringMatching(/deleted/i) });
    expect(published.some((p) => p.channel === "local-exec" && p.payload.op === "kill" && p.payload.command === execId)).toBe(true);
    expect(followups.list("b1")).toEqual([]);
    expect(forgotten).toEqual(["b1"]);
    expect([...cardIds.keys()]).toEqual(["c2"]);
  });
});

describe("controller ruling (b): deleting a Bot revokes its Mac grants", () => {
  it("removeBot sends a revoke-grants message to the Mac, and it stays queued for the heartbeat until the Mac acks", async () => {
    const published: { channel: string; payload: { op?: string; botId?: string; execId?: string } }[] = [];
    const bridge = new LocalBridge({ hub: { publish: (e: never) => published.push(e) } as never, now: () => Date.now(), workspace: ws, idleMs: 5 });
    const bots = { appendEntry: () => {}, updateEntry: () => {}, getEntry: () => null } as never;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
    await removeBotPhase5("b1", { agents: mk(), asks: new LocalAsks({ bots, now: () => Date.now() }), bridge, followups: new FollowupStore(dataRoot, () => 1), dreamer: { forgetBot: () => {} }, cardIds: new Map() });
    const sent = published.find((p) => p.channel === "local-exec" && p.payload.op === "revoke-grants");
    expect(sent?.payload.botId).toBe("b1");
    // The Mac may be away: it's delivered on the next heartbeat (even past the idle watchdog), until the Mac says done.
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.heartbeat("mac").pending).toEqual([expect.objectContaining({ op: "revoke-grants", botId: "b1" })]);
    bridge.done(sent!.payload.execId!, { exitCode: 0 });
    expect(bridge.heartbeat("mac").pending).toEqual([]);
  });
});
