import { randomUUID } from "node:crypto";
import { LIMITS, MCP_LIMITS, type McpBotView, type McpClientRef, type McpTaskResultView, type McpTaskStatus, type McpTaskView } from "@synapse/shared";
import type { BotSummary } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { HIDDEN_MARKER } from "../runner/prompt-collector";

/**
 * 0.1.4 — the host half of Synapse's MCP server (docs/superpowers/specs/2026-09-29-synapse-mcp-design.md).
 *
 * The app has already approved, authenticated and rate-limited the client; this runs its request as an OUTSIDE
 * wake: source "mcp" (origin "external" for the approval gate, never an owner source, so Full auto's
 * "what the owner asked for" rule never matches it), the text escaped and fenced as data from an outside sender,
 * and silenceAllowed — a Bot that doesn't answer isn't nudged (and any nudge keeps the "mcp" origin: runner settle()).
 * Replies are the Bot's own SendMessage texts from that turn, through the host's secret redaction.
 */
/** The slice of TurnRunner.enqueueWake's WakeSpec an MCP wake uses (kept structural, so the app's end-to-end test can
 *  load this file without the whole runner). */
export interface McpWake {
  id: string; source: "mcp"; lane: "agent"; silenceAllowed: boolean;
  context: { wake: { kind: "mcp"; client: string } };
  prompt(): { text: string }[];
  onStart(): void;
  onSettle(slot: { sentTexts: string[] }, result: { error?: unknown; aborted?: boolean } | null): void;
  onDropped(): void;
}
export interface McpBridgeDeps {
  runner: { enqueueWake(botId: string, spec: McpWake): string };
  bots: { ids(): string[]; has(id: string): boolean; summary(id: string): BotSummary };
  /** The host's secret scanner (phase3.scanners.redact): a Bot's secret values never leave in a reply. */
  redact(botId: string, text: string): string;
  now?(): number;
}

interface Task {
  id: string; clientId: string; botId: string; botName: string; status: McpTaskStatus; createdAt: number; endedAt: number | null;
  reply: string | null; waiters: (() => void)[];
}

/** Escaped, and the app's own markers defanged: outside text can't close its fence or pose as a trusted block. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[(HIDDEN_PROMPT|TRUSTED_[A-Z_]+)\]/g, "($1)");
/** A client name is shown to the Bot and in the chat: one line, printable, short. */
export const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f<>[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "An app";
const OPEN: ReadonlySet<McpTaskStatus> = new Set(["queued", "running", "waiting"]);

/** The wake an MCP request becomes (prompts/wakes/mcp.md). */
export function renderMcpWake(client: string, text: string): string {
  return fillTemplate(loadPrompt("wakes/mcp.md"), { CLIENT: esc(cleanName(client)), TEXT: esc(text) }).trim();
}

export class McpBridge {
  private tasks = new Map<string, Task>();
  constructor(private d: McpBridgeDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }

  /** The owner's Bots an app may ask: not group chats, not archived. Id, name and description only. */
  listBots(): { bots: McpBotView[] } {
    const bots = this.d.bots.ids().map((id) => this.d.bots.summary(id)).filter((b) => !b.group && !b.archived);
    return { bots: bots.map((b) => ({ id: b.id, name: b.profile.name, description: b.profile.description.slice(0, 300) })) };
  }

  /** `bot` is an id or a name (case-insensitive, unique). */
  private resolve(bot: string): BotSummary {
    const want = String(bot ?? "").trim();
    if (!want) throw new GatewayError("INVALID", "Say which Bot: its name or id.");
    const all = this.d.bots.ids().map((id) => this.d.bots.summary(id)).filter((b) => !b.group && !b.archived);
    const byId = all.find((b) => b.id === want);
    if (byId) return byId;
    const named = all.filter((b) => b.profile.name.toLowerCase() === want.toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new GatewayError("AMBIGUOUS", `More than one Bot is called ${cleanName(want)}. Use its id (list_bots).`);
    throw new GatewayError("NOT_FOUND", `No Bot called ${cleanName(want)}. list_bots shows the Bots you can ask.`, 404);
  }

  private prune(): void {
    const cutoff = this.now() - MCP_LIMITS.taskKeepMs;
    for (const [id, t] of this.tasks) if (t.endedAt !== null && t.endedAt < cutoff) this.tasks.delete(id);
    const done = [...this.tasks.values()].filter((t) => t.endedAt !== null).sort((a, b) => a.createdAt - b.createdAt);
    while (this.tasks.size > MCP_LIMITS.tasksKept && done.length) this.tasks.delete(done.shift()!.id);
  }

  /** ask_bot (waitMs > 0: waits for the reply, up to MCP_LIMITS.askWaitMs) and start_task (waitMs 0). */
  async start(a: McpClientRef & { bot: string; text: string; waitMs?: number }): Promise<McpTaskResultView> {
    const text = String(a.text ?? "");
    if (!text.trim()) throw new GatewayError("INVALID", "The message is empty.");
    if (text.length > MCP_LIMITS.messageMaxChars) throw new GatewayError("TOO_LONG", `Keep it under ${MCP_LIMITS.messageMaxChars} characters.`);
    if (!a.clientId) throw new GatewayError("INVALID", "No client.");
    // 0.1.4: Auto-review reads at most LIMITS.reviewerContextChars of a wake's text. A request it couldn't read whole
    // (heavy escaping of <, > and &) is refused, never cut: an action can't hide past the part the reviewer sees.
    if (renderMcpWake(String(a.clientName ?? ""), text).length > LIMITS.reviewerContextChars) {
      throw new GatewayError("TOO_LONG", `Too long for Synapse's safety check once its <, > and & signs are escaped. Keep it under ${MCP_LIMITS.messageMaxChars} characters, with fewer of those signs.`);
    }
    const bot = this.resolve(a.bot);
    this.prune();
    const open = [...this.tasks.values()].filter((t) => t.clientId === a.clientId && OPEN.has(t.status)).length;
    if (open >= MCP_LIMITS.openTasksPerClient) throw new GatewayError("LIMITED", `${open} tasks are still running. Wait for one to finish.`, 429);
    const client = cleanName(a.clientName);
    const task: Task = { id: `mcp_${randomUUID()}`, clientId: a.clientId, botId: bot.id, botName: bot.profile.name, status: "queued", createdAt: this.now(), endedAt: null, reply: null, waiters: [] };
    this.tasks.set(task.id, task);
    const end = (status: McpTaskStatus, reply: string | null) => {
      if (task.endedAt !== null) return;
      task.status = status;
      task.reply = reply;
      task.endedAt = this.now();
      for (const w of task.waiters.splice(0)) w();
    };
    this.d.runner.enqueueWake(bot.id, {
      id: task.id,
      source: "mcp", lane: "agent",
      // A silent turn is fine here (the app gets "no reply"); a nudge would keep the "mcp" origin anyway (followUpOrigin).
      silenceAllowed: true,
      context: { wake: { kind: "mcp", client } },
      prompt: () => [{ text: `${HIDDEN_MARKER}\n${renderMcpWake(client, text)}` }],
      onStart: () => { if (task.endedAt === null) task.status = "running"; },
      onSettle: (slot, result) => {
        const sent = slot.sentTexts.join("\n\n").trim();
        const reply = sent ? this.d.redact(bot.id, sent).slice(0, MCP_LIMITS.replyMaxChars) : null;
        end(!result || result.error ? "failed" : result.aborted ? "stopped" : "done", reply);
      },
      onDropped: () => end("stopped", null),
    });
    const wait = Math.min(Math.max(0, Number(a.waitMs) || 0), MCP_LIMITS.askWaitMs);
    if (wait > 0 && task.endedAt === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { task.waiters = task.waiters.filter((w) => w !== done); resolve(); }, wait);
        const done = () => { clearTimeout(t); resolve(); };
        task.waiters.push(done);
      });
    }
    return this.resultView(task);
  }

  private own(a: McpClientRef & { taskId: string }): Task {
    const t = this.tasks.get(String(a.taskId ?? ""));
    // Another client's task is exactly as unknown as one that never existed.
    if (!t || t.clientId !== a.clientId) throw new GatewayError("NOT_FOUND", "No such task. Tasks are kept for a day, and not across a restart.", 404);
    return t;
  }

  private view(t: Task): McpTaskView {
    let status = t.status;
    // A card is waiting on the owner: the app sees that it waits, never the card or its answer.
    if (status === "running" && this.d.bots.has(t.botId) && this.d.bots.summary(t.botId).awaiting) status = "waiting";
    return { id: t.id, bot: { id: t.botId, name: t.botName }, status, createdAt: t.createdAt, endedAt: t.endedAt };
  }

  private resultView(t: Task): McpTaskResultView {
    return { ...this.view(t), reply: t.reply };
  }

  status(a: McpClientRef & { taskId: string }): McpTaskView { return this.view(this.own(a)); }
  result(a: McpClientRef & { taskId: string }): McpTaskResultView { return this.resultView(this.own(a)); }

  /** The gateway commands (merged in app.ts). Only the app holds the gateway token. */
  commands() {
    return {
      mcpListBots: () => this.listBots(),
      mcpStartTask: (a: McpClientRef & { bot: string; text: string; waitMs?: number }) => this.start(a),
      mcpTaskStatus: (a: McpClientRef & { taskId: string }) => this.status(a),
      mcpTaskResult: (a: McpClientRef & { taskId: string }) => this.result(a),
    };
  }
}
