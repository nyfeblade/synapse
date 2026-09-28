import { parseCsv } from "./csv";
import { isValidDate } from "./dates";
import { validateInvoice, type Invoice } from "./invoice";
import { parseMoney } from "./money";
import { isCategory, isRegion, type Category, type Region } from "./tax";

export interface ImportError {
  /** 1-based line in the file; the header is line 1. */
  line: number;
  message: string;
}

export interface ImportResult {
  invoices: Invoice[];
  errors: ImportError[];
}

const COLUMNS = ["id", "customerId", "region", "issued", "due", "description", "quantity", "unit", "category"] as const;
type Column = (typeof COLUMNS)[number];
const SHARED = ["customerId", "region", "issued", "due"] as const;

interface Draft {
  invoice: Invoice;
  firstLine: number;
  bad: boolean;
}

/** Reads invoices from CSV, one row per line item. A bad row drops its whole invoice. */
export function importInvoices(csv: string): ImportResult {
  const lines = csv.split(/\r?\n/);
  const errors: ImportError[] = [];
  let header: string[];
  try {
    header = (parseCsv(lines[0] ?? "")[0] ?? []).map((h) => h.trim());
  } catch (e) {
    return { invoices: [], errors: [{ line: 1, message: (e as Error).message }] };
  }
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { invoices: [], errors: [{ line: 1, message: `missing column(s): ${missing.join(", ")}` }] };
  const at = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<Column, number>;

  const drafts = new Map<string, Draft>();
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.trim() === "") continue;
    const line = i + 1;
    let row: string[];
    try {
      row = parseCsv(text)[0] ?? [];
    } catch (e) {
      errors.push({ line, message: (e as Error).message });
      continue;
    }
    const get = (c: Column) => (row[at[c]] ?? "").trim();
    const problems: string[] = [];
    if (row.length !== header.length) problems.push(`expected ${header.length} fields, got ${row.length}`);
    const id = get("id");
    if (!id) problems.push("id is empty");
    if (!isRegion(get("region"))) problems.push(`unknown region "${get("region")}"`);
    if (!isCategory(get("category"))) problems.push(`unknown category "${get("category")}"`);
    for (const d of ["issued", "due"] as const) if (!isValidDate(get(d))) problems.push(`${d} is not a date: "${get(d)}"`);
    const quantity = /^\d+$/.test(get("quantity")) ? Number(get("quantity")) : Number.NaN;
    if (!(quantity > 0)) problems.push(`quantity must be a positive whole number, got "${get("quantity")}"`);
    let unitCents = 0;
    try {
      unitCents = parseMoney(get("unit"));
    } catch {
      problems.push(`unit is not a money amount: "${get("unit")}"`);
    }

    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        invoice: { id, customerId: get("customerId"), region: get("region") as Region, issued: get("issued"), due: get("due"), lines: [] },
        firstLine: line,
        bad: false,
      };
      drafts.set(id, draft);
    } else {
      for (const k of SHARED) {
        if (draft.invoice[k] !== get(k)) problems.push(`${k} "${get(k)}" disagrees with line ${draft.firstLine} ("${draft.invoice[k]}")`);
      }
    }
    if (problems.length) {
      draft.bad = true;
      errors.push({ line, message: problems.join("; ") });
      continue;
    }
    draft.invoice.lines.push({ description: get("description"), quantity, unitCents, category: get("category") as Category });
  }

  const invoices: Invoice[] = [];
  for (const d of drafts.values()) {
    if (d.bad) continue;
    const problems = validateInvoice(d.invoice);
    if (problems.length) {
      errors.push({ line: d.firstLine, message: problems.join("; ") });
      continue;
    }
    invoices.push(d.invoice);
  }
  errors.sort((a, b) => a.line - b.line);
  return { invoices, errors };
}
