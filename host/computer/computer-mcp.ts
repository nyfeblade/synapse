import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentType } from "@synapse/shared";
import { toNamedMcpServer } from "../brain/sdk-wiring";
import type { BotToolDef } from "../brain/types";

/** TOOL-02: computerUse gets Computer (plus ReadScreen for a model that reads text only; or, in "Computer perception:
 *  Live", Look/Act/Screenshot); browserUse gets the browser_* tools; generalPurpose gets none. */
export function computerToolsFor(type: SubagentType, o: { computer: BotToolDef; browser: BotToolDef[]; live?: () => BotToolDef[]; readScreen?: BotToolDef }, perception?: "live"): BotToolDef[] {
  if (type === "computerUse") return perception === "live" && o.live ? o.live() : [o.computer, ...(o.readScreen ? [o.readScreen] : [])];
  return type === "browserUse" ? o.browser : [];
}

/** The restricted `bot` server (Shell, AwaitShell) and the `computer` server (mcp__computer__*). */
export function childMcpServers(o: { bot: BotToolDef[]; computer: BotToolDef[] }): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = { bot: toNamedMcpServer("bot", o.bot) };
  if (o.computer.length) servers.computer = toNamedMcpServer("computer", o.computer);
  return servers;
}
