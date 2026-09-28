import type { HostConfig } from "../config";
import type { ConformanceFlags } from "./conformance/flags";

/** Pinned for Claude Code 2.1.277 (TOOL-18). Re-check when CT-05 reports unknown tools in system/init. */
export const PINNED_CLI_VERSION = "2.1.277";
export const SEND_TOOL = "mcp__bot__SendMessage";
/** Token diet (4): no Glob or Grep (System tools 11,450 -> 9,228 tokens on every call, CLI /context); find, grep and rg
 *  in a shell cover them. This is the ENGINEERING list (engineering mode ON): it keeps Claude Code's own Bash. */
export const BOT_BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "TodoWrite", "Skill"] as const;
/** cost-diet-2 lever 2: an everyday Bot (engineering mode OFF) drops Bash too (5,806 tokens a call,
 *  builtin-tools.probe). Its shell is the host's mcp__bot__Shell: always registered, reviewed on the same
 *  box_shell surface, with a host-tracked cwd, background runs and AwaitShell (decisions.md). */
export const STANDARD_BOT_BUILTIN_TOOLS = BOT_BUILTIN_TOOLS.filter((t) => t !== "Bash");
/** The CodingAgent child runs Claude Code's own preset, which leans on Glob and Grep; it keeps them. */
export const CODING_BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"] as const;
export const DISALLOWED_TOOLS = [
  "AskUserQuestion", "Agent", "Task", "ExitPlanMode", "NotebookEdit", "EnterWorktree", "ExitWorktree", "Monitor",
  // phase0-findings.md #3: built-ins that collide with the host's tools. ToolSearch is no longer one of
  // them: the host's own tools are alwaysLoad (brain/sdk-wiring.ts), so the model never has to search
  // for mcp__bot__SendMessage, and connector tools are deferred behind it (lazy tools, decisions.md).
  "SendMessage", "ListAgents",
] as const;
/** Lazy tools: the CLI's deferred-tool loader. A Bot's connector tools (every MCP server but "bot")
 *  reach the model as names only, and ToolSearch loads a schema the turn it is needed. */
export const TOOL_SEARCH = "ToolSearch";

export function claudeExecutableFor(runAs: ConformanceFlags["runAs"], cfg: HostConfig): string | undefined {
  if (runAs === "setpriv") return cfg.executables.setpriv;
  if (runAs === "bwrap") return cfg.executables.bwrap;
  return undefined; // same-uid: the SDK's bundled CLI, guarded only by the PreToolUse path guard (§13.6 step 3)
}
