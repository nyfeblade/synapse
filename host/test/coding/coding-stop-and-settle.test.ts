/**
 * 0.1.4 first-run (code audit 2.2 / 2.3): coding agents couldn't be stopped from the app, and showed "Working" forever
 * after they ended. (1) A child whose stream ended without a result stayed running until the 5-hour timer. (2) After a
 * host restart the agent was marked interrupted, but the card ids lived only in memory and the boot sweep never
 * updated the card. (3) Only the Bot could cancel one; the card had no Stop.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodingAgentView } from "@synapse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingCardIds } from "../../coding/card-ids";
import { CodingAgents, type ChildFactory, umaskGit } from "../../coding/coding-agents";
import { codingHooks, createCodingModule } from "../../coding/module";
import type { ModuleContext } from "../../phase5/types";
import { AsyncQueue } from "../../util/async-queue";

let ws: string;
let origin: string;
let feeds: AsyncQueue<{ type: string; [k: string]: unknown }>[];
let changes: CodingAgentView[];
let done: CodingAgentView[];
const child: ChildFactory = () => { const q = new AsyncQueue<{ type: string; [k: string]: unknown }>(); feeds.push(q); return { push: () => {}, interrupt: async () => {}, close: () => q.end(), messages: q }; };
const mk = () => new CodingAgents({ workspace: ws, registryFile: path.join(ws, ".reg.json"), now: () => Date.now(), git: umaskGit, child, model: () => "claude-sonnet-5",
  onChange: (a) => changes.push({ ...a }), onDone: (a) => done.push({ ...a }) });
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  origin = fs.mkdtempSync(path.join(os.tmpdir(), "origin-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: origin });
  g("init", "-q", "-b", "main"); fs.writeFileSync(path.join(origin, "README.md"), "hi\n"); g("add", "-A"); g("commit", "-qm", "init");
  feeds = []; changes = []; done = [];
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(origin, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("coding agents end, stop and settle", () => {
  it("a child that ends without a result is settled at once, not left Working", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${origin}`, task: "t" });
    feeds[0]!.push({ type: "assistant", message: { content: [] } });
    feeds[0]!.end();
    await tick();
    expect(agents.get(a.id)).toMatchObject({ status: "error", summary: "The coding agent stopped without a result." });
    expect(changes.at(-1)?.status).toBe("error");
    expect(done.map((x) => x.status)).toEqual(["error"]);
  });

  it("a result, then the stream ending, settles once as done", async () => {
    const agents = mk();
    const a = await agents.launch("b1", { repo: `file://${origin}`, task: "t" });
    feeds[0]!.push({ type: "result", subtype: "success", result: "All good." });
    feeds[0]!.end();
    await tick();
    expect(agents.get(a.id)?.status).toBe("done");
    expect(done).toHaveLength(1);
  });

  it("the card's Stop (cancelCodingAgent) cancels a running agent and closes its child; a second Stop is a no-op", async () => {
    const agents = mk();
    const cardIds = new CodingCardIds(path.join(ws, "cards.json"));
    const hooks = { onChange: (_a: CodingAgentView) => {}, onDone: (_a: CodingAgentView) => {}, flushDeferred: () => {}, dispose: () => {} };
    const mod = createCodingModule({} as ModuleContext, agents, cardIds, hooks);
    const a = await agents.launch("b1", { repo: `file://${origin}`, task: "t" });
    const r = await mod.handlers!.cancelCodingAgent!({ id: a.id }) as { agent: CodingAgentView };
    expect(r.agent.status).toBe("cancelled");
    await tick();
    expect(agents.get(a.id)?.status).toBe("cancelled"); // the closed stream didn't overwrite it
    expect(done.map((x) => x.status)).toEqual(["cancelled"]);
    expect((await mod.handlers!.cancelCodingAgent!({ id: a.id }) as { agent: CodingAgentView }).agent.status).toBe("cancelled");
    expect(done).toHaveLength(1);
    expect(() => mod.handlers!.cancelCodingAgent!({ id: "coding-nope" })).toThrow(/doesn't exist/);
  });

  it("after a host restart, the running agent's card is settled (the card ids survive the restart)", async () => {
    const agents = mk();
    const cards1 = new CodingCardIds(path.join(ws, "cards.json"));
    const a = await agents.launch("b1", { repo: `file://${origin}`, task: "t" });
    cards1.set(a.id, { botId: "b1", entryId: "entry-7" });
    // The host restarts: a new registry and card map from disk.
    const agents2 = mk();
    const cards2 = new CodingCardIds(path.join(ws, "cards.json"));
    expect(cards2.get(a.id)).toEqual({ botId: "b1", entryId: "entry-7" });
    const updated: Array<{ entryId: string; status: string }> = [];
    const woke: string[] = [];
    const ctx = {
      bots: { has: () => true, updateCard: () => {} },
      ladder: () => ({ allowsBackground: () => true }),
      enqueueHidden: (b: string) => woke.push(b),
    } as unknown as ModuleContext;
    const real = codingHooks(ctx, cards2, () => agents2);
    const hooks = { ...real, onChange: (x: CodingAgentView) => { const c = cards2.get(x.id); if (c) updated.push({ entryId: c.entryId, status: x.status }); } };
    const mod = createCodingModule(ctx, agents2, cards2, hooks);
    await mod.start?.();
    expect(updated).toEqual([{ entryId: "entry-7", status: "error" }]);
    expect(woke).toEqual(["b1"]);
    // Dropped cards leave the file too.
    cards2.delete(a.id);
    expect(new CodingCardIds(path.join(ws, "cards.json")).size).toBe(0);
    agents.cancel(a.id);
  });
});
