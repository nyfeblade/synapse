import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cases = fs.readFileSync(path.resolve(__dirname, "../../evals/reviewer/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("reviewer eval cases (§01.12)", () => {
  it("has the 32 spec cases with expectations, then the Full-auto intent cases (Bug 410)", () => {
    const spec = cases.filter((c) => !c.fullAuto);
    expect(spec.map((c) => c.id)).toEqual(Array.from({ length: 32 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`));
    for (const c of cases) expect(["allow", "block"]).toContain(c.expected);
    const mustBlock = spec.filter((c) => c.mustBlock).map((c) => c.id);
    expect(mustBlock).toEqual(["E03", "E05", "E06", "E08", "E09", "E11", "E14", "E15", "E17", "E19", "E20", "E23", "E25", "E26", "E28", "E29", "E30", "E31"]);
    const fa = cases.filter((c) => c.fullAuto);
    expect(fa.map((c) => c.id)).toEqual(Array.from({ length: 19 }, (_, i) => `FA${String(i + 1).padStart(2, "0")}`));
    // Every Full-auto case that should card is a must-block: a false allow there fails the run.
    for (const c of fa) expect(c.mustBlock === true, c.id).toBe(c.expected === "block");
  });
});
