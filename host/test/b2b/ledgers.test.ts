import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChainStore, weightedTokens } from "../../b2b/chains";
import { newChainId, newRid, newTaskId, RID_RE } from "../../b2b/ids";
import { RequestStore } from "../../b2b/requests";
import { ThreadStore, type ThreadLine } from "../../b2b/threads";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "b2b-"));
const clock = (t0 = 1_000_000) => { let t = t0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };
const line = (p: Partial<ThreadLine> & Pick<ThreadLine, "from" | "to" | "text">): ThreadLine => ({ at: 0, kind: "request", sha1: "x", tokens: [], artifacts: [], ...p });

describe("ids", () => {
  it("mints request, chain and task ids in their formats", () => {
    expect(newRid()).toMatch(RID_RE);
    expect(newRid()).toMatch(/^r_[a-z2-7]{8}$/);
    expect(newChainId()).toMatch(/^c_[0-9a-f]{12}$/);
    expect(newTaskId()).toMatch(/^t_[a-z2-7]{8}$/);
    expect(new Set(Array.from({ length: 200 }, newRid)).size).toBe(200);
  });
});

describe("ChainStore", () => {
  it("weights tokens exactly as ORIG-09 L6", () => {
    expect(weightedTokens({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 400 })).toBe(1000 + 1000 + 500 + 500);
  });

  it("starts, hops, accumulates peer turns, ends and persists", () => {
    const dir = tmp();
    const c = clock();
    const s = new ChainStore(path.join(dir, "chains.json"), c.now);
    const ch = s.start("user", "bot-a");
    expect(ch).toMatchObject({ rootKind: "user", rootBotId: "bot-a", hops: 0, peerTurns: 0, weightedTokens: 0 });
    s.hop(ch.chainId);
    s.hop(ch.chainId);
    s.addPeerTurn(ch.chainId, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    s.end(ch.chainId, "ping_pong");
    const again = new ChainStore(path.join(dir, "chains.json"), c.now).get(ch.chainId);
    expect(again).toMatchObject({ hops: 2, peerTurns: 1, weightedTokens: 20, costUsd: 0.01, ended: { detector: "ping_pong" } });
  });

  it("expires chains 24 h after their last activity and keeps at most 500", () => {
    const c = clock();
    const s = new ChainStore(path.join(tmp(), "chains.json"), c.now);
    const old = s.start("routine", "bot-a");
    c.advance(24 * 3_600_000 + 1);
    expect(s.get(old.chainId)).toBeNull();
    const ids = Array.from({ length: 510 }, () => { c.advance(1); return s.start("user", "b").chainId; });
    s.prune();
    expect(s.get(ids[0]!)).toBeNull();
    expect(s.get(ids[509]!)).not.toBeNull();
  });
});

describe("RequestStore", () => {
  it("opens requests, answers each exactly once, and builds the wait graph", () => {
    const c = clock();
    const r = new RequestStore(path.join(tmp(), "req.json"), c.now);
    const a = r.open({ from: "A", to: "B", kind: "request", expects: "a CSV of Q3 leads", chainId: "c_1" });
    expect(a).toMatchObject({ status: "open", from: "A", to: "B" });
    expect(r.openBetween("A", "B").map((x) => x.rid)).toEqual([a.rid]);
    expect(r.openTo("B")).toHaveLength(1);
    expect(r.openFrom("A")).toHaveLength(1);
    expect(r.waitGraph().get("A")).toEqual(new Set(["B"]));
    r.answer(a.rid, "B", "done, 212 rows");
    expect(() => r.answer(a.rid, "B", "again")).toThrow(/not open/);
    expect(r.get(a.rid)).toMatchObject({ status: "answered", answeredBy: "B", answerPreview: "done, 212 rows" });
    expect(r.openBetween("A", "B")).toEqual([]);
    expect(r.recentBetween("A", "B", 2 * 3_600_000).map((x) => x.rid)).toEqual([a.rid]);
    c.advance(2 * 3_600_000 + 1);
    expect(r.recentBetween("A", "B", 2 * 3_600_000)).toEqual([]);
  });

  it("handoffs don't wait; expiry after 24 h returns newly expired requests once", () => {
    const c = clock();
    const r = new RequestStore(path.join(tmp(), "req.json"), c.now);
    r.open({ from: "A", to: "B", kind: "handoff", expects: "the report sent to the user", taskId: "t_x", chainId: "c" });
    const q = r.open({ from: "B", to: "C", kind: "question", expects: "yes or no", chainId: "c" });
    expect(r.waitGraph().get("A")).toBeUndefined();
    c.advance(24 * 3_600_000);
    expect(r.expireDue().map((x) => x.status)).toEqual(["expired", "expired"]);
    expect(r.expireDue()).toEqual([]);
    expect(r.get(q.rid)?.status).toBe("expired");
  });

  it("persists a stale-closed-request sweep even when nothing newly expires by time", () => {
    const c = clock();
    const dir = tmp();
    const file = path.join(dir, "req.json");
    const r = new RequestStore(file, c.now);
    const a = r.open({ from: "A", to: "B", kind: "request", expects: "a thing", chainId: "c" });
    r.answer(a.rid, "B", "done");
    c.advance(7 * 86_400_000 + 1);
    expect(r.expireDue()).toEqual([]);
    const reloaded = new RequestStore(file, c.now);
    expect(reloaded.get(a.rid)).toBeNull();
  });

  it("terminates and forgets a deleted Bot's requests", () => {
    const r = new RequestStore(path.join(tmp(), "req.json"));
    const x = r.open({ from: "A", to: "B", kind: "request", expects: "a thing done", chainId: "c" });
    r.terminate([x.rid]);
    expect(r.get(x.rid)?.status).toBe("terminated");
    r.open({ from: "C", to: "A", kind: "question", expects: "an answer", chainId: "c" });
    r.removeBot("A");
    expect(r.openTo("A")).toEqual([]);
  });
});

describe("ThreadStore", () => {
  it("keeps one file per pair, both directions, and a digest of at most 800 chars", () => {
    const dir = tmp();
    const c = clock(10_000_000);
    const t = new ThreadStore(dir, c.now);
    const r = new RequestStore(path.join(dir, "req.json"), c.now);
    const open = r.open({ from: "you-id", to: "7c1e0000-scout", kind: "request", expects: "Q3 leads CSV", chainId: "c" });
    t.record(line({ at: c.now(), from: "7c1e0000-scout", to: "you-id", kind: "request", text: "dedupe the leads list" }));
    t.record(line({ at: c.now(), from: "you-id", to: "7c1e0000-scout", kind: "result", text: "done, 212 rows", artifacts: ["/workspace/leads.csv"] }));
    expect(t.lines("7c1e0000-scout", "you-id")).toHaveLength(2);
    expect(fs.readdirSync(dir).filter((f) => f.includes("__"))).toHaveLength(1);
    c.advance(40 * 60_000);
    const d = t.digest("you-id", "7c1e0000-scout", r, (id) => (id === "7c1e0000-scout" ? "Scout" : "Piper"));
    expect(d).toContain(`Thread with Scout (id 7c1e…): open: ${open.rid} (you asked: "Q3 leads CSV", 40 min ago).`);
    expect(d).toContain(`Recent: Scout→you request "dedupe the leads list" · you→Scout result "done, 212 rows"`);
    expect(d).toContain("/workspace/leads.csv");
    for (let i = 0; i < 60; i++) t.record(line({ at: c.now(), from: "you-id", to: "7c1e0000-scout", text: "y".repeat(500) }));
    expect(t.lines("you-id", "7c1e0000-scout")).toHaveLength(50);
    expect(t.digest("you-id", "7c1e0000-scout", r, () => "Scout").length).toBeLessThanOrEqual(800);
    t.removeBot("you-id");
    expect(t.lines("you-id", "7c1e0000-scout")).toEqual([]);
  });
});
