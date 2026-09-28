/** CSV reading and writing for ledger exports and imports. */

export type Row = string[];

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = "CsvError";
  }
}

/**
 * Parses CSV text into rows of fields. Fields may be wrapped in double quotes, which lets them
 * contain commas. A trailing newline does not produce an empty row. Empty lines are skipped.
 */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line === "") return;
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(field);
        field = "";
      } else {
        field += ch;
      }
    }
    if (inQuotes) throw new CsvError("unterminated quoted field", i + 1);
    fields.push(field);
    rows.push(fields);
  });
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
