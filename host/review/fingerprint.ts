import { createHash } from "node:crypto";
import type { Surface } from "@synapse/shared";
import type { RiskTarget } from "./types";

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** APR-15: sha256 of the canonical risk target, including the enrichment hash. */
export function fingerprint(surface: Surface, target: RiskTarget): string {
  return createHash("sha256").update(JSON.stringify([surface, canonical(target)])).digest("hex");
}
