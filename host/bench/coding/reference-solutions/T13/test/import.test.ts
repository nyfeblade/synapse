import { expect, it } from "vitest";
import { importInvoices } from "../src/import";

it("imports rows and reports bad ones by file line", () => {
  const csv = "id,customerId,region,issued,due,description,quantity,unit,category\nA,c-acme,GB,2025-01-01,2025-01-31,x,2,1.50,services\n\nB,c-acme,GB,2025-01-01,2025-01-31,y,0,1.50,services\n";
  const r = importInvoices(csv);
  expect(r.invoices.map((i) => i.id)).toEqual(["A"]);
  expect(r.errors.map((e) => e.line)).toEqual([4]);
});
