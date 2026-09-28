import { envSetting } from "@synapse/shared";

/** One flag per ORIG-13 check. The adapter reads these at every spawn (§13.1). Defaults = every check passed. */
export interface ConformanceFlags {
  sendStreaming: boolean;                                  // CT-01
  approvalPath: "canUseTool" | "hook" | "defer";           // CT-02, CT-16
  stopNudge: boolean;                                      // CT-03 (verified in Phase 0)
  usageSource: "rate_limit_event" | "metering";            // CT-04 (verified: rate_limit_event)
  isolationLevel: 1 | 2;                                   // CT-05 (§13.4 step that passed)
  compactPath: "command" | "auto-only";                    // CT-07
  promptCacheOk: boolean;                                  // CT-08
  extraDisallowed: string[];                               // CT-05, CT-09
  prewarm: boolean;                                        // CT-10
  runAs: "setpriv" | "bwrap" | "same-uid";                 // CT-11
  connectorToolDisable: "settings" | "disallowedTools" | "hook"; // CT-12
  /** CT-13. Evidence for warm sessions (TTFT war room, 2026-09-24, Claude Code 2.1.280 on the box): judge rev 1 counted
   *  per-turn system/init messages as processes and failed ["ONE","TWO","","FOUR"] from ONE process, so every turn
   *  cold-spawned (box: spawn → API request p50 1.01 s, p90 1.76 s, n=52). Rev 2 counts real spawns: re-run on the box
   *  it PASSES ("4 results from one process, including after interrupt"); CT-10 rev 2 passes too ("push → first message
   *  25 ms prewarmed vs 252 ms cold"). Through a local host's gateway, first streamed text went from p50 3.0 s / p90 4.0 s
   *  cold to 1.7 s / 2.2 s warm (n=18 each). Saved rev-1 results re-run at boot (runner.ts ensureConformance).
   *  Review fix round 1 re-run (CT-10 with a discarded warm-up, random order, finite/answered checks): CT-10 PASS
   *  "31 ms prewarmed vs 198 ms cold", CT-13 PASS. Kill switch: SYNAPSE_WARM_SESSIONS=0 (withFlagOverrides, below). */
  warmSessions: boolean;
  rolloverBytes: number;                                   // CT-14
  forkPath: "fork" | "fresh";                              // CT-15
  modelChange: "setModel" | "respawn";                     // CT-17
  sessionIdOption: boolean;                                // CT-18
  parallelAsks: boolean;                                   // CT-19 (informational; APR-19 batching works either way)
}

export const DEFAULT_FLAGS: ConformanceFlags = {
  sendStreaming: true, approvalPath: "canUseTool", stopNudge: true, usageSource: "rate_limit_event", isolationLevel: 1,
  compactPath: "command", promptCacheOk: true, extraDisallowed: [], prewarm: true, runAs: "setpriv",
  connectorToolDisable: "settings", warmSessions: true, rolloverBytes: 64 * 1024 * 1024, forkPath: "fork",
  modelChange: "setModel", sessionIdOption: true, parallelAsks: false,
};

/**
 * Kill switch (TTFT war room review, fix round 1): SYNAPSE_WARM_SESSIONS=0|1 and SYNAPSE_PREWARM=0|1 (e.g. in
 * /etc/bothost.env) take precedence over the saved conformance flags, so warm sessions or the reviewer's prewarm pool
 * can be forced off (or on) without re-running conformance or editing brain-conformance.json. Anything else: no override.
 */
export function withFlagOverrides(f: ConformanceFlags, env: Record<string, string | undefined> = process.env): ConformanceFlags {
  const b = (v: string | undefined): boolean | undefined => (v === "1" ? true : v === "0" ? false : undefined);
  const warm = b(envSetting(env, "WARM_SESSIONS"));
  const prewarm = b(envSetting(env, "PREWARM"));
  if (warm === undefined && prewarm === undefined) return f;
  return { ...f, ...(warm !== undefined ? { warmSessions: warm } : {}), ...(prewarm !== undefined ? { prewarm } : {}) };
}
