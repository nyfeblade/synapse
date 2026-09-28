import { describe, expect, it } from "vitest";
import { CT13_PROMPT_FOUR, CT13_PROMPT_ONE, CT13_PROMPT_TWO } from "../../../brain/conformance/checks/group-c";

// CT-13's judge only regexes for the bare words ONE/TWO/FOUR in the result text (unchanged), but the
// original prompts ("Reply with exactly ONE") were genuinely ambiguous without an object ("one
// *what*?") — reproduced live, the model asked for clarification on every turn. This reword keeps
// what's measured but removes the ambiguity.
describe("CT-13 prompts (unambiguous reword)", () => {
  it("asks for the bare word, not a bare number", () => {
    expect(CT13_PROMPT_ONE).toBe("Reply with exactly the word ONE, and nothing else.");
    expect(CT13_PROMPT_TWO).toBe("Reply with exactly the word TWO, and nothing else.");
    expect(CT13_PROMPT_FOUR).toBe("Reply with exactly the word FOUR, and nothing else.");
  });
});
