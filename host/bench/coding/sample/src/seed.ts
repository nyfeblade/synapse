import type { Customer } from "./customers";
import { MemoryCustomerStore } from "./customers";
import type { Invoice } from "./invoice";
import { createLedger, type Ledger } from "./ledger";

export const SEED_CUSTOMERS: Customer[] = [
  { id: "c-acme", name: "Acme Tools", email: "billing@acme.test", region: "US-CA" },
  { id: "c-birch", name: "Birch & Co", email: "ap@birch.test", region: "GB" },
  { id: "c-cedar", name: "Cedar Books", email: "accounts@cedar.test", region: "CA-QC" },
  { id: "c-delta", name: "Delta Foods", email: "pay@delta.test", region: "DE" },
];

export const SEED_INVOICES: Invoice[] = [
  {
    id: "INV-1001",
    customerId: "c-acme",
    region: "US-CA",
    issued: "2025-01-02",
    due: "2025-02-01",
    lines: [
      { description: "Torque wrench", quantity: 2, unitCents: 4_999, category: "standard" },
      { description: "Install", quantity: 1, unitCents: 12_000, category: "services" },
    ],
  },
  {
    id: "INV-1002",
    customerId: "c-birch",
    region: "GB",
    issued: "2025-01-10",
    due: "2025-02-09",
    lines: [
      { description: "Consulting day", quantity: 3, unitCents: 65_000, category: "services" },
      { description: "Field guide", quantity: 5, unitCents: 1_250, category: "books" },
    ],
  },
  {
    id: "INV-1003",
    customerId: "c-cedar",
    region: "CA-QC",
    issued: "2025-01-15",
    due: "2025-01-30",
    lines: [{ description: "Shelving", quantity: 4, unitCents: 18_950, category: "standard" }],
  },
  {
    id: "INV-1004",
    customerId: "c-delta",
    region: "DE",
    issued: "2025-02-01",
    due: "2025-03-03",
    lines: [
      { description: "Olive oil (case)", quantity: 10, unitCents: 3_420, category: "food" },
      { description: "Delivery", quantity: 1, unitCents: 2_500, category: "services" },
    ],
  },
  {
    id: "INV-1005",
    customerId: "c-acme",
    region: "US-CA",
    issued: "2025-02-20",
    due: "2025-03-22",
    lines: [{ description: "Bench vise", quantity: 1, unitCents: 21_900, category: "standard" }],
  },
];

/** A ledger with the seed customers and invoices, nothing paid. */
export function seedLedger(): Ledger {
  const ledger = createLedger(new MemoryCustomerStore(SEED_CUSTOMERS));
  for (const inv of SEED_INVOICES) ledger.issue(inv);
  return ledger;
}
