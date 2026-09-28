import { SEND_TOOL } from "../brain/tool-policy";
import type { ToolCall } from "../brain/types";

/**
 * Bug 198, fix round 2: while a steering message the Bot hasn't read is queued, only plainly read-only calls
 * run. FAIL CLOSED: anything not on this list — writes, shells, subagent control, state updates, computer and
 * browser actions, every connector tool, and any tool added later — is held and the note rides its denial.
 * host/test/runner/steer-policy.test.ts classifies every tool name the brain can emit against it.
 */
export const STEER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code built-ins that only read (Glob/Grep/LS: the coding child's preset)
  "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite",
  // The Bot's own read-only getters (each declares readOnly: true)
  "mcp__bot__CheckSubagent", "mcp__bot__AwaitShell", "mcp__bot__SearchHistory", "mcp__bot__Screenshot", "mcp__bot__Look",
  "mcp__bot__AwaitExternalShell", "mcp__bot__ExternalRead",
]);

/** True when the call may run before the Bot has read the user's new message. A plain text SendMessage is
 *  allowed too: it is how the Bot answers. Other send types (cards, secret requests, …) are held. */
export function steerLetsThrough(call: Pick<ToolCall, "toolName" | "input">): boolean {
  if (call.toolName === SEND_TOOL) return (call.input.type ?? "text") === "text";
  return STEER_READ_ONLY_TOOLS.has(call.toolName);
}
