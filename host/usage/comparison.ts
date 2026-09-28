import type { CostComparison } from "@synapse/shared";
import { hostedAgent, PRICE, synapseShipped, type Policy } from "../bench/compare/params";
import { WORKLOADS } from "../bench/compare/report";
import { simulate } from "../bench/compare/simulate";
import { buildConversation } from "../bench/compare/workload";

/** Output tokens cost 5x input on every current Claude model [documented; bench/compare/params.ts PRICE]. */
export const OUTPUT_PRICE_RATIO = 5;
/** Helper-model calls (memory extraction, dreaming) priced as Haiku 4.5 against a Sonnet 5 main model, for BOTH policies. */
export const HELPER_PRICE_RATIO = PRICE.haiku / PRICE.sonnet;

/** What ships ON today (bench/compare/report.ts diet2Set: "SHIPPED +diet2 (what ships ON)"). */
const shipped = () => synapseShipped({ noBash: true, upFront: true, memBatch: 3, cap: 150_000 });

/** A policy's modeled cost over the simulator's three workloads (casual, tool-heavy, long-lived), in input-token price units. */
function policyCost(p: Policy): number {
  return WORKLOADS.reduce((s, w) => {
    const r = simulate(buildConversation(w, "small"), p);
    return s + r.messages.reduce((a, m) => a + m.weighted + OUTPUT_PRICE_RATIO * m.outEq + HELPER_PRICE_RATIO * (m.helper.input + OUTPUT_PRICE_RATIO * m.helper.output), 0);
  }, 0);
}

let memo: { low: number; mid: number; high: number } | null = null;
/** The hosted agent's low / mid / high over what ships, on the same modeled workloads. Pure and deterministic: computed once. */
export function comparisonRatios(): { low: number; mid: number; high: number } {
  if (memo) return memo;
  const ours = policyCost(shipped());
  const [low, mid, high] = (["low", "mid", "high"] as const).map((v) => policyCost(hostedAgent(v)) / ours).sort((a, b) => a - b) as [number, number, number];
  memo = { low, mid, high };
  return memo;
}

/**
 * "This month: $X in API cost. A typical hosted agent's overhead would have been about $Y." Y is this month's real
 * dollars times the simulator's ratio — the user's actual mix of work is not simulated, so the card says
 * "about", shows the range and names its basis. Null before there is any spend to scale.
 */
export function costComparison(monthUsd: number): CostComparison | null {
  if (!(monthUsd > 0)) return null;
  const r = comparisonRatios();
  const at = (k: number) => Math.round(monthUsd * k * 100) / 100;
  return {
    monthUsd, lowUsd: at(r.low), midUsd: at(r.mid), highUsd: at(r.high), ratioMid: Math.round(r.mid * 100) / 100,
    basis: "An estimate, not a measurement: this month's API spend scaled by our cost simulator's ratio between a typical hosted-agent design (a ~25k-token system prompt and ~35k of tool schemas re-sent each call, low to high) and Synapse as it ships, on three modeled workloads at the same Claude prices. Your own mix of work was not simulated.",
  };
}
