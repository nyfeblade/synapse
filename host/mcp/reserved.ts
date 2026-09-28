import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Final secfix item 4: MCP server ids the app itself owns. No registry server or plugin may take one, and a
 * session only ever mounts the app's own (built-in) server under one of them.
 */
export const RESERVED_MCP_IDS: ReadonlySet<string> = new Set(["google", "bot", "computer", "probe"]);

/** True for a reserved id or the claude.ai connector prefix (claude_ai_ / claude-ai- / "claude ai …", any case). */
export function isReservedMcpId(nameOrId: string): boolean {
  const n = nameOrId.trim().toLowerCase();
  const slug = n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return RESERVED_MCP_IDS.has(n) || RESERVED_MCP_IDS.has(slug) || /^claude[\s_-]*ai([\s_-]|$)/.test(n) || /^claude-ai(-|$)/.test(slug);
}

const BUILTIN = new WeakSet<object>();

/** Marks a server config as the app's own (built-in) server: the identity mergeMcpServers checks. */
export function markBuiltinServer<T extends McpServerConfig>(cfg: T): T {
  BUILTIN.add(cfg as object);
  return cfg;
}

export function isBuiltinServer(cfg: unknown): boolean {
  return typeof cfg === "object" && cfg !== null && BUILTIN.has(cfg);
}

/** Merges modules' session servers; under a reserved id only a config marked built-in survives (any order). */
export function mergeMcpServers(parts: Record<string, McpServerConfig>[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const part of parts) {
    for (const [id, cfg] of Object.entries(part)) {
      if (isReservedMcpId(id)) {
        if (isBuiltinServer(cfg)) out[id] = cfg;
        continue;
      }
      out[id] = cfg;
    }
  }
  return out;
}
