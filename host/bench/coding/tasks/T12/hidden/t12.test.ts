import { expect, it } from "vitest";
import * as index from "../src/index";
import { SEED_INVOICES, seedLedger } from "../src/seed";

type AnyEmitter = { on(name: string, fn: (p: unknown) => void): () => void };
type Ledgerish = ReturnType<typeof seedLedger> & { events: AnyEmitter };
const events = (l: ReturnType<typeof seedLedger>) => (l as Ledgerish).events;

function freshLedger() {
  const l = index.createLedger(new index.MemoryCustomerStore(index.SEED_CUSTOMERS));
  return l as Ledgerish;
}

it("emits invoice.issued after the invoice is stored", () => {
  const l = freshLedger();
  const seen: unknown[] = [];
  l.events.on("invoice.issued", (p) => seen.push([p, l.get((p as { id: string }).id).invoice.id]));
  l.issue(SEED_INVOICES[0]!);
  expect(seen).toEqual([[{ id: "INV-1001", customerId: "c-acme", total: 22723 }, "INV-1001"]]);
  expect(() => l.issue(SEED_INVOICES[0]!)).toThrow();
  expect(() => l.issue({ ...SEED_INVOICES[1]!, id: "X", customerId: "c-ghost" })).toThrow();
  expect(seen).toHaveLength(1);
});

it("emits invoice.paid after marking, and nothing when markPaid throws", () => {
  const l = seedLedger();
  const seen: unknown[] = [];
  events(l).on("invoice.paid", (p) => seen.push([p, l.isPaid((p as { id: string }).id)]));
  l.markPaid("INV-1003", "2025-02-02");
  expect(seen).toEqual([[{ id: "INV-1003", paidOn: "2025-02-02", total: 87151 }, true]]);
  expect(() => l.markPaid("INV-1003", "2025-02-03")).toThrow();
  expect(() => l.markPaid("INV-1004", "2025-01-01")).toThrow();
  expect(() => l.markPaid("NOPE", "2025-03-01")).toThrow();
  expect(seen).toHaveLength(1);
});

it("PaymentsLog records payments by date, in order, until stopped", () => {
  const PaymentsLog = (index as unknown as { PaymentsLog: new (l: unknown) => {
    totalOn(d: string): number; entries(): { id: string; paidOn: string; total: number }[]; stop(): void;
  } }).PaymentsLog;
  expect(PaymentsLog).toBeTypeOf("function");
  const l = seedLedger();
  l.markPaid("INV-1005", "2025-02-25"); // before the log exists: not recorded
  const log = new PaymentsLog(l);
  l.markPaid("INV-1002", "2025-03-01");
  l.markPaid("INV-1001", "2025-02-28");
  l.markPaid("INV-1004", "2025-03-01");
  expect(log.totalOn("2025-03-01")).toBe(240250 + 39569);
  expect(log.totalOn("2025-02-28")).toBe(22723);
  expect(log.totalOn("2025-02-25")).toBe(0);
  expect(log.entries().map((e) => e.id)).toEqual(["INV-1002", "INV-1001", "INV-1004"]);
  expect(log.entries()[0]).toEqual({ id: "INV-1002", paidOn: "2025-03-01", total: 240250 });
  log.stop();
  l.markPaid("INV-1003", "2025-03-01");
  expect(log.totalOn("2025-03-01")).toBe(240250 + 39569);
  expect(log.entries()).toHaveLength(3);
});
