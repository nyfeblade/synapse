import { expect, it } from "vitest";
import * as index from "../src/index";

type Result = { invoices: index.Invoice[]; errors: { line: number; message: string }[] };
const importInvoices = (csv: string): Result => (index as unknown as { importInvoices: (c: string) => Result }).importInvoices(csv);

const HEAD = "id,customerId,region,issued,due,description,quantity,unit,category";

it("groups rows into invoices in order of first appearance", () => {
  const csv = [
    HEAD,
    "A-1,c-acme,US-CA,2025-01-02,2025-02-01,Torque wrench,2,49.99,standard",
    "B-1,c-birch,GB,2025-01-10,2025-02-09,Consulting day,3,650,services",
    "A-1,c-acme,US-CA,2025-01-02,2025-02-01,Install,1,120.00,services",
  ].join("\n") + "\n";
  const r = importInvoices(csv);
  expect(r.errors).toEqual([]);
  expect(r.invoices.map((i) => i.id)).toEqual(["A-1", "B-1"]);
  expect(r.invoices[0]).toEqual({
    id: "A-1", customerId: "c-acme", region: "US-CA", issued: "2025-01-02", due: "2025-02-01",
    lines: [
      { description: "Torque wrench", quantity: 2, unitCents: 4999, category: "standard" },
      { description: "Install", quantity: 1, unitCents: 12000, category: "services" },
    ],
  });
  expect(index.invoiceTotals(r.invoices[0]!).total).toBe(22723);
});

it("accepts columns in any order and quoted money with commas", () => {
  const csv = 'unit,id,customerId,region,issued,due,description,quantity,category\n"1,234.50",Z-9,c-delta,DE,2025-02-01,2025-03-03,"Oil, olive",2,food\n';
  const r = importInvoices(csv);
  expect(r.errors).toEqual([]);
  expect(r.invoices[0]!.lines[0]).toEqual({ description: "Oil, olive", quantity: 2, unitCents: 123450, category: "food" });
});

it("reports a missing column once, at line 1, with no invoices", () => {
  const r = importInvoices("id,customerId,region,issued,due,description,quantity,category\nA,c,GB,2025-01-01,2025-01-02,x,1,standard\n");
  expect(r.invoices).toEqual([]);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]!.line).toBe(1);
  expect(r.errors[0]!.message).toMatch(/unit/);
});

it("drops the whole invoice for any bad row, reports every bad row, and counts blank lines", () => {
  const csv = [
    HEAD,
    "G-1,c-acme,US-CA,2025-01-02,2025-02-01,Good,1,10.00,standard", // line 2
    "",                                                              // line 3 (blank)
    "B-1,c-acme,US-CA,2025-01-02,2025-02-01,Zero qty,0,10.00,standard", // line 4
    "B-1,c-acme,US-CA,2025-01-02,2025-02-01,Half qty,1.5,10.00,standard", // line 5
    "B-1,c-acme,US-CA,2025-01-02,2025-02-01,Fine row,1,10.00,standard", // line 6
    "C-1,c-acme,US-CA,2025-01-02,2025-02-01,Bad money,1,ten,standard", // line 7
    "D-1,c-acme,US-CA,2025-01-02,2025-02-01,First,1,1.00,standard", // line 8
    "D-1,c-acme,US-CA,2025-01-03,2025-02-01,Other issue date,1,1.00,standard", // line 9
    "E-1,c-acme,US-CA,2025-02-30,2025-03-01,Bad date,1,1.00,standard", // line 10
  ].join("\n") + "\n";
  const r = importInvoices(csv);
  expect(r.invoices.map((i) => i.id)).toEqual(["G-1"]);
  expect(r.errors.map((e) => e.line).sort((a, b) => a - b)).toEqual([4, 5, 7, 9, 10]);
});

it("runs validateInvoice on each finished invoice, reporting at its first row", () => {
  const csv = [
    HEAD,
    "OK-1,c-acme,GB,2025-01-02,2025-02-01,Fine,1,5.00,services",
    "V-1,c-acme,GB,2025-03-02,2025-02-01,Due before issue,1,5.00,services",
    "V-1,c-acme,GB,2025-03-02,2025-02-01,Second line,1,5.00,services",
  ].join("\n");
  const r = importInvoices(csv);
  expect(r.invoices.map((i) => i.id)).toEqual(["OK-1"]);
  expect(r.errors.map((e) => e.line)).toEqual([3]);
  expect(r.errors[0]!.message).toMatch(/due is before issued/);
});

it("rejects unknown regions and categories", () => {
  const csv = [HEAD, "R-1,c-acme,FR,2025-01-02,2025-02-01,x,1,5.00,standard", "K-1,c-acme,GB,2025-01-02,2025-02-01,x,1,5.00,gadgets"].join("\n");
  const r = importInvoices(csv);
  expect(r.invoices).toEqual([]);
  expect(r.errors.map((e) => e.line).sort()).toEqual([2, 3]);
});
