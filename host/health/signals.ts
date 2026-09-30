import { COMPOSIO_SERVER_ID, GOOGLE_SERVER_ID, HEALTH_LIMITS, STR_HEALTH } from "@synapse/shared";
import type { ToolOutcome } from "./connector-health";

/**
 * Which connector a Bot's tool belongs to: "mcp:<serverId>", or null (not one). 4.3b: Google and Composio calls are
 * per account, and only their own tool handlers know which account a call used, so they report their outcomes
 * themselves (GoogleServices.onToolOutcome, ComposioServices.onToolOutcome); this returns null for them.
 */
export function connectorOfTool(name: string, isServer: (id: string) => boolean): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const [, server] = m as unknown as [string, string, string];
  if (server === GOOGLE_SERVER_ID || server === COMPOSIO_SERVER_ID) return null;
  return isServer(server) ? `mcp:${server}` : null;
}

const AUTH = /\b401\b|unauthori[sz]ed|invalid_grant|invalid_token|token (has )?expired|sign-in expired|needs to be connected first|reconnect,? then try again|isn't connected\. Ask the user to connect|through Composio: Key rejected/i;
const DENIED = /\b403\b|forbidden|permission denied|access denied/i;
const NETWORK = /isn't reachable right now|Can't reach Composio|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|timed out|socket hang up|\b50[234]\b/i;
// A turned-off tool or server is the user's choice, not a failure.
const NOT_A_FAILURE = /The user turned off|No such tool:|Not a host lookup|is turned off for this Bot|isn't turned on for this Bot/i;

/** One tool result as a health signal (auth errors, access denied, other failures). */
export function toolOutcome(isError: boolean, output: string): ToolOutcome | null {
  const head = String(output ?? "").slice(0, 600);
  if (!isError) return { ok: true };
  if (NOT_A_FAILURE.test(head)) return null;
  if (AUTH.test(head)) return { ok: false, auth: true, reason: "" };
  if (DENIED.test(head)) return { ok: false, auth: false, reason: STR_HEALTH.reasons.accessDenied };
  if (NETWORK.test(head)) return { ok: false, auth: false, reason: STR_HEALTH.reasons.unreachable };
  return { ok: false, auth: false, reason: STR_HEALTH.reasons.failing };
}

/** A Bot's own git/gh call that GitHub refused for its sign-in (bad or revoked credentials). */
const GH_AUTH = /Bad credentials|HTTP 401|Authentication failed for 'https:\/\/github\.com|remote: Invalid username or (password|token)|gh auth login|The token in .*hosts\.yml is invalid/i;
export function githubAuthFailed(toolName: string, output: string): boolean {
  if (toolName !== "Shell" && toolName !== "Bash") return false;
  const head = String(output ?? "").slice(0, 4000);
  return GH_AUTH.test(head) && /github|\bgh\b/i.test(head);
}

/** The CLI's own MCP connection states (the SDK's init message), for servers the CLI runs itself. */
export function cliMcpState(status: string): { state: "ok" | "needs-sign-in" | "broken" | "checking"; reason: string | null } {
  switch (status) {
    case "connected": return { state: "ok", reason: null };
    case "needs-auth": return { state: "needs-sign-in", reason: null };
    case "pending": return { state: "checking", reason: null };
    case "failed": return { state: "broken", reason: STR_HEALTH.reasons.didntStart };
    default: return { state: "checking", reason: null };
  }
}

export const SUMMARY_MAX = HEALTH_LIMITS.summaryMax;
