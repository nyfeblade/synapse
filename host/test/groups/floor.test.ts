import { describe, expect, it } from "vitest";
import { FloorManager } from "../../groups/floor";
import { StubOneShot } from "../../helper-model/one-shot";

const members = [
  { id: "p", name: "Planner", description: "Calendar and scheduling" },
  { id: "s", name: "Scout", description: "Research and travel options" },
  { id: "l", name: "Ledger", description: "Budgets and money" },
  { id: "c", name: "Courier", description: "Email" },
];
const post = { from: "user", fromName: "You", text: "find a cheap cabin upstate", at: 1 };
const scores = (m: Record<string, number>) => new StubOneShot({ "orig/group-floor.md": () => ({ scores: Object.entries(m).map(([id, relevance]) => ({ id, relevance, why: "x" })) }) });

describe("FloorManager (ORIG-10)", () => {
  it("round 1: members ≥ 0.35, highest first, at most 3", async () => {
    const f = new FloorManager({ model: scores({ p: 0.4, s: 0.95, l: 0.6, c: 0.5 }) });
    expect(await f.pickRound1({ group: "Trip", members, recent: [], post })).toEqual(["s", "l", "c"]);
  });
  it("round 1: the single highest when nobody reaches 0.35", async () => {
    const f = new FloorManager({ model: scores({ p: 0.1, s: 0.3, l: 0.2, c: 0.05 }) });
    expect(await f.pickRound1({ group: "Trip", members, recent: [], post })).toEqual(["s"]);
  });
  it("sends the documented input and ignores unknown ids", async () => {
    const model = new StubOneShot({ "orig/group-floor.md": () => ({ scores: [{ id: "zz", relevance: 1, why: "?" }, { id: "l", relevance: 0.7, why: "money" }] }) });
    const f = new FloorManager({ model });
    expect(await f.pickRound1({ group: "Trip", members, recent: [post], post })).toEqual(["l"]);
    expect(model.calls[0]!.input).toEqual({ group: "Trip", members: members.map((m) => ({ id: m.id, name: m.name, description: m.description })), recent: [{ from: "You", text: post.text }], post: { from: "You", text: post.text } });
  });
  it("falls back (null) on error, malformed output or timeout", async () => {
    expect(await new FloorManager({ model: new StubOneShot({ "orig/group-floor.md": () => { throw new Error("boom"); } }) }).pickRound1({ group: "T", members, recent: [], post })).toBeNull();
    expect(await new FloorManager({ model: new StubOneShot({ "orig/group-floor.md": () => ({ nope: 1 }) }) }).pickRound1({ group: "T", members, recent: [], post })).toBeNull();
    const slow = new StubOneShot({ "orig/group-floor.md": () => new Promise((r) => setTimeout(() => r({ scores: [] }), 200)) });
    expect(await new FloorManager({ model: slow, timeoutMs: 20 }).pickRound1({ group: "T", members, recent: [], post })).toBeNull();
  });
  it("later rounds: named or asked members first, never the authors, at most 2", async () => {
    const f = new FloorManager({ model: scores({ p: 0.8, s: 0.9, l: 0.2, c: 0.6 }) });
    const round = [{ from: "s", fromName: "Scout", text: "Ledger, does $142 a night fit the budget?", at: 2 }];
    expect(await f.pickLater({ group: "Trip", members, roundMessages: round })).toEqual(["l", "p"]);
  });
  it("later rounds: an empty pick ends the room turn", async () => {
    const f = new FloorManager({ model: scores({ p: 0.1, s: 0.9, l: 0.1, c: 0.1 }) });
    expect(await f.pickLater({ group: "Trip", members, roundMessages: [{ from: "s", fromName: "Scout", text: "Booked the cabin for the 24th.", at: 2 }] })).toEqual([]);
  });
});
