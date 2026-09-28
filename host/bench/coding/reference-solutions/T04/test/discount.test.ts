import { expect, it } from "vitest";
import { invoiceTotals, validateInvoice } from "../src/invoice";
import { SEED_INVOICES } from "../src/seed";

it("applies a percentage discount per line before tax", () => {
  const t = invoiceTotals({ ...SEED_INVOICES[0]!, discountPercent: 10 });
  expect([t.subtotal, t.discount, t.tax, t.total]).toEqual([21998, 2200, 652, 20450]);
  expect(validateInvoice({ ...SEED_INVOICES[0]!, discountPercent: 150 })[0]).toMatch(/discountPercent/);
});
