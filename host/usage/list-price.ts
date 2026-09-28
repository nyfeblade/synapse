import type { TurnUsage } from "../brain/types";

/** Prompt-cache multipliers on the input price [documented: claude-api pricing]. */
const READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2;
/** Server-side web search: $10 per 1,000 searches [documented: claude-api pricing]. */
const WEB_SEARCH_USD = 0.01;

export interface ListPrice { input: number; output: number }

/**
 * $ per million tokens at list price, first match wins [documented: claude-api pricing]. Specific models come before
 * family prefixes (Opus 4 / 4.1 are $15 / $75 while later Opus is $5 / $25). The current models keep the prices the
 * savings estimate uses (savings-estimate.ts inputUsdPerMTok) with output at 5x input.
 */
const TABLE: ReadonlyArray<[RegExp, ListPrice]> = [
  [/^claude-opus-4(-[01])?(-\d{8})?$/, { input: 15, output: 75 }],
  [/^claude-3-opus/, { input: 15, output: 75 }],
  [/^claude-3-(5|7)-sonnet/, { input: 3, output: 15 }],
  [/^claude-3-sonnet/, { input: 3, output: 15 }],
  [/^claude-3-5-haiku/, { input: 0.8, output: 4 }],
  [/^claude-3-haiku/, { input: 0.25, output: 1.25 }],
  [/^claude-sonnet-4/, { input: 3, output: 15 }],
  [/^claude-haiku/, { input: 1, output: 5 }],
  [/^claude-sonnet-5/, { input: 2, output: 10 }],
  [/^claude-opus-5-5/, { input: 4, output: 20 }],
  [/^claude-opus/, { input: 5, output: 25 }],
  [/^claude-fable/, { input: 10, output: 50 }],
];
/** An unknown model is priced at the highest known rate, so spend is never under-counted. */
const HIGHEST: ListPrice = { input: 15, output: 75 };

export function listPrice(model: string): ListPrice {
  const m = model.replace(/\[1m\]$/, "");
  for (const [re, p] of TABLE) if (re.test(m)) return p;
  return HIGHEST;
}

/**
 * Dollars at list price for usage the host didn't get a CLI-reported cost for: the Bots' claude on the Mac, metered by
 * the Mac key proxy from the Messages API's own `usage` (recordMacUsage), and box-proxy traffic no CLI reported.
 * Review round 2 (P5): `cacheWrite1hTokens` (part of cacheWriteTokens, the 1-hour TTL) is 2x input, the rest 1.25x;
 * `webSearchRequests` are $10 per 1,000.
 */
export function listCostUsd(model: string, u: Pick<TurnUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> & { cacheWrite1hTokens?: number; webSearchRequests?: number }): number {
  const p = listPrice(model);
  const w1h = Math.min(u.cacheWriteTokens, Math.max(0, u.cacheWrite1hTokens ?? 0));
  const writes = (u.cacheWriteTokens - w1h) * WRITE_5M + w1h * WRITE_1H;
  const usd = (p.input * (u.inputTokens + u.cacheReadTokens * READ + writes) + p.output * u.outputTokens) / 1e6 + Math.max(0, u.webSearchRequests ?? 0) * WEB_SEARCH_USD;
  return Math.round(usd * 1e10) / 1e10;
}
