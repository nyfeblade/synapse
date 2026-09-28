import { describe, expect, it } from "vitest";
// Strict TS (Controller ruling): ModelMessage is a { text } | { image } union; messageText() narrows
// it instead of a raw `.text` access, the same minimal-cast pattern used for Response.json() elsewhere.
import { messageText } from "../../brain/types";
import { couldStillBePass, handlesOf, isPass, mentionedMembers } from "../../groups/addressing";
import { renderMemberTurn, type RoomMessage } from "../../groups/member-prompt";

const members = [{ id: "p", name: "Planner" }, { id: "s", name: "Scout" }, { id: "l", name: "Ledger" }, { id: "t", name: "Token Officer" }];

describe("addressing (GRP-03)", () => {
  it("derives handles", () => {
    expect(handlesOf("Token Officer")).toEqual(["token officer", "tokenofficer", "token"]);
    expect(handlesOf("Scout")).toEqual(["scout"]);
  });
  it("routes by handle on word boundaries, with or without @", () => {
    expect(mentionedMembers("book the cabin. ledger, does that fit?", members)).toEqual(["l"]);
    expect(mentionedMembers("@Scout and @tokenofficer please", members)).toEqual(["s", "t"]);
    expect(mentionedMembers("ask token about it", members)).toEqual(["t"]);
  });
  it("addresses everyone without a handle, or with @everyone / @all", () => {
    expect(mentionedMembers("plan a weekend", members)).toBe("all");
    expect(mentionedMembers("@everyone plan a cheap weekend", members)).toBe("all");
    expect(mentionedMembers("@all Ledger check this", members)).toBe("all");
    expect(mentionedMembers("the plannerish idea", members)).toBe("all");
  });
});

describe("pass detection (GRP-05)", () => {
  it("matches the pass regex", () => {
    for (const t of ["(pass)", "pass", "Pass.", "( pass )", " (PASS) "]) expect(isPass(t)).toBe(true);
    for (const t of ["passing on this", "I pass the ball", "(pass) but also…"]) expect(isPass(t)).toBe(false);
  });
  it("hides streaming text that could still become (pass)", () => {
    for (const t of ["", "(", "(p", "(pa", "(pas", "(pass", "pass", "(pass)"]) expect(couldStillBePass(t)).toBe(true);
    for (const t of ["(past", "Pa$", "Yes"]) expect(couldStillBePass(t)).toBe(false);
  });
});

describe("renderMemberTurn (GRP-05)", () => {
  it("renders the tagged group turn with history since the member last spoke", () => {
    const history: RoomMessage[] = [
      { from: "s", fromName: "Scout", text: "Found 3 cabins.", at: 1 },
      { from: "user", fromName: "You", text: "book the cabin. ledger, does that fit?", at: 2 },
      { from: "p", fromName: "Planner", text: "Blocked Oct 24–25.", at: 3 },
    ];
    const [msg] = renderMemberTurn({ groupName: "Trip", members: members.slice(0, 3), me: { id: "s", name: "Scout" }, history });
    const text = messageText(msg!);
    expect(text.startsWith('[Group chat: "Trip" - with Planner, Ledger]')).toBe(true);
    expect(text).toContain("The room sees only what you post with the SendMessage tool");
    expect(text).toContain('send exactly "(pass)"');
    expect(text).toContain("Scout (you): Found 3 cabins.");
    expect(text).toContain("User: book the cabin. ledger, does that fit?");
    expect(text).toContain("Planner: Blocked Oct 24–25.");
    expect(text.trim().endsWith("It's your turn. Reply to the room with SendMessage, or send \"(pass)\".")).toBe(true);
    expect(text).not.toMatch(/passed/);
  });
  it("keeps only the newest 24 history lines and adds a redrive note", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ from: "user", fromName: "You", text: `m${i}`, at: i }));
    const [msg] = renderMemberTurn({ groupName: "G", members, me: { id: "p", name: "Planner" }, history, redriveNote: "[redrive 2 of 3]" });
    expect(messageText(msg!)).not.toContain("User: m5\n");
    expect(messageText(msg!)).toContain("User: m6");
    expect(messageText(msg!)).toContain("[redrive 2 of 3]");
  });
});
