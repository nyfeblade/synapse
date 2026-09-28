import { percentOf, type Cents } from "./money";

export const REGIONS = ["US-CA", "US-NY", "US-OR", "CA-ON", "CA-QC", "GB", "DE"] as const;
export type Region = (typeof REGIONS)[number];

export const CATEGORIES = ["standard", "food", "books", "services"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TaxPart {
  /** Printed on invoices, e.g. "GST" or "VAT". */
  name: string;
  /** Percent, e.g. 9.975. */
  rate: number;
  cents: Cents;
}

export interface TaxResult {
  parts: TaxPart[];
  total: Cents;
}

/** One printed tax component: its name and rate in percent. */
export type PartRule = readonly [name: string, rate: number];
export type RegionRule = Record<Category, readonly PartRule[]>;

const none: readonly PartRule[] = [];
const all = (parts: readonly PartRule[], overrides: Partial<RegionRule> = {}): RegionRule => ({
  standard: parts, food: parts, books: parts, services: parts, ...overrides,
});

/** Every region's tax parts per category, in printed order. Zero-rated is an empty list. */
export const TAX_RULES: Record<Region, RegionRule> = {
  "US-CA": all([["Sales tax", 7.25]], { food: none, services: none }),
  "US-NY": all([["State tax", 4], ["City tax", 4.5]], { food: none }),
  "US-OR": all(none),
  "CA-ON": all([["HST", 13]], { food: none, books: [["HST", 5]] }),
  "CA-QC": all([["GST", 5], ["QST", 9.975]], { food: none }),
  GB: all([["VAT", 20]], { food: none, books: none }),
  DE: all([["USt", 19]], { food: [["USt", 7]], books: [["USt", 7]] }),
};

export function isRegion(x: string): x is Region {
  return (REGIONS as readonly string[]).includes(x);
}

export function isCategory(x: string): x is Category {
  return (CATEGORIES as readonly string[]).includes(x);
}

/**
 * Tax owed on a taxable `amount` for one line. Each part is rounded on its own (half away from
 * zero); the total is the sum of the rounded parts. Zero-rated combinations return no parts.
 */
export function taxFor(region: Region, category: Category, amount: Cents): TaxResult {
  const rule = TAX_RULES[region];
  if (!rule) throw new Error(`unknown region ${String(region)}`);
  const parts = rule[category].map(([name, rate]) => ({ name, rate, cents: percentOf(amount, rate) }));
  return { parts, total: parts.reduce((a, p) => a + p.cents, 0) };
}

/** The headline rate (sum of part rates) for display. */
export function headlineRate(region: Region, category: Category): number {
  return taxFor(region, category, 10_000).parts.reduce((a, p) => a + p.rate, 0);
}
