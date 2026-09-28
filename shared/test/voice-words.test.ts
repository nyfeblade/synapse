import { describe, expect, it } from "vitest";
import { sameWords, spokenWords } from "../src/voice-words";

// Bug 220 (plan item 9, the matcher half): a speculative start is kept only when the final says the same thing.
// In Full mode the final is Whisper's text and the start was made on Apple's partial; the two engines write the
// same words differently (digits, contractions, case, punctuation, disfluencies), so an exact word match threw
// away nearly every start. Same content words = the same utterance. Never fuzzy: a different name or number is
// a different request.

describe("sameWords", () => {
  it("formatting differences between Apple and Whisper still match", () => {
    expect(sameWords("text Sam that I'm running ten minutes late", "Text Sam that I'm running 10 minutes late.")).toBe(true);
    expect(sameWords("what's on my calendar tomorrow", "What is on my calendar tomorrow?")).toBe(true);
    expect(sameWords("um can you check my email", "Can you check my email?")).toBe(true);
    expect(sameWords("book a table for four at seven", "Book a table for 4 at 7.")).toBe(true);
    expect(sameWords("send the e-mail to Priya", "Send the email to Priya.")).toBe(true);
    expect(sameWords("ok sounds good", "Okay, sounds good.")).toBe(true);
    expect(sameWords("remind me at twenty five past", "Remind me at 25 past.")).toBe(true);
    expect(sameWords("I don't think so", "I do not think so.")).toBe(true);
    expect(sameWords("alright let's go", "All right, let us go.")).toBe(true);
  });

  it("a different name, number or word is a different utterance (never fuzzy)", () => {
    expect(sameWords("text Sam I'm late", "Text Pam I'm late.")).toBe(false);
    expect(sameWords("book a table for four", "Book a table for 5.")).toBe(false);
    expect(sameWords("move it to Thursday", "Move it to Tuesday.")).toBe(false);
    expect(sameWords("don't send it", "Do send it.")).toBe(false);
    expect(sameWords("check my email", "Check my email and calendar.")).toBe(false);
    expect(sameWords("", "")).toBe(false);
  });

  it("spokenWords is the canonical form both sides compare", () => {
    expect(spokenWords("Hmm, what's the time in Tokyo right now?")).toBe("what is the time in tokyo right now");
    expect(spokenWords("It's 7:05.")).toBe("it is 7 05");
  });
});
