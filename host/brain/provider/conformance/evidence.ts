import fs from "node:fs";
import path from "node:path";
import { isLocalProvider, parseProviderModelRef, type ModelBadge } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../../../util/atomic-json";

/**
 * What has been MEASURED about each provider model (spec §11.1–2): its provider conformance run (PC-01..15) and its
 * coding-bench gate. A model's badge in the picker comes only from here: nothing measured is "Not checked", a failed
 * must-pass check or a failed trap is "Blocked", conformance alone is "Experimental", and "Supported" needs the bench
 * gate too. hostPrivate/provider-evidence.json (0600).
 */
export type PcId = `PC-${string}`;
export type PcStatus = "pass" | "fail" | "skip";
export interface PcResult { id: PcId; status: PcStatus; detail: string; ms: number }
export interface ConformanceRecord { ref: string; at: number; version: number; results: PcResult[]; mustPass: boolean; flags: ProviderFlags }
/** What conformance learned, for the "What works" list and the brain (spec §11.1 "The results set ProviderFlags"). */
export interface ProviderFlags { parallelTools: boolean | null; cachedTokens: boolean | null; vision: boolean | null; toolImages: boolean | null; reasoningEffort: boolean | null; structuredOutput: boolean | null; streamedArgs: boolean | null }
export interface BenchRecord { ref: string; at: number; passRate: number; claudePassRate: number; ratio: number; trapsOk: boolean; passed: boolean; tasks: number; report: string }

export const CONFORMANCE_VERSION = 1;
export const MUST_PASS: readonly PcId[] = ["PC-01", "PC-02", "PC-04", "PC-05", "PC-06", "PC-10", "PC-11", "PC-13"];
/** Spec §11.2: Supported needs at least this share of the default Claude Bot's bench pass rate, and every trap. */
export const BENCH_RATIO = 0.85;

interface OnDisk { conformance?: Record<string, ConformanceRecord>; bench?: Record<string, BenchRecord> }

export class ProviderEvidenceStore {
  constructor(private file: string) {}
  private read(): OnDisk { return readJson<OnDisk>(this.file, {}); }
  private write(d: OnDisk): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, d, 0o600);
  }
  conformance(ref: string): ConformanceRecord | null {
    const r = this.read().conformance?.[ref];
    return r && r.version === CONFORMANCE_VERSION ? r : null;
  }
  bench(ref: string): BenchRecord | null { return this.read().bench?.[ref] ?? null; }
  saveConformance(r: ConformanceRecord): void { const d = this.read(); this.write({ ...d, conformance: { ...(d.conformance ?? {}), [r.ref]: r } }); }
  saveBench(r: BenchRecord): void { const d = this.read(); this.write({ ...d, bench: { ...(d.bench ?? {}), [r.ref]: r } }); }
}

/** The badges for a model, from the evidence alone (plus "Local" for a model on this Mac). */
export function badgesFor(ref: string, pc: ConformanceRecord | null, bench: BenchRecord | null): ModelBadge[] {
  const p = parseProviderModelRef(ref);
  const local: ModelBadge[] = p && isLocalProvider(p.provider) ? ["local"] : [];
  if (!p) return []; // a Claude model: the reference every provider is measured against, so no badge (ruling 48)
  if (!pc) return ["unchecked", ...local];
  if (!pc.mustPass || (bench && !bench.trapsOk)) return ["blocked", ...local];
  if (bench?.passed) return ["supported", ...local];
  return ["experimental", ...local];
}
