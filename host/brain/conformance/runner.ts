import path from "node:path";
import type { HostConfig } from "../../config";
import { readJson, writeJsonAtomic } from "../../util/atomic-json";
import { log } from "../../util/log";
import { claudeExecutableFor } from "../tool-policy";
import { createConformanceContext, detectCliVersion } from "./context";
import { DEFAULT_FLAGS, type ConformanceFlags } from "./flags";
import { isTransientError } from "./transient";
export { isTransientError };
import type { CheckOutcome, ConformanceCheck, ConformanceContext, ConformanceResults } from "./types";

const FILE = "brain-conformance.json";

/** Resolves the runAs mode and CLI version, extracting the common pattern from ensureConformance and runConformanceCommand. */
export async function resolveRunAsAndCliVersion(
  cfg: HostConfig,
  detectCliVersionFn: (executable?: string) => Promise<string | null> = detectCliVersion,
): Promise<{ prev: ConformanceResults | null; runAs: ConformanceFlags["runAs"]; cliVersion: string | null }> {
  const prev = loadConformance(cfg.hostPrivate);
  const runAs = prev?.flags.runAs ?? "setpriv";
  const cliVersion = await detectCliVersionFn(claudeExecutableFor(runAs, cfg));
  return { prev, runAs, cliVersion };
}

export function mergeFlags(outcomes: CheckOutcome[]): ConformanceFlags {
  let f: ConformanceFlags = { ...DEFAULT_FLAGS, extraDisallowed: [] };
  for (const o of outcomes) {
    if (!o.flags) continue;
    const extra = [...f.extraDisallowed, ...(o.flags.extraDisallowed ?? [])];
    f = { ...f, ...o.flags, extraDisallowed: [...new Set(extra)] };
  }
  return f;
}

export async function runConformance(
  checks: ConformanceCheck[],
  ctx: ConformanceContext,
  o: { includeSlow: boolean; only?: string[]; previous: ConformanceResults | null; cliVersion: string | null; now: () => number },
): Promise<ConformanceResults> {
  const results: ConformanceResults["results"] = {};
  const outcomes: CheckOutcome[] = [];
  for (const c of checks) {
    const skip = (c.slow && !o.includeSlow) || (o.only !== undefined && !o.only.includes(c.id));
    if (skip) {
      const prev = o.previous && o.previous.cliVersion === o.cliVersion ? o.previous.results[c.id] : undefined;
      if (prev) {
        results[c.id] = prev;
        outcomes.push({ status: prev.status, detail: prev.detail, flags: prev.flags });
      }
      continue;
    }
    let out: CheckOutcome;
    try {
      out = await c.run(ctx);
    } catch (e) {
      const msg = (e as Error).message;
      out = { status: "fail", detail: `threw: ${msg}`, flags: c.onThrow, ...(isTransientError(msg) ? { transient: true } : {}) };
    }
    log.info("conformance check", { id: c.id, status: out.status, detail: out.detail, ...(out.transient ? { transient: true } : {}) });
    const rev = c.rev && c.rev > 1 ? { rev: c.rev } : {};
    const prevSame = o.previous && o.previous.cliVersion === o.cliVersion ? o.previous.results[c.id] : undefined;
    if (out.transient && prevSame && !prevSame.transient) {
      // Review fix round 1: a run that couldn't reach a verdict never replaces a real one. The saved result (and its
      // flags) stays; it is re-run next boot (its revision differs, or it was itself transient).
      results[c.id] = prevSame;
      outcomes.push({ status: prevSame.status, detail: prevSame.detail, flags: prevSame.flags });
      continue;
    }
    // A transient outcome with nothing to fall back on runs this boot on the check's fallback flags and is marked for a re-run.
    results[c.id] = out.transient
      ? { status: "fail", detail: `transient: ${out.detail}`, flags: c.onThrow, ...rev, transient: true }
      : { status: out.status, detail: out.detail, flags: out.flags ?? {}, ...rev };
    outcomes.push(out.transient ? { ...out, flags: c.onThrow } : out);
  }
  return { cliVersion: o.cliVersion, ranAt: o.now(), results, flags: mergeFlags(outcomes) };
}

export function loadConformance(hostPrivate: string): ConformanceResults | null {
  return readJson<ConformanceResults | null>(path.join(hostPrivate, FILE), null);
}

/** Saves the results; refuses (returns false) to replace a known CLI version with a null one (H-2). */
export function saveConformance(hostPrivate: string, r: ConformanceResults): boolean {
  const known = loadConformance(hostPrivate)?.cliVersion ?? null;
  if (r.cliVersion === null && known !== null) {
    log.warn("conformance: not saving results with an unknown CLI version over a known one", { known });
    return false;
  }
  writeJsonAtomic(path.join(hostPrivate, FILE), r, 0o600);
  return true;
}

/**
 * First boot or a changed CLI version → run the fast suite; otherwise reuse the saved flags (§13.1).
 * H-2: a failed `--version` probe (e.g. killed by the boot reap) is retried once; if it still fails
 * while saved results exist, the saved flags are kept and nothing is re-run or saved, so a null
 * version never overwrites a known one and a degraded boot run can't replace good flags.
 */
export async function ensureConformance(
  cfg: HostConfig,
  o: { checks: ConformanceCheck[]; now?: () => number; detectCliVersion?: (executable?: string) => Promise<string | null> },
): Promise<ConformanceFlags> {
  if (cfg.brain === "fake") return DEFAULT_FLAGS;
  const detect = o.detectCliVersion ?? detectCliVersion;
  let { prev, runAs, cliVersion } = await resolveRunAsAndCliVersion(cfg, detect);
  if (cliVersion === null) cliVersion = await detect(claudeExecutableFor(runAs, cfg));
  if (prev && prev.cliVersion === cliVersion) {
    // A check whose judge was revised since these results were saved re-runs on its own (TTFT war room: CT-13's
    // rev 1 miscounted per-turn init messages as processes and left every Bot cold). The rest keep their results.
    // Review fix round 1: so does one whose last run was transient (no verdict was reached).
    const revised = o.checks.filter((c) => {
      const r = prev!.results[c.id];
      return !c.slow && r && ((r.rev ?? 1) !== (c.rev ?? 1) || r.transient);
    }).map((c) => c.id);
    if (!revised.length) return prev.flags;
    log.info("conformance: re-running revised checks", { checks: revised });
    const ctx = createConformanceContext(cfg, runAs);
    const r = await runConformance(o.checks, ctx, { includeSlow: false, only: revised, previous: prev, cliVersion, now: o.now ?? Date.now });
    saveConformance(cfg.hostPrivate, r);
    return r.flags;
  }
  if (prev && cliVersion === null) {
    log.warn("conformance: CLI version probe failed; keeping the saved flags", { savedCliVersion: prev.cliVersion });
    return prev.flags;
  }
  const ctx = createConformanceContext(cfg, runAs);
  const r = await runConformance(o.checks, ctx, { includeSlow: false, previous: prev, cliVersion, now: o.now ?? Date.now });
  saveConformance(cfg.hostPrivate, r);
  return r.flags;
}
