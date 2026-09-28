# ledger

A small invoicing and receivables library: money in integer cents, invoices with taxed lines,
customers, a ledger of issued and paid invoices, an aging report and CSV import/export.

    npm test          # vitest
    npm run typecheck # tsc

## Layout

| File | What it holds |
|---|---|
| `src/money.ts` | integer-cent money: parse, format, multiply, allocate |
| `src/dates.ts` | ISO calendar dates (`YYYY-MM-DD`), UTC only |
| `src/csv.ts` | CSV parse and stringify |
| `src/cache.ts` | a small LRU cache |
| `src/events.ts` | a typed event emitter |
| `src/tax.ts` | sales tax / VAT by region and category |
| `src/invoice.ts` | invoice lines and totals |
| `src/customers.ts` | customer records and a cached directory |
| `src/ledger.ts` | the ledger: issue, pay, outstanding, late fees, export |
| `src/report.ts` | the receivables aging report |
| `src/config.ts` | defaults |
| `src/seed.ts` | sample data used by tests and demos |

## Conventions

- Money is always integer cents (`Cents`). Never store floats.
- Rounding is half away from zero (`roundHalfAwayFromZero`), applied per line, never on totals.
- Dates are plain `YYYY-MM-DD` strings in UTC. There are no times of day.
