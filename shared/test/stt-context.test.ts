import { describe, expect, it } from "vitest";
import { STT_CONTEXT_CAP, STT_TERM_MAX, buildSttContext, mineVocabulary } from "../src/stt-context";

describe("mineVocabulary", () => {
  it("keeps a CamelCase term the chat keeps using", () => {
    expect(mineVocabulary("OrbStack is slow. Restart OrbStack.")).toEqual(["OrbStack"]);
  });

  it("keeps a capitalised name said more than once", () => {
    expect(mineVocabulary("Ask Priya. Priya knows.")).toEqual(["Priya"]);
  });

  it("ignores a word seen only once", () => {
    expect(mineVocabulary("Kokoro is new")).toEqual([]);
  });

  it("ignores a capital that is only the start of a sentence", () => {
    expect(mineVocabulary("The build is green. The tests pass.")).toEqual([]);
  });

  it("keeps a letter-and-digit token", () => {
    expect(mineVocabulary("run on H100 and H100 again")).toEqual(["H100"]);
  });

  it("counts the spellings together and keeps the first one it saw", () => {
    expect(mineVocabulary("OrbStack then Orbstack")).toEqual(["OrbStack"]);
  });

  it("ignores an all-lowercase word, however often it appears", () => {
    expect(mineVocabulary("orbstack and orbstack again")).toEqual([]);
  });

  it("ignores anything too short or too long to bias on", () => {
    expect(mineVocabulary("Ab Ab " + "X".repeat(31) + " " + "X".repeat(31))).toEqual([]);
  });

  it("ranks by how often the word appears, then alphabetically", () => {
    expect(mineVocabulary("Priya Priya Priya Kokoro Kokoro Atlas Atlas")).toEqual(["Priya", "Atlas", "Kokoro"]);
  });

  it("caps how much vocabulary it mines", () => {
    const words = Array.from({ length: 80 }, (_, i) => `Term${i} Term${i}`).join(" ");
    expect(mineVocabulary(words, 10)).toHaveLength(10);
  });

  it("says nothing about empty text", () => {
    expect(mineVocabulary("")).toEqual([]);
  });
});

describe("buildSttContext", () => {
  it("spends the budget on Bot names first", () => {
    const out = buildSttContext({ botNames: ["Nova"], contactNames: ["Priya"], projectTerms: ["Kokoro"] });
    expect(out[0]).toBe("Nova");
  });

  it("puts every source in, in priority order", () => {
    expect(buildSttContext({
      botNames: ["Nova"], projectTerms: ["Kokoro"], appNames: ["OrbStack"],
      contactNames: ["Priya"], recentText: "Synapse and Synapse",
    })).toEqual(["Nova", "Kokoro", "OrbStack", "Priya", "Synapse"]);
  });

  it("deduplicates case-insensitively, keeping the first spelling", () => {
    expect(buildSttContext({ botNames: ["Nova"], contactNames: ["nova", "NOVA"] })).toEqual(["Nova"]);
  });

  it("collapses the whitespace inside a name", () => {
    expect(buildSttContext({ botNames: ["  Disk   Saver "] })).toEqual(["Disk Saver"]);
  });

  it("drops entries too short, too long, or without a letter", () => {
    expect(buildSttContext({ botNames: ["a", "12345", "", "X".repeat(STT_TERM_MAX + 1), "Nova"] })).toEqual(["Nova"]);
  });

  it("keeps a name exactly at the length limit", () => {
    const name = "N".repeat(STT_TERM_MAX);
    expect(buildSttContext({ botNames: [name] })).toEqual([name]);
  });

  it("caps the list so no single entry is diluted away", () => {
    const many = Array.from({ length: STT_CONTEXT_CAP + 50 }, (_, i) => `Name${i}`);
    expect(buildSttContext({ contactNames: many })).toHaveLength(STT_CONTEXT_CAP);
  });

  it("honours a smaller cap", () => {
    expect(buildSttContext({ botNames: ["A1", "B2", "C3"] }, 2)).toEqual(["A1", "B2"]);
  });

  it("ignores a non-string that slipped in", () => {
    const src = { botNames: ["Nova", undefined as unknown as string, 7 as unknown as string] };
    expect(buildSttContext(src)).toEqual(["Nova"]);
  });

  it("says nothing when it knows nothing", () => {
    expect(buildSttContext({})).toEqual([]);
  });
});
