import { describe, expect, it } from "vitest";
import { assertValid, invoiceTotals, InvoiceError, validateInvoice, type Invoice } from "../src/invoice";
import { SEED_INVOICES } from "../src/seed";

const byId = (id: string) => SEED_INVOICES.find((i) => i.id === id)!;

describe("invoiceTotals", () => {
  it("totals a Californian invoice with a taxed and an untaxed line", () => {
    const t = invoiceTotals(byId("INV-1001"));
    expect([t.subtotal, t.tax, t.total]).toEqual([21998, 725, 22723]);
    expect(t.taxByName).toEqual({ "Sales tax": 725 });
  });
  it("totals a Quebec invoice with two tax parts", () => {
    const t = invoiceTotals(byId("INV-1003"));
    expect(t.taxByName).toEqual({ GST: 3790, QST: 7561 });
    expect(t.total).toBe(87151);
  });
  it("rounds tax per line, not on the total", () => {
    const inv: Invoice = {
      ...byId("INV-1001"),
      lines: [
        { description: "a", quantity: 1, unitCents: 6, category: "standard" },
        { description: "b", quantity: 1, unitCents: 6, category: "standard" },
      ],
    };
    // 6 x 7.25% = 0.435 -> 0 per line; on the total it would be 0.87 -> 1.
    expect(invoiceTotals(inv).tax).toBe(0);
  });
});

describe("validateInvoice", () => {
  it("accepts the seed invoices", () => {
    for (const inv of SEED_INVOICES) expect(validateInvoice(inv)).toEqual([]);
  });
  it("lists every problem", () => {
    const bad: Invoice = { ...byId("INV-1001"), id: "", due: "2024-12-01", lines: [{ description: "x", quantity: 0, unitCents: 1.5, category: "standard" }] };
    const errors = validateInvoice(bad);
    expect(errors).toContain("id is empty");
    expect(errors).toContain("due is before issued");
    expect(errors.some((e) => e.includes("quantity"))).toBe(true);
    expect(errors.some((e) => e.includes("unitCents"))).toBe(true);
    expect(() => assertValid(bad)).toThrow(InvoiceError);
  });
});
