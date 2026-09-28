import { DEFAULTS, type LedgerConfig } from "./config";
import { MemoryCustomerStore, CustomerDirectory, type CustomerStore } from "./customers";
import { stringifyCsv } from "./csv";
import { compareDates, daysBetween, isValidDate, type ISODate } from "./dates";
import { assertValid, invoiceTotals, type Invoice } from "./invoice";
import { percentOf, type Cents } from "./money";

export interface Entry {
  invoice: Invoice;
  paidOn?: ISODate;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class Ledger {
  readonly config: LedgerConfig;
  readonly customers: CustomerDirectory;
  private entries = new Map<string, Entry>();

  constructor(store: CustomerStore, config: Partial<LedgerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.customers = new CustomerDirectory(store, this.config.directoryCacheSize);
  }

  /** Records a new invoice. The customer must exist and the id must be new. */
  issue(inv: Invoice): void {
    assertValid(inv);
    if (this.entries.has(inv.id)) throw new LedgerError(`invoice ${inv.id} already exists`);
    if (!this.customers.get(inv.customerId)) throw new LedgerError(`invoice ${inv.id}: unknown customer "${inv.customerId}"`);
    this.entries.set(inv.id, { invoice: { ...inv, lines: inv.lines.map((l) => ({ ...l })) } });
  }

  get(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new LedgerError(`no invoice ${id}`);
    return e;
  }

  isPaid(id: string): boolean {
    return this.get(id).paidOn !== undefined;
  }

  /** Marks an invoice paid in full. Paying twice, or before the issue date, is an error. */
  markPaid(id: string, paidOn: ISODate): void {
    const e = this.get(id);
    if (!isValidDate(paidOn)) throw new LedgerError(`paidOn is not a date: "${paidOn}"`);
    if (e.paidOn !== undefined) throw new LedgerError(`invoice ${id} is already paid`);
    if (compareDates(paidOn, e.invoice.issued) < 0) throw new LedgerError(`invoice ${id} cannot be paid before it was issued`);
    e.paidOn = paidOn;
  }

  /** Unpaid entries, oldest due date first, then by id. */
  outstanding(): Entry[] {
    return [...this.entries.values()]
      .filter((e) => e.paidOn === undefined)
      .sort((a, b) => compareDates(a.invoice.due, b.invoice.due) || a.invoice.id.localeCompare(b.invoice.id));
  }

  all(): Entry[] {
    return [...this.entries.values()].sort((a, b) => a.invoice.id.localeCompare(b.invoice.id));
  }

  total(id: string): Cents {
    return invoiceTotals(this.get(id).invoice).total;
  }

  /** Sum of the totals of every unpaid invoice. */
  balance(): Cents {
    return this.outstanding().reduce((a, e) => a + invoiceTotals(e.invoice).total, 0);
  }

  /**
   * The late fee on an unpaid invoice as of `asOf`: nothing within `graceDays` after the due date,
   * then `lateFeePercent` of the invoice total, capped at `lateFeeCapCents`. Paid invoices owe none.
   */
  lateFee(id: string, asOf: ISODate): Cents {
    const e = this.get(id);
    if (e.paidOn !== undefined) return 0;
    const overdue = daysBetween(e.invoice.due, asOf);
    if (overdue <= this.config.graceDays) return 0;
    return Math.min(this.config.lateFeeCapCents, percentOf(invoiceTotals(e.invoice).total, this.config.lateFeePercent));
  }

  /** One CSV row per invoice, sorted by id. Amounts are in cents. */
  exportCsv(): string {
    const rows = this.all().map((e) => {
      const t = invoiceTotals(e.invoice);
      return [
        e.invoice.id,
        this.customers.displayName(e.invoice.customerId),
        e.invoice.issued,
        e.invoice.due,
        String(t.subtotal),
        String(t.tax),
        String(t.total),
        e.paidOn ? `paid ${e.paidOn}` : "open",
      ];
    });
    return stringifyCsv([["id", "customer", "issued", "due", "subtotal", "tax", "total", "status"], ...rows]);
  }
}

/**
 * The ledger most callers want. It uses a 15-day grace period, which is the company policy, not
 * the library default in config.ts.
 */
export function createLedger(store: CustomerStore = new MemoryCustomerStore(), options: Partial<LedgerConfig> = {}): Ledger {
  return new Ledger(store, { graceDays: 15, ...options });
}
