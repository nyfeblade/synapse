/** Money in integer minor units (cents). Floats never cross a module boundary. */
export type Cents = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertCents(n: number, what = "amount"): Cents {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`${what} must be a whole number of cents, got ${n}`);
  return n;
}

/** Rounds half away from zero: 2.5 -> 3, -2.5 -> -3. Math.round would give -2 for -2.5. */
export function roundHalfAwayFromZero(x: number): number {
  const r = Math.round(Math.abs(x) + 1e-9 * Math.sign(Math.abs(x)));
  return x < 0 ? -r : r;
}

const MONEY_RE = /^(-)?\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses "1,234.50", "$12", "-4.35" or "0.5" into cents. Works on the digits, never through a
 * float, so "19.99" is exactly 1999.
 */
export function parseMoney(text: string): Cents {
  const m = MONEY_RE.exec(text.trim());
  if (!m) throw new MoneyError(`not a money amount: "${text}"`);
  const whole = Number(m[2]!.replace(/,/g, ""));
  const frac = Number((m[3] ?? "0").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return m[1] ? -cents : cents;
}

export interface FormatOptions {
  symbol?: string;
  /** Show "0.00" for zero instead of "-". Default true. */
  showZero?: boolean;
}

/** 123456 -> "$1,234.56", -435 -> "-$4.35". */
export function formatMoney(cents: Cents, opts: FormatOptions = {}): string {
  assertCents(cents);
  const symbol = opts.symbol ?? "$";
  if (cents === 0 && opts.showZero === false) return "-";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${symbol}${whole}.${frac}`;
}

export function addMoney(...amounts: Cents[]): Cents {
  let total = 0;
  for (const a of amounts) total += assertCents(a);
  return total;
}

/** amount x factor, rounded half away from zero. Used for quantities and rates. */
export function multiply(amount: Cents, factor: number): Cents {
  assertCents(amount);
  if (!Number.isFinite(factor)) throw new MoneyError(`factor must be finite, got ${factor}`);
  return roundHalfAwayFromZero(amount * factor);
}

/** amount x percent / 100, rounded half away from zero. */
export function percentOf(amount: Cents, percent: number): Cents {
  return multiply(amount, percent / 100);
}

/**
 * Splits `total` into shares proportional to `ratios`.
 *
 * Each share first gets floor(total * ratio / sum of ratios). The cents left over are then handed
 * out ONE AT A TIME to the FIRST shares, in order (share 0, then share 1, ...), so
 * allocate(100, [1, 1, 1]) is [34, 33, 33]. The shares always sum to `total`. A negative total is
 * split as the exact mirror of the positive split: allocate(-100, [1, 1, 1]) is [-34, -33, -33].
 * Ratios must be non-negative with a positive sum.
 */
export function allocate(total: Cents, ratios: number[]): Cents[] {
  assertCents(total, "total");
  if (ratios.length === 0) throw new MoneyError("allocate needs at least one ratio");
  if (ratios.some((r) => r < 0 || !Number.isFinite(r))) throw new MoneyError("ratios must be finite and non-negative");
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new MoneyError("ratios must have a positive sum");
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const shares = ratios.map((r) => Math.floor((abs * r) / sum));
  return shares.map((s) => s * sign);
}

export function sumCents(amounts: readonly Cents[]): Cents {
  return amounts.reduce((a, b) => a + b, 0);
}
