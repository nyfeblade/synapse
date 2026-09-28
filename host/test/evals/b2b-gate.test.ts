import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGate } from "../../b2b/gate";
import { deterministicOutcome, loadCases, replayCase } from "../../evals/b2b-gate/replay";

const cases = loadCases(path.resolve(__dirname, "../../evals/b2b-gate/cases.jsonl"));

describe("b2b gate eval set (deterministic part, ORIG-09 §09.10)", () => {
  it("has 15 must-drop, 18 must-deliver and 12 inbox cases", () => {
    expect(cases.filter((c) => c.expect === "drop")).toHaveLength(15);
    expect(cases.filter((c) => c.expect === "deliver")).toHaveLength(18);
    expect(cases.filter((c) => c.expect === "inbox")).toHaveLength(12);
  });

  it("never drops a must-deliver case, drops every must-drop it decides, and decides ≥ 70% without the classifier", () => {
    let decided = 0;
    for (const c of cases) {
      const out = deterministicOutcome(runGate(replayCase(c, fs.mkdtempSync(path.join(os.tmpdir(), `ev-${c.id}-`)))));
      if (out === "ambiguous") continue;
      decided++;
      if (c.expect === "deliver") expect(out, c.id).not.toBe("drop");
      if (c.expect === "drop") expect(out, c.id).toBe("drop");
      if (c.expect === "inbox") expect(out, c.id).toBe("inbox");
    }
    expect(decided / cases.length).toBeGreaterThanOrEqual(0.7);
  });
});
