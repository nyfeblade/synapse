import { expect, it } from "vitest";
import { invoiceTotals, validateInvoice, type Invoice } from "../src/invoice";
import { SEED_INVOICES } from "../src/seed";

const acme = SEED_INVOICES.find((i) => i.id === "INV-1001")!;
const withDiscount = (p: unknown): Invoice => ({ ...acme, discountPercent: p } as unknown as Invoice);

it("discounts each line before tax and reports the discount", () => {
  const t = invoiceTotals(withDiscount(10));
  // wrench 9998 - 1000 = 8998, taxed 7.25% = 652; install 12000 - 1200 = 10800, untaxed
  expect(t.subtotal).toBe(21998);
  expect((t as unknown as { discount: number }).discount).toBe(2200);
  expect(t.tax).toBe(652);
  expect(t.total).toBe(21998 - 2200 + 652);
});

it("rounds the discount per line", () => {
  const inv = { ...withDiscount(10), lines: [0, 1].map(() => ({ description: "x", quantity: 1, unitCents: 5, category: "services" as const })) };
  const t = invoiceTotals(inv) as unknown as { discount: number; total: number };
  expect(t.discount).toBe(2);
  expect(t.total).toBe(8);
});

it("treats absent and 0 as no discount, and 100 as free", () => {
  const base = invoiceTotals(acme) as unknown as { discount: number; total: number; tax: number };
  expect(base.discount).toBe(0);
  expect(base.total).toBe(22723);
  expect((invoiceTotals(withDiscount(0)) as unknown as { total: number }).total).toBe(22723);
  const free = invoiceTotals(withDiscount(100)) as unknown as { discount: number; total: number; tax: number };
  expect([free.discount, free.tax, free.total]).toEqual([21998, 0, 0]);
});

it("validates the range", () => {
  for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(validateInvoice(withDiscount(bad)).some((e) => e.includes("discountPercent"))).toBe(true);
  }
  for (const ok of [0, 12.5, 100]) expect(validateInvoice(withDiscount(ok))).toEqual([]);
});
