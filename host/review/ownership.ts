import type { RiskTarget } from "./types";

/**
 * Ownership gates (ruling b, P5 review C3/I5): actions that change what OTHER Bots are told or can do —
 * another Bot's standing instructions, connector instructions that go into every Bot's system prompt,
 * anything that adds skills or MCP servers, and turning a connector tool back on — always raise a user
 * card, even with Auto-review off, and neither the reviewer nor an Allow rule can wave them through.
 */
export const OWNERSHIP_ACTIONS: ReadonlySet<string> = new Set([
  "update_agent", "set_mcp_instructions", "install_plugin", "install_local_mcp_server", "add_mcp_server", "enable_mcp_tool", "template_other_bot",
]);

export function isOwnershipAction(target: RiskTarget | null | undefined): boolean {
  return !!target && OWNERSHIP_ACTIONS.has(target.action);
}
