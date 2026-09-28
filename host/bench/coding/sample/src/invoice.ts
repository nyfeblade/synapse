import { compareDates, isValidDate, type ISODate } from "./dates";
import { multiply, type Cents } from "./money";
import { isCategory, isRegion, taxFor, type Category, type Region, type TaxResult } from "./tax";

export interface Line {
  description: string;
  /** A positive whole number. */
  quantity: number;
  unitCents: Cents;
  category: Category;
}

export interface Invoice {
  id: string;
  customerId: string;
  region: Region;
  issued: ISODate;
  due: ISODate;
  lines: Line[];
  notes?: string;
}

export interface LineTotal {
  net: Cents;
  tax: TaxResult;
}

export interface Totals {
  /** Sum of line nets, before tax. */
  subtotal: Cents;
  tax: Cents;
  total: Cents;
  /** Tax summed per printed name ("VAT", "GST", ...), in first-seen order. */
  taxByName: Record<string, Cents>;
  lines: LineTotal[];
}

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceError";
  }
}

/** Every problem with an invoice, as human-readable strings. Empty means valid. */
export function validateInvoice(inv: Invoice): string[] {
  const errors: string[] = [];
  if (!inv.id.trim()) errors.push("id is empty");
  if (!inv.customerId.trim()) errors.push("customerId is empty");
  if (!isRegion(inv.region)) errors.push(`unknown region "${inv.region}"`);
  if (!isValidDate(inv.issued)) errors.push(`issued is not a date: "${inv.issued}"`);
  if (!isValidDate(inv.due)) errors.push(`due is not a date: "${inv.due}"`);
  if (isValidDate(inv.issued) && isValidDate(inv.due) && compareDates(inv.due, inv.issued) < 0) {
    errors.push("due is before issued");
  }
  if (inv.lines.length === 0) errors.push("an invoice needs at least one line");
  inv.lines.forEach((l, i) => {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) errors.push(`line ${i + 1}: quantity must be a positive whole number`);
    if (!Number.isSafeInteger(l.unitCents)) errors.push(`line ${i + 1}: unitCents must be whole cents`);
    if (!isCategory(l.category)) errors.push(`line ${i + 1}: unknown category "${l.category}"`);
  });
  return errors;
}

export function assertValid(inv: Invoice): Invoice {
  const errors = validateInvoice(inv);
  if (errors.length) throw new InvoiceError(`invoice ${inv.id || "(no id)"}: ${errors.join("; ")}`);
  return inv;
}

export function lineNet(line: Line): Cents {
  return multiply(line.unitCents, line.quantity);
}

/** Totals for an invoice. Tax is computed and rounded per line, then summed. */
export function invoiceTotals(inv: Invoice): Totals {
  const lines = inv.lines.map((l) => {
    const net = lineNet(l);
    return { net, tax: taxFor(inv.region, l.category, net) };
  });
  const taxByName: Record<string, Cents> = {};
  for (const l of lines) for (const p of l.tax.parts) taxByName[p.name] = (taxByName[p.name] ?? 0) + p.cents;
  const subtotal = lines.reduce((a, l) => a + l.net, 0);
  const tax = lines.reduce((a, l) => a + l.tax.total, 0);
  return { subtotal, tax, total: subtotal + tax, taxByName, lines };
}
