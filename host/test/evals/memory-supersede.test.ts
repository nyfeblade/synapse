import { describe, expect, it } from "vitest";
import { generateRecallCorpus } from "../../evals/memory/recall-gen";
import { runRecallEval } from "../../evals/memory/run";
import { dedupeKey } from "../../memory/facts";
import { generateSupersedeSet } from "../../evals/memory/supersede-gen";
import { runSupersedeEval } from "../../evals/memory/supersede-run";

/**
 * Memory provenance, before/after (docs/decisions.md). "Before" = keyword recall over the markdown alone (ledger off),
 * measured on this branch's first commit; the numbers are asserted here so a regression in either direction shows.
 *   extractor misses the remove:  before current 0.00 / past 1.00 (both lines kept, so the stale one always comes back)
 *   extractor emits the remove:   before current 1.00 / past 0.00 (the old value is deleted, "what was it" can't be answered)
 *   existing recall eval (2,000 facts, 50 labelled + 20 empty queries): before precision 1.00, max 201 chars, 0 violations
 */
describe("superseded-fact recall (memory provenance)", () => {
  it("generates a marker-free set: old and new differ only in the value", () => {
    const g = generateSupersedeSet(11);
    expect(g.chains.length).toBeGreaterThanOrEqual(24);
    for (const c of g.chains) {
      expect(c.old.replace(c.oldValue, "§")).toBe(c.new.replace(c.newValue, "§"));
      expect(c.new).not.toMatch(/\b(now|updated|changed|new|currently)\b/i);
    }
    expect(g.traps.every((t) => t.values.length === 2)).toBe(true);
  });

  it("without the ledger it reproduces the baseline", async () => {
    const miss = await runSupersedeEval({ extractorRemoves: false, ledger: false });
    const rem = await runSupersedeEval({ extractorRemoves: true, ledger: false });
    expect([miss.current, miss.past, rem.current, rem.past]).toEqual([0, 1, 1, 0]);
  });

  it("with the ledger: current values win, old values answer 'before' questions, traps keep both, inside 900 chars", async () => {
    const miss = await runSupersedeEval({ extractorRemoves: false, ledger: true });
    const rem = await runSupersedeEval({ extractorRemoves: true, ledger: true });
    console.log("SUPERSEDE after", JSON.stringify({ miss, rem }));
    expect(miss.current).toBeGreaterThanOrEqual(0.85); // the held-out shapes fail here by design (3 of 29)
    expect(miss.byTemplate["held-out"]!.current).toBe(0);
    expect(miss.past).toBeGreaterThanOrEqual(0.95);
    expect(rem.current).toBe(1);
    expect(rem.past).toBeGreaterThanOrEqual(0.95);
    expect(miss.traps).toBe(1);
    expect(rem.traps).toBe(1);
    expect(Math.max(miss.maxChars, rem.maxChars)).toBeLessThanOrEqual(900);
  });

  it("the existing recall eval does not drop with the ledger migrated in", () => {
    const off = runRecallEval();
    const on = runRecallEval({ ledger: true });
    expect(on.migrated).toBe(new Set(generateRecallCorpus(7).facts.map((f) => dedupeKey(f.content))).size); // a repeated sentence is one fact
    expect(on.precision).toBeGreaterThanOrEqual(off.precision);
    expect(on.emptyViolations).toBe(0);
    expect(on.maxChars).toBeLessThanOrEqual(900);
  });
});
