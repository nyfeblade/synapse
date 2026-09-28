/** Library defaults. A ledger can override any of them through createLedger(options). */
export interface LedgerConfig {
  /** Days after the due date before a late fee applies. */
  graceDays: number;
  /** Late fee as a percent of the outstanding total. */
  lateFeePercent: number;
  /** The late fee never exceeds this many cents. */
  lateFeeCapCents: number;
  /** How many customers the directory keeps in memory. */
  directoryCacheSize: number;
}

export const DEFAULTS: LedgerConfig = {
  graceDays: 10,
  lateFeePercent: 1.5,
  lateFeeCapCents: 5_000,
  directoryCacheSize: 64,
};

/** Aging buckets, in days past due. "current" is not yet due or due today. */
export const AGING_BUCKETS = [
  { key: "current", label: "Current", min: -Infinity, max: 0 },
  { key: "d1_30", label: "1-30", min: 1, max: 30 },
  { key: "d31_60", label: "31-60", min: 31, max: 60 },
  { key: "d61_90", label: "61-90", min: 61, max: 90 },
  { key: "d90plus", label: "90+", min: 91, max: Infinity },
] as const;

export type BucketKey = (typeof AGING_BUCKETS)[number]["key"];
