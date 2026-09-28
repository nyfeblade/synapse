import { describe, expect, it } from "vitest";
import { approvalAnswer, approvalQuestion } from "../../src/renderer/voice/call-approvals";

// Bug 142: spoken approvals on a call. A pending card is read aloud as a short question; an UNAMBIGUOUS yes / no is
// matched in code (never a model call, never a turn); anything else goes to the Bot's voice, which can change the
// pending action and read it back.

describe("approvalAnswer: only a plain yes or no", () => {
  it.each(["yes", "Yes.", "yeah", "yep", "sure", "ok", "okay!", "go ahead", "send it", "do it", "yes please", "yes, send it", "yeah do it", "sounds good", "that's fine", "approved"])("%s → yes", (t) => {
    expect(approvalAnswer(t)).toBe("yes");
  });

  it.each(["no", "No.", "nope", "cancel", "stop", "don't", "do not", "don't send it", "no thanks", "never mind", "cancel that", "hold off"])("%s → no", (t) => {
    expect(approvalAnswer(t)).toBe("no");
  });

  it.each(["yes but make it 10 minutes", "no, say ten minutes instead", "who is it going to?", "change it to Sam's work number", "wait", "what does it say", "send it to Mom instead", "yes and also text Bo", ""])("%s → neither (the voice handles it)", (t) => {
    expect(approvalAnswer(t)).toBeNull();
  });
});

describe("approvalQuestion: the card read aloud", () => {
  it("says who gets what, and asks", () => {
    expect(approvalQuestion("Send a message to Sam Lee: “I'm running late”")).toBe("Send a message to Sam Lee: “I'm running late”. Should I go ahead?");
    expect(approvalQuestion("On your computer: open -a Calendar.")).toBe("On your computer: open -a Calendar. Should I go ahead?");
  });
});
