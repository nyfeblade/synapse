import { describe, expect, it } from "vitest";
import { runRoomTurn, type RoomTurnDeps } from "../../groups/room-turn";

const M = [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }, { id: "c", name: "Cy" }];

function deps(script: (id: string, round: number) => string[] | "fail", over: Partial<RoomTurnDeps> = {}) {
  const calls: string[] = [];
  const d: RoomTurnDeps = {
    members: () => M,
    runMemberTurn: async (id, round) => {
      calls.push(`${round}:${id}`);
      const r = script(id, round);
      return r === "fail" ? { posts: [], failed: true } : { posts: r, failed: false };
    },
    cancelled: () => false,
    ...over,
  };
  return { d, calls };
}

describe("runRoomTurn (GRP-04)", () => {
  it("rotates speaker order per round and ends on a silent round", async () => {
    const { d, calls } = deps((id, r) => (r === 0 ? [`${id} hi`] : []));
    const out = await runRoomTurn({ mentioned: "all" }, d);
    expect(calls).toEqual(["0:a", "0:b", "0:c", "1:b", "1:c", "1:a"]);
    expect(out).toMatchObject({ rounds: 2, messages: 3, spokeIds: ["a", "b", "c"], passIds: [], cancelled: false });
  });

  it("caps at 3 rounds, 10 messages and 2 posts per member turn", async () => {
    const { d, calls } = deps((id) => [`${id}1`, `${id}2`, `${id}3`]);
    const out = await runRoomTurn({ mentioned: "all" }, d);
    expect(out.messages).toBe(10);
    expect(calls).toEqual(["0:a", "0:b", "0:c", "1:b", "1:c"]);
    expect(out.rounds).toBe(2);
  });

  it("only mentioned members answer, and later rounds follow names in the posts", async () => {
    const { d, calls } = deps((id, r) => (id === "c" && r === 0 ? ["Bo, can you check the total?"] : id === "b" && r === 1 ? ["$392"] : []));
    const out = await runRoomTurn({ mentioned: ["c"] }, d);
    expect(calls).toEqual(["0:c", "1:b", "2:c"]);
    expect(out.spokeIds).toEqual(["c", "b"]);
    expect(out.passIds).toEqual([]);
  });

  it("members given a turn who never posted are passers; failures count as passes (GRP-06, GRP-13)", async () => {
    const { d } = deps((id, r) => (id === "a" && r === 0 ? ["plan"] : id === "c" ? "fail" : []));
    const out = await runRoomTurn({ mentioned: "all" }, d);
    expect(out.turnGivenIds).toEqual(["a", "b", "c"]);
    expect(out.passIds).toEqual(["b", "c"]);
  });

  it("stops when cancelled by a newer user post", async () => {
    let n = 0;
    const { d, calls } = deps(() => ["x"], { cancelled: () => ++n > 2 });
    const out = await runRoomTurn({ mentioned: "all" }, d);
    expect(calls).toEqual(["0:a", "0:b"]);
    expect(out.cancelled).toBe(true);
  });

  it("uses the floor manager's picks; unpicked members get no turn and no pass (ORIG-10)", async () => {
    const { d, calls } = deps((id, r) => (id === "b" && r === 0 ? ["answer"] : []), {
      pickRound1: async () => ["b"],
      pickLater: async () => [],
    });
    const out = await runRoomTurn({ mentioned: "all" }, d);
    expect(calls).toEqual(["0:b"]);
    expect(out.turnGivenIds).toEqual(["b"]);
    expect(out.passIds).toEqual([]);
  });

  it("falls back to round-robin when the floor manager returns null", async () => {
    const { d, calls } = deps(() => [], { pickRound1: async () => null });
    await runRoomTurn({ mentioned: "all" }, d);
    expect(calls).toEqual(["0:a", "0:b", "0:c"]);
  });
});
