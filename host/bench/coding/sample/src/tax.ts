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

export function isRegion(x: string): x is Region {
  return (REGIONS as readonly string[]).includes(x);
}

export function isCategory(x: string): x is Category {
  return (CATEGORIES as readonly string[]).includes(x);
}

function part(name: string, rate: number, amount: Cents): TaxPart {
  return { name, rate, cents: percentOf(amount, rate) };
}

function result(parts: TaxPart[]): TaxResult {
  return { parts, total: parts.reduce((a, p) => a + p.cents, 0) };
}

/**
 * Tax owed on a taxable `amount` for one line. Each part is rounded on its own (half away from
 * zero); the total is the sum of the rounded parts. Zero-rated combinations return no parts.
 */
export function taxFor(region: Region, category: Category, amount: Cents): TaxResult {
  switch (region) {
    case "US-CA": {
      if (category === "food" || category === "services") return result([]);
      return result([part("Sales tax", 7.25, amount)]);
    }
    case "US-NY": {
      if (category === "food") return result([]);
      return result([part("State tax", 4, amount), part("City tax", 4.5, amount)]);
    }
    case "US-OR": {
      return result([]);
    }
    case "CA-ON": {
      if (category === "food") return result([]);
      if (category === "books") return result([part("HST", 5, amount)]);
      return result([part("HST", 13, amount)]);
    }
    case "CA-QC": {
      if (category === "food") return result([]);
      return result([part("GST", 5, amount), part("QST", 9.975, amount)]);
    }
    case "GB": {
      if (category === "food" || category === "books") return result([]);
      return result([part("VAT", 20, amount)]);
    }
    case "DE": {
      if (category === "food" || category === "books") return result([part("USt", 7, amount)]);
      return result([part("USt", 19, amount)]);
    }
    default: {
      const never: never = region;
      throw new Error(`unknown region ${String(never)}`);
    }
  }
}

/** The headline rate (sum of part rates) for display. */
export function headlineRate(region: Region, category: Category): number {
  return taxFor(region, category, 10_000).parts.reduce((a, p) => a + p.rate, 0);
}
