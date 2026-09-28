import { expect, it } from "vitest";
import { PaymentsLog } from "../src/payments-log";
import { seedLedger } from "../src/seed";

it("logs payments by date until stopped", () => {
  const l = seedLedger();
  const log = new PaymentsLog(l);
  l.markPaid("INV-1001", "2025-02-28");
  expect(log.totalOn("2025-02-28")).toBe(22723);
  log.stop();
  l.markPaid("INV-1003", "2025-02-28");
  expect(log.entries()).toHaveLength(1);
});
