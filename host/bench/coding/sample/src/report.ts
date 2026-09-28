import { AGING_BUCKETS, type BucketKey } from "./config";
import { daysBetween, type ISODate } from "./dates";
import { invoiceTotals } from "./invoice";
import type { Ledger } from "./ledger";
import { formatMoney, type Cents } from "./money";

export type AgingRow = { customerId: string; customer: string; total: Cents } & Record<BucketKey, Cents>;

export interface AgingReport {
  asOf: ISODate;
  rows: AgingRow[];
  totals: Record<BucketKey, Cents> & { total: Cents };
}

/** The bucket for an invoice that is `daysOverdue` days past its due date (0 = due today). */
export function bucketFor(daysOverdue: number): BucketKey {
  const b = AGING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max);
  if (!b) throw new Error(`no bucket for ${daysOverdue}`);
  return b.key;
}

function emptyBuckets(): Record<BucketKey, Cents> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) as Record<BucketKey, Cents>;
}

/** Unpaid invoices by customer and by how far past due they are on `asOf`. Rows sort by customer name. */
export function agingReport(ledger: Ledger, asOf: ISODate): AgingReport {
  const byCustomer = new Map<string, AgingRow>();
  for (const e of ledger.outstanding()) {
    const inv = e.invoice;
    const row =
      byCustomer.get(inv.customerId) ??
      ({ customerId: inv.customerId, customer: ledger.customers.displayName(inv.customerId), total: 0, ...emptyBuckets() } as AgingRow);
    const amount = invoiceTotals(inv).total;
    const key = bucketFor(daysBetween(inv.due, asOf));
    row[key] += amount;
    row.total += amount;
    byCustomer.set(inv.customerId, row);
  }
  const rows = [...byCustomer.values()].sort((a, b) => a.customer.localeCompare(b.customer) || a.customerId.localeCompare(b.customerId));
  const totals = { ...emptyBuckets(), total: 0 };
  for (const r of rows) {
    for (const b of AGING_BUCKETS) totals[b.key] += r[b.key];
    totals.total += r.total;
  }
  return { asOf, rows, totals };
}

/** A fixed-width text table of the report. */
export function renderAging(report: AgingReport): string {
  const head = ["Customer", ...AGING_BUCKETS.map((b) => b.label), "Total"];
  const line = (name: string, r: Record<BucketKey, Cents> & { total: Cents }) => [
    name,
    ...AGING_BUCKETS.map((b) => formatMoney(r[b.key], { showZero: false })),
    formatMoney(r.total),
  ];
  const body = [...report.rows.map((r) => line(r.customer, r)), line("TOTAL", report.totals)];
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [`Aging as of ${report.asOf}`, fmt(head), ...body.map(fmt)].join("\n");
}
