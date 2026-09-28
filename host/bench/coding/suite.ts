/**
 * The coding benchmark's task suite. Every task runs against the sample repo in ./sample (a small
 * TypeScript + vitest invoicing library), from a starting state the harness builds deterministically:
 * the sample as commit `base`, plus the task's `start` overlay (tasks/<id>/start/**) and `startEdits`
 * as commit `<id>-start`. A follow-up task (`after`) starts from the state its predecessor's run
 * LEFT, in the same session.
 *
 * Success is decided ONLY by the hidden verification (verify.ts), run on the final repo state:
 * tests in tasks/<id>/hidden/ that the agent never sees, plus the structural checks below. The
 * agent's own claim never counts. Reference solutions live in ../reference-solutions/ and are used
 * only by the offline suite; the runners never read tasks/ or reference-solutions/.
 */

export type Category = "bugfix" | "feature" | "refactor" | "tests" | "cross-file" | "question" | "discover" | "follow-up";
export type Difficulty = "easy" | "medium" | "hard";

/** A literal find/replace on a file, applied to the START state. `find` must occur exactly once. */
export interface TextEdit { file: string; find: string; replace: string }

/** A mutant: either a text edit on the start state, or a whole file copied from the bench dir. */
export type Mutant = { id: string; edit: TextEdit } | { id: string; file: string; from: string };

export interface VerifySpec {
  /** Run tasks/<id>/hidden/*.test.ts. Default: true when that directory exists. */
  hidden?: boolean;
  /** The repo's own test/ suite must pass too. Default true. */
  visible?: boolean;
  /** `tsc -p .` in the repo must pass. */
  typecheck?: boolean;
  /** These paths (file or dir prefix) must be byte-identical to the task's start state. */
  unchanged?: string[];
  /** Every added, changed or removed file must sit under one of these prefixes. */
  onlyChanged?: string[];
  /** These files must exist. */
  requireFiles?: string[];
  /** The named test files must pass on the final code and FAIL under every mutant. */
  mutants?: { tests: string[]; variants: Mutant[] };
}

export interface Task {
  id: string;
  title: string;
  category: Category;
  difficulty: Difficulty;
  /** The obvious fix is wrong: catches shallow work. */
  trap?: string;
  /** Identical for every runner. The harness prefixes only the repo location line. */
  prompt: string;
  startEdits?: TextEdit[];
  /** Runs in the same session right after this task, from the state it left. */
  after?: string;
  verify: VerifySpec;
  /** In the recommended 6-task pilot. */
  pilot?: boolean;
}

const CACHE = "src/cache.ts";

export const TASKS: Task[] = [
  {
    id: "T01",
    title: "Fix CSV quoting (doubled quotes, line breaks)",
    category: "bugfix",
    difficulty: "easy",
    pilot: true,
    prompt:
      "`npm test` fails in test/csv-quotes.test.ts. Fix `parseCsv` in src/csv.ts so that it reads quoting the way RFC 4180 defines it: " +
      "a doubled quote inside a quoted field is one literal quote, and a quoted field may contain commas and line breaks. " +
      "Keep the existing behaviour for everything else. Don't change the tests.",
    verify: {},
  },
  {
    id: "T02",
    title: "allocate() loses cents",
    category: "bugfix",
    difficulty: "medium",
    trap: "Putting the leftover cents on the last share passes the visible test but breaks the documented contract (leftover goes to the FIRST shares).",
    prompt: "The shares returned by `allocate` in src/money.ts don't always add up to the total; test/allocate-sum.test.ts shows it. Fix it.",
    verify: {},
  },
  {
    id: "T03",
    title: "Aging report puts 30-days-late invoices in 31-60",
    category: "bugfix",
    difficulty: "medium",
    trap: "Widening the bucket bounds in config.ts passes the visible test; the real bug is an off-by-one in daysBetween (dates.ts), which also skews late fees.",
    pilot: true,
    prompt:
      "An invoice that is exactly 30 days past due shows up in the 31-60 column of the aging report; it belongs in 1-30. " +
      "test/aging-boundary.test.ts reproduces it. Fix the bug.",
    verify: {},
  },
  {
    id: "T04",
    title: "Invoice-level percentage discount",
    category: "feature",
    difficulty: "medium",
    prompt:
      "Add an optional invoice-level percentage discount. `Invoice` (src/invoice.ts) gets an optional `discountPercent` (a number from 0 to 100; absent means 0). " +
      "In `invoiceTotals`, each line's net is reduced by the discount before tax: the line's discount is `percentOf(net, discountPercent)` (so it is rounded half away from zero, per line), " +
      "and the line's tax is computed on `net - discount`. `Totals` gains a `discount` field: the total discount in cents as a positive number (the sum over lines). " +
      "`subtotal` stays the undiscounted sum of line nets, and `total` is `subtotal - discount + tax`. " +
      "`validateInvoice` must report a `discountPercent` that is not a finite number from 0 to 100 as an error whose text mentions `discountPercent`. Add tests.",
    verify: { typecheck: true },
  },
  {
    id: "T05",
    title: "CSV delimiter option",
    category: "feature",
    difficulty: "easy",
    prompt:
      "Let `parseCsv` and `stringifyCsv` in src/csv.ts take an optional second argument `{ delimiter?: string }` (default `\",\"`). " +
      "The delimiter must be exactly one character; anything else throws a `RangeError`. `stringifyCsv` must quote fields that contain the delimiter. " +
      "Existing calls must keep working unchanged. Add tests.",
    verify: { typecheck: true },
  },
  {
    id: "T06",
    title: "Refactor taxFor into a rules table",
    category: "refactor",
    difficulty: "medium",
    pilot: true,
    prompt:
      "Refactor `taxFor` in src/tax.ts: replace the `switch` with a data table. Export `TAX_RULES`, a `Record<Region, ...>` with one entry per region describing its tax parts per category, " +
      "and make `taxFor` a small function that reads it. There must be no `switch` statement left in src/tax.ts. " +
      "Behaviour must not change at all: the same parts, names, rates, order and rounding for every region, category and amount.",
    verify: { typecheck: true },
  },
  {
    id: "T07",
    title: "Rename Customer.name to legalName across the repo",
    category: "cross-file",
    difficulty: "medium",
    prompt:
      "Rename the `name` field of `Customer` (src/customers.ts) to `legalName` everywhere in the repository: the type, the code, the seed data and the tests. " +
      "Don't keep `name` as an alias. `CustomerDirectory.rename` and `CustomerDirectory.displayName` keep their method names. " +
      "Reports and CSV exports must show exactly the same text as before. `npm test` and `npm run typecheck` must pass.",
    verify: { typecheck: true },
  },
  {
    id: "T08",
    title: "Write tests that pin down LruCache",
    category: "tests",
    difficulty: "medium",
    pilot: true,
    prompt:
      "test/cache.test.ts only covers the basics of `LruCache` (src/cache.ts). Extend it so it pins down the documented behaviour: " +
      "which calls change recency (`get`, `set`) and which do not (`has`, `peek`), which entry is evicted, what updating an existing key does, " +
      "the `evicted` counter, `delete`, `clear` and the order of `keys()`. Don't change src/cache.ts.",
    verify: {
      hidden: false,
      unchanged: [CACHE],
      mutants: {
        tests: ["test/cache.test.ts"],
        variants: [
          { id: "get-no-refresh", edit: { file: CACHE, find: "    this.map.delete(key);\n    this.map.set(key, value);\n    return value;", replace: "    return value;" } },
          { id: "evict-newest", edit: { file: CACHE, find: "const oldest = this.map.keys().next().value as K;", replace: "const oldest = [...this.map.keys()].at(-1) as K;" } },
          { id: "update-evicts", edit: { file: CACHE, find: "if (this.map.has(key)) {\n      this.map.delete(key);\n    } else if (this.map.size >= this.capacity) {", replace: "if (this.map.size >= this.capacity) {" } },
          { id: "has-refreshes", edit: { file: CACHE, find: "  has(key: K): boolean {\n    return this.map.has(key);", replace: "  has(key: K): boolean {\n    return this.get(key) !== undefined;" } },
          { id: "peek-refreshes", edit: { file: CACHE, find: "  peek(key: K): V | undefined {\n    return this.map.get(key);", replace: "  peek(key: K): V | undefined {\n    return this.get(key);" } },
          { id: "no-eviction-count", edit: { file: CACHE, find: "      this.evictions++;\n", replace: "" } },
          { id: "keys-reversed", edit: { file: CACHE, find: "return [...this.map.keys()];", replace: "return [...this.map.keys()].reverse();" } },
          { id: "delete-lies", edit: { file: CACHE, find: "return this.map.delete(key);", replace: "this.map.delete(key);\n    return true;" } },
        ],
      },
    },
  },
  {
    id: "T09",
    title: "Answer: where and how are late fees computed?",
    category: "question",
    difficulty: "easy",
    prompt:
      "A question about the codebase; don't change any code. For a ledger created by `createLedger()` with default options: " +
      "(1) which method computes the late fee, and in which file; (2) what grace period in days does it use; (3) what is the largest late fee in cents? " +
      "Write the answer as JSON to answers/late-fee.json with exactly these keys: " +
      "`{\"method\": string, \"file\": string, \"graceDays\": number, \"capCents\": number}` (file as a repo-relative path). Don't change any other file.",
    verify: { onlyChanged: ["answers/"], visible: true },
  },
  {
    id: "T10",
    title: "CI is red: find and fix the cause",
    category: "discover",
    difficulty: "medium",
    pilot: true,
    prompt: "CI is failing on this branch and nobody has looked at why yet. Find the cause and fix it in the source code. Do not modify, skip or delete any tests.",
    verify: { unchanged: ["test/"] },
  },
  {
    id: "T11",
    title: "Follow-up: regression test for the bug you just fixed",
    category: "follow-up",
    difficulty: "easy",
    after: "T10",
    pilot: true,
    prompt:
      "Now add a regression test for the bug you just fixed, in a new file test/regression.test.ts, so that it fails if that bug ever comes back. " +
      "Don't change anything in src/.",
    verify: {
      hidden: false,
      unchanged: ["src/"],
      requireFiles: ["test/regression.test.ts"],
      mutants: { tests: ["test/regression.test.ts"], variants: [{ id: "T10-bug-back", file: "src/events.ts", from: "tasks/T10/start/src/events.ts" }] },
    },
  },
  {
    id: "T12",
    title: "Ledger events and a PaymentsLog",
    category: "cross-file",
    difficulty: "hard",
    prompt:
      "Make the ledger observable. (1) `Ledger` (src/ledger.ts) gets a public readonly `events` property: an `Emitter` from src/events.ts with two events. " +
      "`invoice.issued`, payload `{ id: string; customerId: string; total: Cents }`, is emitted by `issue` after the invoice is stored. " +
      "`invoice.paid`, payload `{ id: string; paidOn: ISODate; total: Cents }`, is emitted by `markPaid` after the invoice is marked paid. " +
      "`total` is the invoice total. A call that throws emits nothing. Export the event map type as `LedgerEvents` from src/ledger.ts. " +
      "(2) Add src/payments-log.ts exporting a class `PaymentsLog` whose constructor takes a `Ledger` and subscribes to it: " +
      "`totalOn(date: ISODate): Cents` returns the total paid on that date, `entries()` returns `{ id, paidOn, total }` records in the order they were paid, " +
      "and `stop()` unsubscribes so later payments are not recorded. Payments made before the log was created are not included. " +
      "(3) Export `PaymentsLog` from src/index.ts. Add tests.",
    verify: { typecheck: true },
  },
  {
    id: "T13",
    title: "CSV invoice import with validation",
    category: "feature",
    difficulty: "hard",
    prompt:
      "Add `importInvoices(csv: string): { invoices: Invoice[]; errors: { line: number; message: string }[] }` in a new file src/import.ts, exported from src/index.ts. " +
      "The CSV has a header row with the columns `id,customerId,region,issued,due,description,quantity,unit,category`, in any order, and then one row per invoice line. " +
      "Rows with the same `id` (not necessarily adjacent) form one invoice; its lines keep file order, and invoices come out in order of first appearance. " +
      "`unit` is a money amount parsed with `parseMoney` into `unitCents`; `quantity` must be a positive whole number. " +
      "If a column is missing, return no invoices and a single error at line 1 that names the missing column(s). " +
      "All rows of one invoice must agree on customerId, region, issued and due; a row that disagrees with the invoice's first row is an error. " +
      "A row with any error is reported (report every bad row, not only the first) and its whole invoice is dropped. " +
      "Each remaining invoice must pass `validateInvoice`; if it doesn't, report one error at the line of its first row (its message containing the validation problems) and drop it. " +
      "`line` is the 1-based line number in the file, where the header is line 1. Blank lines are ignored but still count for line numbers. Add tests.",
    verify: { typecheck: true },
  },
  {
    id: "T14",
    title: "Customer lookups miss the cache",
    category: "bugfix",
    difficulty: "easy",
    prompt: "Customer lookups hit the store more often than they should; test/directory-cache.test.ts shows it. Find the cause and fix it.",
    startEdits: [{ file: CACHE, find: "    this.map.delete(key);\n    this.map.set(key, value);\n    return value;", replace: "    return value;" }],
    verify: {},
  },
];

export function taskById(id: string): Task {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}; known: ${TASKS.map((x) => x.id).join(", ")}`);
  return t;
}

export const PILOT = TASKS.filter((t) => t.pilot).map((t) => t.id);

/**
 * Orders the selected tasks into sessions: a follow-up runs right after its predecessor in the
 * same session, and selecting a follow-up pulls its predecessor in.
 */
export function sessionsFor(ids: string[]): Task[][] {
  const want = new Set(ids.map((i) => taskById(i).id));
  for (const id of [...want]) {
    let t = taskById(id);
    while (t.after) { want.add(t.after); t = taskById(t.after); }
  }
  const sessions: Task[][] = [];
  for (const t of TASKS) {
    if (!want.has(t.id) || t.after) continue;
    const s = [t];
    for (let next = TASKS.find((x) => x.after === s.at(-1)!.id); next && want.has(next.id); next = TASKS.find((x) => x.after === s.at(-1)!.id)) s.push(next);
    sessions.push(s);
  }
  return sessions;
}

/** The text sent to both runners: one location line, then the task prompt. */
export function promptFor(task: Task, repoPath: string): string {
  return `You are working in the git repository at ${repoPath}. Run commands from there.\n\n${task.prompt}`;
}
