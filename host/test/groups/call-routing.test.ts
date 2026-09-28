import { describe, expect, it } from "vitest";
import { CALL_CONTINUITY_MS, CALL_QUESTION_MS, contentWords, lastUserPost, pickCallResponder, type CallMember } from "../../groups/call-routing";
import type { RoomMessage } from "../../groups/member-prompt";

// Call-behaviour, the user's decision D4: who answers an unnamed utterance on a call with several Bots is decided in
// code — continuity, then a local relevance score, then the last speaker. No model call.

const members: CallMember[] = [
  { id: "nova", name: "Nova", description: "Chief of Staff. Runs the calendar, meetings and email." },
  { id: "ledger", name: "Ledger", description: "Finance. Budgets, invoices, retainer numbers and expenses." },
  { id: "scout", name: "Scout", description: "Travel. Flights, hotels, weather and trip plans." },
];
const msg = (from: string, text: string, at: number): RoomMessage => ({ from, fromName: from, text, at });

describe("pickCallResponder", () => {
  it("continuity: the Bot that just asked something answers, whatever the words", () => {
    const history = [msg("scout", "Want the window seat?", 0), msg("user", "yes, and check the invoice too", CALL_CONTINUITY_MS + 5_000)];
    expect(pickCallResponder({ post: history[1], members, history })).toBe("scout");
  });

  it("continuity: a line posted shortly before keeps the floor", () => {
    const history = [msg("ledger", "The budget is on track.", 0), msg("user", "and what about the weather", CALL_CONTINUITY_MS - 1)];
    expect(pickCallResponder({ post: history[1], members, history })).toBe("ledger");
  });

  it("relevance: after a while, the Bot whose description matches the words answers", () => {
    const history = [msg("nova", "Your day is clear.", 0), msg("user", "how are the invoices looking for the retainer", 120_000)];
    expect(pickCallResponder({ post: history[1], members, history })).toBe("ledger");
    const h2 = [msg("nova", "Your day is clear.", 0), msg("user", "book me flights to Denver", 120_000)];
    expect(pickCallResponder({ post: h2[1], members, history: h2 })).toBe("scout");
  });

  it("no clear winner: the last speaker, else the first on the call", () => {
    const history = [msg("scout", "Done.", 0), msg("user", "hmm, interesting", 120_000)];
    expect(pickCallResponder({ post: history[1], members, history })).toBe("scout");
    const fresh = [msg("user", "hello there", 0)];
    expect(pickCallResponder({ post: fresh[0], members, history: fresh })).toBe("nova");
  });

  it("review round 1: a question keeps the floor only for a while — long after, the words decide", () => {
    const history = [msg("scout", "Want the window seat?", 0), msg("user", "how are the invoices looking", CALL_QUESTION_MS + 1)];
    expect(pickCallResponder({ post: history[1], members, history })).toBe("ledger");
  });

  it("review round 1: stemming keeps the word (\"notes\" is a note, not \"not\")", () => {
    expect([...contentWords("meeting notes and boxes of invoices, flights booked")]).toEqual(["meet", "note", "box", "invoice", "flight", "book"]);
  });

  it("review round 1: the user's post is found by who wrote it, not by being last (a Bot line can land after it)", () => {
    const history = [msg("user", "book me flights to Denver", 120_000), msg("nova", "Your day is clear.", 120_050)];
    expect(lastUserPost(history)?.text).toBe("book me flights to Denver");
  });
});
