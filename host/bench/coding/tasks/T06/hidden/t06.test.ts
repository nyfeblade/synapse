import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { percentOf } from "../src/money";
import * as tax from "../src/tax";

const root = path.resolve(import.meta.dirname, "..");

/** The original switch, frozen here as the behaviour oracle. */
function oracle(region: string, category: string, amount: number) {
  const part = (name: string, rate: number) => ({ name, rate, cents: percentOf(amount, rate) });
  const res = (parts: { name: string; rate: number; cents: number }[]) => ({ parts, total: parts.reduce((a, p) => a + p.cents, 0) });
  switch (region) {
    case "US-CA": return category === "food" || category === "services" ? res([]) : res([part("Sales tax", 7.25)]);
    case "US-NY": return category === "food" ? res([]) : res([part("State tax", 4), part("City tax", 4.5)]);
    case "US-OR": return res([]);
    case "CA-ON": return category === "food" ? res([]) : category === "books" ? res([part("HST", 5)]) : res([part("HST", 13)]);
    case "CA-QC": return category === "food" ? res([]) : res([part("GST", 5), part("QST", 9.975)]);
    case "GB": return category === "food" || category === "books" ? res([]) : res([part("VAT", 20)]);
    case "DE": return category === "food" || category === "books" ? res([part("USt", 7)]) : res([part("USt", 19)]);
  }
  throw new Error(region);
}

it("behaves exactly like the original for every region, category and amount", () => {
  const amounts = [0, 1, 6, 99, 1001, 9998, 75800, 123457, -2500];
  for (const r of tax.REGIONS) for (const c of tax.CATEGORIES) for (const a of amounts) {
    expect([r, c, a, tax.taxFor(r, c, a)]).toEqual([r, c, a, oracle(r, c, a)]);
  }
  expect(tax.headlineRate("CA-QC", "standard")).toBe(14.975);
});

it("is table-driven: TAX_RULES has one entry per region and there is no switch", () => {
  const rules = (tax as unknown as { TAX_RULES?: Record<string, unknown> }).TAX_RULES;
  expect(rules).toBeTypeOf("object");
  expect(Object.keys(rules!).sort()).toEqual([...tax.REGIONS].sort());
  const src = fs.readFileSync(path.join(root, "src/tax.ts"), "utf8");
  expect(src).not.toMatch(/\bswitch\s*\(/);
});
