/**
 * 0.1.4 — Synapse's own MCP server (docs/superpowers/specs/2026-09-29-synapse-mcp-design.md).
 *
 * Shared by the stdio helper an MCP client launches (app/src/mcp), the app's private socket server that approves,
 * audits and rate-limits clients (app/src/main/mcp), and the host bridge that runs each request as an outside wake
 * (host/mcp-server). Nothing here reaches settings, secrets, memory or approvals: five tools, no more.
 */

export const MCP_TOOLS = ["list_bots", "ask_bot", "start_task", "task_status", "task_result"] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];
export const isMcpTool = (t: unknown): t is McpToolName => typeof t === "string" && (MCP_TOOLS as readonly string[]).includes(t);

/** The socket protocol's name, bound into every connection proof. */
export const MCP_PROTOCOL = "synapse-mcp/1";

export const MCP_LIMITS = {
  /** A message or task, in characters. 0.1.4: kept well under the reviewer's view of wake text
   *  (LIMITS.reviewerContextChars, 4,000) so Auto-review always sees the whole request, wrapper included; the host
   *  also refuses one whose escaped, wrapped wake would still pass that cap (host/mcp-server/bridge.ts). */
  messageMaxChars: 3_000,
  /** One newline-delimited JSON frame on the socket. */
  frameMaxBytes: 64 * 1024,
  /** Per client: every tool call. */
  callsPerMinute: 60,
  /** Per client: ask_bot and start_task (each one is a Bot turn, which costs money). */
  runsPerHour: 30,
  /** Per client: tasks not yet finished. */
  openTasksPerClient: 5,
  /** ask_bot waits this long for the reply, then hands back the task id. */
  askWaitMs: 110_000,
  /** A new client's tool call waits this long for the owner's Allow. */
  approvalWaitMs: 120_000,
  /** Cards: one pending per client key, three in all; a denied key can't ask again for 10 minutes. */
  pendingPerKey: 1,
  pendingTotal: 3,
  denyCooldownMs: 10 * 60_000,
  /** The audit log keeps the newest 1,000 entries; Settings shows the newest 50. */
  auditKeep: 1_000,
  auditShown: 50,
  /** The host keeps finished tasks for a day, 200 at most. */
  taskKeepMs: 24 * 60 * 60_000,
  tasksKept: 200,
  /** A reply handed back, in characters. */
  replyMaxChars: 20_000,
} as const;

export type McpTaskStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
export interface McpBotView { id: string; name: string; description: string }
export interface McpTaskView { id: string; bot: { id: string; name: string }; status: McpTaskStatus; createdAt: number; endedAt: number | null }
export interface McpTaskResultView extends McpTaskView { reply: string | null }

/** Who is asking, as the app approved it. The host never sees a token. */
export interface McpClientRef { clientId: string; clientName: string }

declare module "./gateway" {
  interface GatewayCommands {
    mcpListBots: { args: Record<string, never>; result: { bots: McpBotView[] } };
    /** ask_bot (waitMs > 0) and start_task (no wait). */
    mcpStartTask: { args: McpClientRef & { bot: string; text: string; waitMs?: number }; result: McpTaskResultView };
    mcpTaskStatus: { args: McpClientRef & { taskId: string }; result: McpTaskView };
    mcpTaskResult: { args: McpClientRef & { taskId: string }; result: McpTaskResultView };
  }
}

/** The error every tool answers with when Synapse (or its MCP access) isn't there. */
export const MCP_OPEN_SYNAPSE = "Open Synapse, and turn on MCP access in Settings → System.";

/** Settings → System → MCP, the approval banner and the chat row. Titles and labels only. */
export const STR_MCP = {
  title: "MCP",
  access: "MCP access",
  setup: "Setup",
  copy: "Copy",
  copied: "Copied",
  apps: "Apps",
  noApps: "No apps yet",
  revoke: "Revoke",
  revokeApp: (name: string) => `Revoke ${name}`,
  lastUsed: (when: string) => `Last used ${when}`,
  activity: "Activity",
  noActivity: "No activity yet",
  wants: (name: string) => `${name} wants to use your Bots`,
  allow: "Allow",
  deny: "Deny",
  fromApp: (name: string) => `From ${name}`,
  outcome: { ok: "", refused: "Refused", limited: "Limited", error: "Failed", approved: "Allowed", denied: "Denied", revoked: "Revoked" } as Record<string, string>,
  clients: { "claude-desktop": "Claude Desktop", "claude-code": "Claude Code", cursor: "Cursor" } as Record<string, string>,
} as const;
