import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BotToolDef, BrainWiring, ToolCall } from "../../brain/types";
import { BASH_OUTSIDE, type CodingPolicy } from "./policy";
import path from "node:path";

/**
 * The BrainWiring of a coding agent run by Synapse's own loop (provider-loop) or by a vendor CLI (ACP): every tool call
 * — the model's own, or a permission the vendor CLI asks — is decided by the shared coding policy (engines/policy.ts),
 * and nothing else. A coding agent has no SendMessage, no hooks and no stop rule: its last message is its report.
 *
 * The decision is taken in canUseTool (it has the step's signal, so Stop ends a wait on an approval card too).
 */
const SHELL = "mcp__bot__Shell";

export function codingWiring(o: { policy: CodingPolicy; cwd: string; botTools?(): BotToolDef[]; /** where the next Bash command runs */ shellDir?(): string }): BrainWiring {
  const inTree = (p: string) => p === o.cwd || p.startsWith(`${o.cwd}${path.sep}`);
  return {
    preToolUse: async () => ({ decision: "ask", reason: "coding policy" }),
    canUseTool: async (call: ToolCall, signal: AbortSignal) => {
      // An ACP terminal runs through the "Shell" tool: its command is a Bash command, and its folder must be the worktree's.
      if (call.toolName === SHELL) {
        const wd = typeof call.input.working_directory === "string" && call.input.working_directory ? path.resolve(o.cwd, call.input.working_directory) : o.cwd;
        if (!inTree(wd)) return { behavior: "deny", message: BASH_OUTSIDE };
        const d = await o.policy("Bash", { command: call.input.command }, signal, call.toolUseId, wd);
        if (d.behavior === "deny") return d;
        return { behavior: "allow", updatedInput: { ...call.input, command: d.updatedInput.command ?? call.input.command } };
      }
      const runIn = call.toolName === "Bash" ? call.cwd ?? o.shellDir?.() : undefined;
      return o.policy(call.toolName, call.input, signal, call.toolUseId, runIn);
    },
    postToolUse: async () => ({}),
    stop: async () => ({ block: false }),
    botTools: () => o.botTools?.() ?? [],
    turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    flags: () => DEFAULT_FLAGS,
  };
}
