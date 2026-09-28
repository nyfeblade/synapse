/** CSV reading and writing for ledger exports and imports. */

export type Row = string[];

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = "CsvError";
  }
}

/**
 * Parses CSV text into rows of fields (RFC 4180 quoting). A quoted field may hold commas, line
 * breaks and doubled quotes ("" is one literal quote). A trailing newline does not produce an
 * empty row. Empty lines are skipped.
 */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let rowHasContent = false;
  const endRow = () => {
    if (rowHasContent || fields.length > 0 || field !== "") {
      fields.push(field);
      rows.push(fields);
    }
    fields = [];
    field = "";
    rowHasContent = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      quoteLine = line;
      rowHasContent = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      rowHasContent = true;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      // handled with the \n
    } else if (ch === "\n") {
      endRow();
      line++;
    } else {
      field += ch;
      rowHasContent = true;
    }
  }
  if (inQuotes) throw new CsvError("unterminated quoted field", quoteLine);
  endRow();
  return rows;
}

function needsQuotes(field: string): boolean {
  return /[",\r\n]/.test(field) || field !== field.trim();
}

/** Quotes a field when it has to be: commas, quotes, newlines or edge spaces. */
export function quoteField(field: string): string {
  return needsQuotes(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Writes rows as CSV with "\n" line endings and a trailing newline. */
export function stringifyCsv(rows: readonly Row[]): string {
  return rows.map((r) => r.map(quoteField).join(",")).join("\n") + (rows.length ? "\n" : "");
}

/** Turns rows with a header row into objects keyed by the header. */
export function toRecords(rows: readonly Row[]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((r, i) => {
    if (r.length !== header!.length) {
      throw new CsvError(`expected ${header!.length} fields, got ${r.length}`, i + 2);
    }
    return Object.fromEntries(header!.map((h, j) => [h, r[j]!]));
  });
}
