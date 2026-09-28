import { describe, expect, it } from "vitest";
import { courtesyRemainder, extractArtifacts, hasAsk, informativeTokens, isCourtesyOnly, jaccard, normalizeText, novelty, tokenSet4 } from "../../b2b/text";

describe("courtesy (G3)", () => {
  const drop = [
    "Thanks!", "Got it, will do 👍", "Sounds good — let me know if you need anything else", "Confirmed, received the file.",
    "Standing by.", "On it!", "Noted, I'll keep that in mind", "🙏", "✅🎉", "Great work on the deck!", "Hi Scout, thanks so much!",
    "Thank you so much. Cheers", "ok", "You're welcome, happy to help.",
  ];
  const keep = [
    "Thanks — but the totals are off by $400 in row 12", "no: 14:00", "yes, use the billing address",
    "Perfect. The CSV is at /workspace/leads-v2.csv with 12 duplicates removed.", "Thanks! Can you also send the Q4 numbers?",
  ];
  it.each(drop)("drops %s", (s) => expect(isCourtesyOnly(s)).toBe(true));
  it.each(keep)("keeps %s", (s) => expect(isCourtesyOnly(s)).toBe(false));
  it("returns the non-courtesy remainder", () => {
    expect(courtesyRemainder("Thanks! The file is at /workspace/a.csv.")).toBe("The file is at /workspace/a.csv.");
  });
});

describe("tokens, similarity and asks", () => {
  it("extracts informative tokens: words ≥ 4 letters (minus stopwords), numbers, paths and URLs", () => {
    expect(informativeTokens("The CSV has 212 rows, see /workspace/leads.csv and https://x.io/a?b=1 — thanks!")).toEqual(
      expect.arrayContaining(["rows", "212", "/workspace/leads.csv", "https://x.io/a?b=1"]),
    );
    expect(informativeTokens("thanks, this is exactly what I needed")).toEqual([]);
  });
  it("normalizes, compares and measures novelty", () => {
    expect(normalizeText("  Hello\n  World ")).toBe("hello world");
    expect(jaccard(tokenSet4("please send the leads list"), tokenSet4("please send the leads list now"))).toBe(1);
    expect(novelty(["a1", "b2", "c3", "d4"], new Set(["a1", "b2", "c3"]))).toBe(0.25);
    expect(novelty([], new Set())).toBe(0);
  });
  it("finds asks and artifacts", () => {
    expect(hasAsk("Should the invoice go to billing?")).toBe(true);
    expect(hasAsk("Please build a CSV of Q3 leads")).toBe(true);
    expect(hasAsk("I can't continue until you add the Stripe key")).toBe(true);
    expect(hasAsk("The meeting notes are in the folder")).toBe(false);
    expect(extractArtifacts("see /workspace/a.csv, and https://example.com/x.")).toEqual(["/workspace/a.csv", "https://example.com/x"]);
  });
});
