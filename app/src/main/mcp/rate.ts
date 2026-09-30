import { MCP_LIMITS, type McpToolName } from "@synapse/shared";

/** A Bot turn (costs money): ask_bot and start_task. */
export const RUN_TOOLS: ReadonlySet<McpToolName> = new Set(["ask_bot", "start_task"]);

/**
 * 0.1.4 — per-client limits: MCP_LIMITS.callsPerMinute calls of any tool, MCP_LIMITS.runsPerHour Bot turns.
 * Sliding windows, in memory (a restart forgives, which only ever helps the owner's own clients).
 */
export class McpRateLimiter {
  private calls = new Map<string, number[]>();
  private runs = new Map<string, number[]>();
  constructor(private now: () => number = Date.now, private limits: { callsPerMinute: number; runsPerHour: number } = MCP_LIMITS) {}

  /** null = go ahead (and counted); otherwise how many seconds until it would be allowed. */
  take(clientId: string, tool: McpToolName): number | null {
    const t = this.now();
    const calls = (this.calls.get(clientId) ?? []).filter((x) => t - x < 60_000);
    const runs = (this.runs.get(clientId) ?? []).filter((x) => t - x < 3_600_000);
    this.calls.set(clientId, calls);
    this.runs.set(clientId, runs);
    if (calls.length >= this.limits.callsPerMinute) return Math.ceil((calls[0]! + 60_000 - t) / 1000);
    if (RUN_TOOLS.has(tool) && runs.length >= this.limits.runsPerHour) return Math.ceil((runs[0]! + 3_600_000 - t) / 1000);
    calls.push(t);
    if (RUN_TOOLS.has(tool)) runs.push(t);
    return null;
  }

  forget(clientId: string): void { this.calls.delete(clientId); this.runs.delete(clientId); }
}
