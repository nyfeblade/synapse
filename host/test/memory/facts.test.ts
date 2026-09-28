import { describe, expect, it } from "vitest";
import { dedupeKey, factId, importanceOf, monthOf, normalizeFact, parseFacts, renderLine, strength } from "../../memory/facts";

describe("facts (MEM-01)", () => {
  it("normalizes, keys and ids content", () => {
    expect(normalizeFact("  Prefers \n short   answers ")).toBe("Prefers short answers");
    expect(normalizeFact("x".repeat(600))).toHaveLength(500);
    expect(dedupeKey("Prefers  SHORT answers")).toBe("prefers short answers");
    expect(factId("Prefers short answers")).toMatch(/^[0-9a-f]{16}$/);
    expect(factId("prefers short ANSWERS")).toBe(factId("Prefers short answers"));
  });
  it("renders and parses lines with prefixes", () => {
    expect(renderLine({ date: "2026-09-12", kind: "note", content: "Waiting on the landlord" })).toBe("- (2026-09-12) [note] Waiting on the landlord");
    const text = "# Memory log\n<!-- c -->\n- (2026-09-12) [note] A\n- (2026-09-13) [episode] B\n- (2026-09-14) C\nnot a fact\n";
    expect(parseFacts(text, "log").map((f) => [f.kind, f.content, f.date])).toEqual([["note", "A", "2026-09-12"], ["episode", "B", "2026-09-13"], ["fact", "C", "2026-09-14"]]);
    expect(monthOf("2026-09-14")).toBe("2026-09");
  });
  it("computes importance and strength (§05.4)", () => {
    expect([importanceOf("episode"), importanceOf("fact"), importanceOf("note")]).toEqual([1.5, 1, 0.5]);
    const now = Date.UTC(2026, 8, 30);
    const note = { id: "x", date: "2026-08-31", kind: "note" as const, content: "n", tier: "log" as const, createdAt: Date.UTC(2026, 7, 31) };
    expect(strength(note, {}, now)).toBeCloseTo(0.25, 2);
    expect(strength({ ...note, tier: "profile", kind: "fact" }, {}, now)).toBe(1);
    expect(strength(note, { confirmedAt: now }, now)).toBeCloseTo(0.5, 5);
  });
});
