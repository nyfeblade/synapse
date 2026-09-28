import { STRC } from "@synapse/shared";
import type { BrainWiring } from "../brain/types";
import type { ScannerRegistry } from "./scanner";

// I7: CreateAgent/UpdateAgent write text other Bots (and their prompts) will read, so they are outgoing too.
// Phase 4: group chats a Bot creates or renames show their names to the user and every member.
export const OUTGOING_TOOLS: ReadonlySet<string> = new Set([
  "mcp__bot__SendMessage", "mcp__bot__SendToAgent", "mcp__bot__update_state", "mcp__bot__CreateAgent", "mcp__bot__UpdateAgent",
  "mcp__bot__CreateChannel", "mcp__bot__UpdateChannel",
]);

/** ORIG-12 §12.4: outgoing text with a value is denied; every tool output is scrubbed before the model sees it. */
export function withSecrets(w: BrainWiring, o: { botId: string; registry: ScannerRegistry }): BrainWiring {
  return {
    ...w,
    preToolUse: async (call) => {
      if (OUTGOING_TOOLS.has(call.toolName)) {
        const name = o.registry.check(o.botId, JSON.stringify(call.input));
        if (name) return { decision: "deny", reason: STRC.secretInText(name) };
      }
      return w.preToolUse(call);
    },
    postToolUse: async (call, output) => {
      const clean = o.registry.redact(o.botId, output);
      const r = await w.postToolUse(call, clean);
      if (clean !== output && r.replaceOutput === undefined) return { ...r, replaceOutput: clean };
      return r;
    },
  };
}
