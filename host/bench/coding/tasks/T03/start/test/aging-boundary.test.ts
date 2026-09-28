import { expect, it } from "vitest";
import { agingReport } from "../src/report";
import { seedLedger } from "../src/seed";

it("puts an invoice exactly 30 days past due in the 1-30 column", () => {
  const ledger = seedLedger();
  for (const id of ["INV-1002", "INV-1003", "INV-1004", "INV-1005"]) ledger.markPaid(id, "2025-02-20");
  // INV-1001 is due 2025-02-01; 2025-03-03 is 30 days later.
  const row = agingReport(ledger, "2025-03-03").rows[0]!;
  expect(row.d1_30).toBe(22723);
  expect(row.d31_60).toBe(0);
});
