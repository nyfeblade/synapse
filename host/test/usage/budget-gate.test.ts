/**
 * Bug 296: the key proxy asks the spend budget before each model call, but the budget exists only once Phase 5 is wired,
 * well after boot conformance may start its real model calls. Until then the proxy's answer was "always ok" and the spend
 * sink did nothing. The gate refuses until the budget is wired, and conformance waits for it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetGate } from "../../usage/budget-gate";

describe("BudgetGate", () => {
  it("refuses every call and records nothing until the budget is wired, then asks it", async () => {
    const g = new BudgetGate();
    expect(g.allow("b1")).toEqual({ ok: false, message: expect.stringMatching(/starting/i) });
    const seen: unknown[] = [];
    g.unreported("b1", "m", { inputTokens: 1 } as never); // before wiring: queued, not lost
    let wired = false;
    void g.ready.then(() => { wired = true; });
    await Promise.resolve();
    expect(wired).toBe(false);
    g.wire({ allow: (b) => ({ ok: b !== "over", message: b === "over" ? "budget used" : null }), unreported: (b, m, u) => seen.push({ b, m, u }) });
    await g.ready;
    expect(wired).toBe(true);
    expect(g.allow("b1")).toEqual({ ok: true, message: null });
    expect(g.allow("over")).toEqual({ ok: false, message: "budget used" });
    expect(seen).toEqual([{ b: "b1", m: "m", u: { inputTokens: 1 } }]);
    g.unreported("b2", "m2", { inputTokens: 2 } as never);
    expect(seen).toHaveLength(2);
  });

  it("host/app.ts routes the proxy through the gate and boot conformance waits for it", () => {
    const app = fs.readFileSync(path.join(__dirname, "../../app.ts"), "utf8");
    expect(app).toMatch(/new BudgetGate\(\)/);
    expect(app).toMatch(/ensure: async \(\) => \{\s*await budgetGate\.ready;/);
    expect(app).toMatch(/budgetGate\.wire\(/);
    expect(app).not.toMatch(/let proxyAllow[^\n]*ok: true/);
  });
});
