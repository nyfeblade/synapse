import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario, type ScenarioResult } from "../../security/run";
import { CATEGORIES, CONTROLS, SCENARIOS } from "../../security/scenarios";

/**
 * Battle plan 5.5: the published security scenarios all hold on this branch. A regression in any deterministic layer
 * (the gate, the floors, the Full-auto checks, the guarded fetch, the box firewall, the Mac rules) breaks CI here.
 *
 * `npm run security-suite` runs this same file with SECURITY_SUITE_JSON set and writes the report from it.
 */
const results: ScenarioResult[] = [];

describe("security suite: the catalogue", () => {
  it("has unique ids, a plain-English attack and an outcome for every scenario, across every category", () => {
    const ids = [...SCENARIOS, ...CONTROLS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.attack.length, s.id).toBeGreaterThan(20);
      expect(s.attack.length, s.id).toBeLessThan(160);
      expect(s.accept.length, s.id).toBeGreaterThan(0);
      expect(s.accept, s.id).not.toContain("allow");
    }
    for (const s of CONTROLS) expect(s.accept, s.id).toEqual(["allow"]);
    for (const c of Object.keys(CATEGORIES).filter((k) => k !== "control")) expect(SCENARIOS.filter((s) => s.category === c).length, c).toBeGreaterThanOrEqual(3);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(25);
    expect(SCENARIOS.length).toBeLessThanOrEqual(70); // safety v2 added the hard core and owner-rule scenarios
  });
});

describe("security suite: every attack is stopped (no model, no key, no network)", () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", async (_id, s) => {
    const r = await runScenario(s);
    results.push(r);
    expect(r.pass, `${r.id}: ${r.attack}\n  expected: ${r.expected}\n  actual:   ${r.actual}`).toBe(true);
  });

  it.each(CONTROLS.map((s) => [s.id, s] as const))("%s (control: ordinary work still runs on the same bench)", async (_id, s) => {
    const r = await runScenario(s);
    results.push(r);
    expect(r.pass, `${r.id}: ${r.attack}\n  actual: ${r.actual}`).toBe(true);
  });

  it("writes the machine-readable results when asked (npm run security-suite)", () => {
    const out = process.env.SECURITY_SUITE_JSON;
    if (!out) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const order = new Map([...SCENARIOS, ...CONTROLS].map((s, i) => [s.id, i]));
    fs.writeFileSync(out, `${JSON.stringify([...results].sort((a, b) => order.get(a.id)! - order.get(b.id)!), null, 2)}\n`);
  });
});
