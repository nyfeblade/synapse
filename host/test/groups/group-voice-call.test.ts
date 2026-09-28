import { describe, expect, it } from "vitest";
import type { SendMessageEntry, UserMessageEntry } from "@synapse/shared";
import type { FakeScript } from "../../brain/fake-brain";
import { runRoomTurn } from "../../groups/room-turn";
import { groupHarness, promptText, say } from "./harness";

// Group voice calls: every member hears the call hint and answers at low effort; Bots follow each
// other up at most twice per thing the user says, one speaker at a time.

describe("group voice call", () => {
  it("a spoken post reaches every member turn as a voice-call turn with the spoken-reply hint", async () => {
    const script: FakeScript = (input) => (promptText(input).includes("[Group chat:") ? [say("Sounds good.")] : [say("dm")]);
    const h = groupHarness(() => script);
    const a = h.mk("Nova"), b = h.mk("Ledger");
    const { id: g } = h.groups.create([a, b], { origin: "user" });
    // Bug 108: in a call only the Bot with the floor runs, so this post addresses both members by name.
    h.orch.userPost(g, "Nova and Ledger, what should we cook tonight", "n1", { durationMs: 1200, call: true });
    await h.orch.whenIdle(g);
    const user = h.groupEntries(g).find((e): e is UserMessageEntry => e.kind === "message" && e.role === "user")!;
    expect(user.voice).toEqual({ durationMs: 1200, call: true });
    for (const m of [a, b]) {
      const first = h.brains.get(m)!.inputs[0]!;
      expect(first.voiceTurn).toBe(true);
      expect(promptText(first)).toMatch(/spoken aloud/i);
    }
  });

  it("a typed group post is not a voice turn", async () => {
    const script: FakeScript = (input) => (promptText(input).includes("[Group chat:") ? [say("(pass)")] : [say("dm")]);
    const h = groupHarness(() => script);
    const a = h.mk("Nova");
    const { id: g } = h.groups.create([a, h.mk("Ledger")], { origin: "user" });
    h.orch.userPost(g, "hello", "n1");
    await h.orch.whenIdle(g);
    const first = h.brains.get(a)!.inputs[0]!;
    expect(first.voiceTurn).toBeUndefined();
    expect(promptText(first)).not.toMatch(/spoken aloud/i);
    expect(h.groupEntries(g).filter((e): e is SendMessageEntry => e.kind === "send-message")).toHaveLength(0);
  });

  it("room turn: at most 2 Bot-to-Bot follow-ups after the first answers", async () => {
    const calls: string[] = [];
    const out = await runRoomTurn({ mentioned: "all", maxFollowUps: 2 }, {
      members: () => [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }, { id: "c", name: "Cy" }],
      runMemberTurn: async (id, round) => { calls.push(`${round}:${id}`); return { posts: [`${id} says something new`], failed: false }; },
      cancelled: () => false,
    });
    expect(calls).toEqual(["0:a", "0:b", "0:c", "1:b", "1:c"]);
    expect(out.messages).toBe(5);
  });

  it("bug 134 (item 6): a hand-off by name gives that Bot the floor next, within the follow-up cap", async () => {
    const calls: string[] = [];
    const says: Record<string, string[]> = {
      a: ["I'll handle the travel. Cy, can you take the calendar part?"],
      c: ["Sure. Thursday 3 pm is free, and I'd move the standup. Bo, can you check the budget?"],
      b: ["Budget is fine. Ann, over to you."],
    };
    const out = await runRoomTurn({ mentioned: "all", maxFollowUps: 2, floorOnly: true }, {
      members: () => [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }, { id: "c", name: "Cy" }],
      runMemberTurn: async (id, round) => { calls.push(`${round}:${id}`); return { posts: says[id]!, failed: false }; },
      pickDefault: () => "a",
      cancelled: () => false,
    });
    // Ann answers, hands the calendar to Cy (Cy gets the floor, not Bo), Cy hands to Bo; the cap (2) stops Bo's hand-back to Ann.
    expect(calls).toEqual(["0:a", "1:c", "2:b"]);
    expect(out.messages).toBe(3);
  });

  it("bug 134 (item 6): in a group call every member is told it can hand a part to a teammate by name; a 1:1 call isn't", async () => {
    const { renderMemberTurn } = await import("../../groups/member-prompt");
    const members = [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }];
    const group = renderMemberTurn({ groupName: "Team", members, me: members[0]!, history: [], voiceCall: true }).map((m) => ("text" in m ? m.text : "")).join("\n");
    expect(group).toMatch(/hand .*by name/i);
    expect(group).toMatch(/Bo, can you take/);
    const solo = renderMemberTurn({ groupName: "Ann", members: [members[0]!], me: members[0]!, history: [], voiceCall: true }).map((m) => ("text" in m ? m.text : "")).join("\n");
    expect(solo).not.toMatch(/hand .*by name/i);
    const typed = renderMemberTurn({ groupName: "Team", members, me: members[0]!, history: [] }).map((m) => ("text" in m ? m.text : "")).join("\n");
    expect(typed).not.toMatch(/hand .*by name/i);
  });
});
