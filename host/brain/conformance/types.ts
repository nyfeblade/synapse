import type { Options, query, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { HostConfig } from "../../config";
import type { ConformanceFlags } from "./flags";

export type CtId = `CT-${string}`;
/** `transient`: the check could not reach a verdict (rate limit, network, timeout). Its failure is not persisted as a
 *  verdict: this boot runs on the fallback flags and the next boot re-runs the check (runner.ts). */
export interface CheckOutcome { status: "pass" | "fail" | "n/a"; detail: string; flags?: Partial<ConformanceFlags>; transient?: boolean }

export interface ConformanceContext {
  cfg: HostConfig;
  runAs: ConformanceFlags["runAs"];
  queryFn: typeof query;
  now(): number;
  baseOptions(extra?: Partial<Options>): Options;
  boxUid(): Promise<number | null>;
  log(msg: string, f?: Record<string, unknown>): void;
  /** Starts a CLI process (the SDK's spawnClaudeCodeProcess). Checks that must count real processes (CT-10, CT-13)
   *  wrap it; tests stub it. Absent = node's spawn, as ClaudeBrain does. */
  spawnProcess?: (o: SpawnOptions) => SpawnedProcess;
  /** CT-10: how long the prewarmed process gets before its message is pushed (test seam; default 6 s). */
  prewarmWaitMs?: number;
  /** CT-10: which measured run goes first (test seam; default Math.random). */
  random?: () => number;
}

export interface ConformanceCheck {
  id: CtId;
  title: string;
  slow?: boolean;
  verifiedInPhase0?: boolean;
  /** Fallback flags applied if run() throws (§13.1: a failing check switches its fallback on). */
  onThrow: Partial<ConformanceFlags>;
  /** Judge revision (default 1). A saved result from another revision is re-run at boot even when the CLI version
   *  is unchanged, so a fixed judge replaces the flags its old revision switched on. */
  rev?: number;
  run(ctx: ConformanceContext): Promise<CheckOutcome>;
}

export interface ConformanceResults {
  cliVersion: string | null;
  ranAt: number;
  results: Record<string, { status: CheckOutcome["status"]; detail: string; flags: Partial<ConformanceFlags>; rev?: number; transient?: true }>;
  flags: ConformanceFlags;
}
