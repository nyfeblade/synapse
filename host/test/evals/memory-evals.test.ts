import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRecallCorpus } from "../../evals/memory/recall-gen";
import { runRecallEval } from "../../evals/memory/run";
import { episodeRubric, scoreExtraction, type ExtractionCase } from "../../evals/memory/score";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../evals/memory");
const cases = fs.readFileSync(path.join(dir, "extraction.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ExtractionCase);

describe("memory eval sets (ORIG-05 §05.5)", () => {
  it("has 40 extraction cases split 15/15/10 with credential and untrusted traps", () => {
    expect(cases).toHaveLength(40);
    expect(cases.filter((c) => c.group === "must")).toHaveLength(15);
    expect(cases.filter((c) => c.group === "none")).toHaveLength(15);
    expect(cases.filter((c) => c.group === "mixed")).toHaveLength(10);
    expect(cases.filter((c) => c.group === "none").every((c) => c.expect.length === 0)).toBe(true);
    expect(cases.some((c) => c.forbid.some((f) => f.startsWith("sk-")))).toBe(true);
    expect(cases.some((c) => c.bot.includes("<untrusted_data>") && c.forbid.length > 0)).toBe(true);
    expect(cases.some((c) => c.expect.some((e) => e.tag === "remove"))).toBe(true);
    const eps = fs.readFileSync(path.join(dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { turns: unknown[] });
    expect(eps).toHaveLength(10);
    expect(eps.every((e) => e.turns.length === 6)).toBe(true);
  });

  it("scores line-level precision and recall and catches forbidden content", () => {
    const c: ExtractionCase = { id: "x", group: "mixed", user: "", bot: "", expect: [{ tag: "profile", all: ["short", "answers"] }], forbid: ["hunter2"] };
    const r = scoreExtraction([{ c, lines: [{ tag: "profile", content: "The user prefers short answers" }, { tag: "log", content: "password hunter2" }] }]);
    expect(r).toEqual({ precision: 0.5, recall: 1, forbiddenHits: ["x: password hunter2"] });
  });

  // Task 38 live run: the model kept storing correct extra memories the labels did not list
  // (e.g. "The user's sister is named Maya"). `accept` marks such lines as correct for precision
  // without adding them to recall's denominator.
  it("counts an `accept` line as correct for precision but not as an expected line for recall", () => {
    const c: ExtractionCase = { id: "y", group: "must", user: "", bot: "", expect: [{ tag: "profile", all: ["aisle"] }], accept: [{ tag: "profile", all: ["bag"] }], forbid: [] };
    const r = scoreExtraction([{ c, lines: [{ tag: "profile", content: "Prefers aisle seats" }, { tag: "profile", content: "Always checks one bag" }, { tag: "log", content: "Booked a hotel" }] }]);
    expect(r).toEqual({ precision: 2 / 3, recall: 1, forbiddenHits: [] });
    const miss = scoreExtraction([{ c, lines: [{ tag: "profile", content: "Always checks one bag" }] }]);
    expect(miss).toEqual({ precision: 1, recall: 0, forbiddenHits: [] });
  });

  it("grades an episode", () => {
    expect(episodeRubric("On 2026-09-14 the user asked Piper to draft the Q3 deck; Piper drafted it and sent it to Dana.")).toEqual({ dates: true, past: true, sentences: true, noSecrets: true });
    expect(episodeRubric("The user wants a deck. Piper will draft it. Then send it.").sentences).toBe(false);
  });

  it("fails the dates criterion when no absolute date is present at all (ORIG-05 §05.5 'absolute dates' gate)", () => {
    expect(episodeRubric("Piper drafted the deck and sent it to Dana.").dates).toBe(false);
  });

  it("recall: 2,000 facts, 50 labeled + 20 empty queries; precision@6 ≥ 0.6, ≤900 chars, silent when nothing is relevant", () => {
    const g = generateRecallCorpus(7);
    expect(g.facts).toHaveLength(2000);
    expect(g.queries).toHaveLength(50);
    expect(g.empty).toHaveLength(20);
    const r = runRecallEval();
    expect(r.precision).toBeGreaterThanOrEqual(0.6);
    expect(r.maxChars).toBeLessThanOrEqual(900);
    expect(r.emptyViolations).toBe(0);
  });
});
