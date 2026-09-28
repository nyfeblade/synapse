import { expect, it } from "vitest";
import { AGING_BUCKETS } from "../src/config";
import { daysBetween } from "../src/dates";
import { agingReport, bucketFor } from "../src/report";
import { seedLedger } from "../src/seed";

it("daysBetween counts whole days, same day is 0 (its documented contract)", () => {
  expect(daysBetween("2025-01-01", "2025-01-01")).toBe(0);
  expect(daysBetween("2025-01-01", "2025-01-02")).toBe(1);
  expect(daysBetween("2025-01-10", "2025-01-01")).toBe(-9);
  expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  expect(daysBetween("2025-02-01", "2025-03-03")).toBe(30);
});

it("keeps the bucket table and bucketFor as documented", () => {
  expect(AGING_BUCKETS.map((b) => [b.key, b.min, b.max])).toEqual([
    ["current", -Infinity, 0],
    ["d1_30", 1, 30],
    ["d31_60", 31, 60],
    ["d61_90", 61, 90],
    ["d90plus", 91, Infinity],
  ]);
  expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketFor)).toEqual(["current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90plus"]);
});

function onlyAcme() {
  const ledger = seedLedger();
  for (const id of ["INV-1002", "INV-1003", "INV-1004", "INV-1005"]) ledger.markPaid(id, "2025-02-20");
  return ledger; // INV-1001, due 2025-02-01, total 22723
}

it("places INV-1001 in the right column on each boundary day", () => {
  const cases: [string, string][] = [
    ["2025-02-01", "current"],
    ["2025-02-02", "d1_30"],
    ["2025-03-03", "d1_30"],
    ["2025-03-04", "d31_60"],
    ["2025-04-02", "d31_60"],
    ["2025-04-03", "d61_90"],
  ];
  for (const [asOf, key] of cases) {
    const row = agingReport(onlyAcme(), asOf).rows[0]!;
    expect([asOf, row[key as "current"]]).toEqual([asOf, 22723]);
  }
});

it("charges no late fee through the last grace day and a fee the day after", () => {
  const ledger = onlyAcme(); // createLedger: 15 grace days
  expect(ledger.lateFee("INV-1001", "2025-02-16")).toBe(0);
  expect(ledger.lateFee("INV-1001", "2025-02-17")).toBe(341); // 1.5% of 22723
});
