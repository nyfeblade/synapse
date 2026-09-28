import { describe, expect, it } from "vitest";
import { agingReport, bucketFor, renderAging } from "../src/report";
import { seedLedger } from "../src/seed";

describe("agingReport", () => {
  it("buckets unpaid invoices by customer", () => {
    const r = agingReport(seedLedger(), "2025-03-10");
    expect(r.rows.map((x) => x.customer)).toEqual(["Acme Tools", "Birch & Co", "Cedar Books", "Delta Foods"]);
    const acme = r.rows[0]!;
    expect(acme.d31_60).toBe(22723); // INV-1001, five weeks late
    expect(acme.current).toBe(23488); // INV-1005, not yet due
    expect(acme.total).toBe(22723 + 23488);
    expect(r.rows[1]!.d1_30).toBe(240250);
    expect(r.rows[2]!.d31_60).toBe(87151);
    expect(r.rows[3]!.d1_30).toBe(39569);
    expect(r.totals.total).toBe(22723 + 240250 + 87151 + 39569 + 23488);
  });
  it("leaves paid invoices out", () => {
    const l = seedLedger();
    l.markPaid("INV-1002", "2025-02-01");
    expect(agingReport(l, "2025-03-10").rows.map((x) => x.customerId)).not.toContain("c-birch");
  });
  it("maps far-out day counts to the outer buckets", () => {
    expect(bucketFor(-5)).toBe("current");
    expect(bucketFor(45)).toBe("d31_60");
    expect(bucketFor(75)).toBe("d61_90");
    expect(bucketFor(400)).toBe("d90plus");
  });
  it("renders a table with a total line", () => {
    const text = renderAging(agingReport(seedLedger(), "2025-03-10"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Aging as of 2025-03-10");
    expect(lines[1]).toMatch(/^Customer\s+Current\s+1-30\s+31-60\s+61-90\s+90\+\s+Total$/);
    expect(lines.at(-1)).toMatch(/^TOTAL\s/);
    expect(text).toContain("$4,131.81");
  });
});
