import { describe, expect, it } from "vitest";
import { MemoryCustomerStore } from "../src/customers";
import { createLedger, LedgerError } from "../src/ledger";
import { SEED_CUSTOMERS, SEED_INVOICES, seedLedger } from "../src/seed";

describe("Ledger", () => {
  it("issues invoices and refuses duplicates or unknown customers", () => {
    const l = seedLedger();
    expect(() => l.issue(SEED_INVOICES[0]!)).toThrow(LedgerError);
    expect(() => l.issue({ ...SEED_INVOICES[0]!, id: "INV-9", customerId: "c-ghost" })).toThrow(/unknown customer/);
  });
  it("tracks payment and the outstanding balance", () => {
    const l = seedLedger();
    expect(l.balance()).toBe(22723 + 240250 + 87151 + 39569 + 23488);
    l.markPaid("INV-1002", "2025-02-05");
    expect(l.isPaid("INV-1002")).toBe(true);
    expect(l.balance()).toBe(22723 + 87151 + 39569 + 23488);
    expect(l.outstanding().map((e) => e.invoice.id)).toEqual(["INV-1003", "INV-1001", "INV-1004", "INV-1005"]);
  });
  it("rejects paying twice or before issue", () => {
    const l = seedLedger();
    l.markPaid("INV-1001", "2025-01-20");
    expect(() => l.markPaid("INV-1001", "2025-01-21")).toThrow(/already paid/);
    expect(() => l.markPaid("INV-1003", "2025-01-01")).toThrow(/before it was issued/);
  });
  it("charges a capped late fee well past the grace period, and none inside it", () => {
    const l = seedLedger();
    expect(l.lateFee("INV-1003", "2025-03-10")).toBe(1307); // 1.5% of 87151
    expect(l.lateFee("INV-1004", "2025-03-10")).toBe(0); // a week late
    expect(l.lateFee("INV-1005", "2025-03-10")).toBe(0); // not due
    const capped = createLedger(new MemoryCustomerStore(SEED_CUSTOMERS), { lateFeeCapCents: 1000 });
    capped.issue(SEED_INVOICES[1]!);
    expect(capped.lateFee("INV-1002", "2025-04-30")).toBe(1000);
    l.markPaid("INV-1003", "2025-03-01");
    expect(l.lateFee("INV-1003", "2025-03-10")).toBe(0);
  });
  it("exports CSV sorted by id with quoted names", () => {
    const l = seedLedger();
    l.markPaid("INV-1001", "2025-01-20");
    const lines = l.exportCsv().trimEnd().split("\n");
    expect(lines[0]).toBe("id,customer,issued,due,subtotal,tax,total,status");
    expect(lines[1]).toBe("INV-1001,Acme Tools,2025-01-02,2025-02-01,21998,725,22723,paid 2025-01-20");
    expect(lines[2]).toBe("INV-1002,Birch & Co,2025-01-10,2025-02-09,201250,39000,240250,open");
    expect(lines).toHaveLength(6);
  });
});
