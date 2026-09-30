import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../util/log";
import { SEND_TOOL } from "./tool-policy";
import type { TurnEvent } from "./types";
import { listCostUsd } from "../usage/list-price";

type RawUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } };
interface MsgUse { model: string; input: number; read: number; write: number; write1h: number; out: number; ws: number }
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** 5.7: the live meter moves at most once per this many dollars (a tenth of a cent), so it never floods a turn. */
const SPEND_STEP_USD = 0.001;

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}

/** Turns SDK messages into host TurnEvents (§2.5). The host never sees SDK shapes past this class. */
export class EventTranslator {
  lastAssistantText = "";
  private dispatched = false;
  private thinkingOpen = false;
  private sendBlocks = new Map<number, string>();
  private toolNames = new Map<string, string>();
  /** 5.7: this turn's model calls by message id (the same message's usage arrives more than once), priced at list. */
  private uses = new Map<string, MsgUse>();
  private streamMsg: string | null = null;
  private model = "unknown";
  private emittedUsd = 0;

  resetTurn(): void {
    this.dispatched = false;
    this.thinkingOpen = false;
    this.sendBlocks.clear();
    this.lastAssistantText = "";
    this.uses.clear();
    this.streamMsg = null;
    this.emittedUsd = 0;
  }

  /** Counts only grow within a message, so each field keeps its largest value; output only from a final count. */
  private noteUsage(id: string | undefined, model: unknown, u: RawUsage | undefined, withOutput: boolean, out: TurnEvent[]): void {
    if (!id || !u) return;
    const m = this.uses.get(id) ?? { model: typeof model === "string" ? model : this.model, input: 0, read: 0, write: 0, write1h: 0, out: 0, ws: 0 };
    m.input = Math.max(m.input, num(u.input_tokens));
    m.read = Math.max(m.read, num(u.cache_read_input_tokens));
    m.write = Math.max(m.write, num(u.cache_creation_input_tokens));
    m.write1h = Math.max(m.write1h, num(u.cache_creation?.ephemeral_1h_input_tokens));
    m.ws = Math.max(m.ws, num(u.server_tool_use?.web_search_requests));
    if (withOutput) m.out = Math.max(m.out, num(u.output_tokens));
    this.uses.set(id, m);
    let usd = 0;
    for (const x of this.uses.values()) {
      usd += listCostUsd(x.model, { inputTokens: x.input, outputTokens: x.out, cacheReadTokens: x.read, cacheWriteTokens: x.write, cacheWrite1hTokens: x.write1h, webSearchRequests: x.ws });
    }
    if (usd - this.emittedUsd < SPEND_STEP_USD) return;
    this.emittedUsd = usd;
    out.push({ kind: "spend", turnUsd: Math.round(usd * 1e6) / 1e6 });
  }

  translate(m: SDKMessage): TurnEvent[] {
    const out: TurnEvent[] = [];
    const mark = () => {
      if (!this.dispatched) {
        this.dispatched = true;
        out.push({ kind: "dispatched" });
      }
    };
    const msg = m as unknown as Record<string, any>;
    // Other SDK message kinds (results, assistant errors, rate-limit info, …) are intentionally
    // handled elsewhere in the pipeline (e.g. classifyResult) — this switch only turns known
    // system subtypes into TurnEvents and defensively logs any subtype it doesn't model yet, so a
    // future SDK addition never vanishes silently (no swallowed errors).
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.model === "string") this.model = msg.model;
        if (msg.subtype === "init") {
          const servers = Array.isArray(msg.mcp_servers)
            ? (msg.mcp_servers as unknown[]).filter((x): x is { name: string; status: string } => !!x && typeof (x as { name?: unknown }).name === "string" && typeof (x as { status?: unknown }).status === "string").map((x) => ({ name: x.name, status: x.status }))
            : null;
          out.push({ kind: "session", sessionId: msg.session_id, model: msg.model, tools: msg.tools ?? [], cliVersion: msg.claude_code_version, ...(servers ? { mcpServers: servers } : {}) });
        }
        else if (msg.subtype === "api_retry") out.push({ kind: "retry", attempt: msg.attempt, errorStatus: msg.error_status ?? null });
        else if (msg.subtype === "compact_boundary") out.push({ kind: "compact_boundary" });
        else if (msg.subtype === "mirror_error") log.error("unhandled SDK system subtype", { subtype: msg.subtype, error: msg.error });
        else if (msg.subtype === "permission_denied") log.warn("unhandled SDK system subtype", { subtype: msg.subtype, toolName: msg.tool_name });
        // Bug 280: the CLI's request status and thinking-token count (seen on every replayed turn): nothing a turn shows.
        else if (msg.subtype === "status" || msg.subtype === "thinking_tokens") break;
        else log.warn("unhandled SDK system subtype", { subtype: msg.subtype });
        break;
      case "stream_event": {
        if (msg.parent_tool_use_id) break;
        mark();
        const ev = msg.event ?? {};
        if (ev.type === "message_start") {
          this.streamMsg = ev.message?.id ?? null;
          this.noteUsage(ev.message?.id, ev.message?.model, ev.message?.usage, false, out);
        } else if (ev.type === "message_delta" && this.streamMsg) this.noteUsage(this.streamMsg, undefined, ev.usage, true, out);
        if (ev.type === "content_block_start") {
          if (ev.content_block?.type === "thinking") {
            this.thinkingOpen = true;
            out.push({ kind: "thinking", active: true });
          } else if (ev.content_block?.type === "tool_use" && ev.content_block.name === SEND_TOOL) {
            this.sendBlocks.set(ev.index, ev.content_block.id);
          }
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") out.push({ kind: "text_delta", text: ev.delta.text });
          else if (ev.delta?.type === "input_json_delta" && this.sendBlocks.has(ev.index)) {
            out.push({ kind: "send_message_delta", toolUseId: this.sendBlocks.get(ev.index) as string, partialJson: ev.delta.partial_json });
          }
        } else if (ev.type === "content_block_stop" && this.thinkingOpen) {
          this.thinkingOpen = false;
          out.push({ kind: "thinking", active: false });
        }
        break;
      }
      case "assistant": {
        // A subagent's model calls cost the same: counted, though its events stay inside its own task.
        this.noteUsage(msg.message?.id, msg.message?.model, msg.message?.usage, true, out);
        if (msg.parent_tool_use_id) break;
        mark();
        const u = msg.message?.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (u) out.push({ kind: "context", tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) });
        const texts: string[] = [];
        for (const b of (msg.message?.content ?? []) as Block[]) {
          if (b.type === "text" && b.text) texts.push(b.text);
          if (b.type === "tool_use" && b.id && b.name) {
            this.toolNames.set(b.id, b.name);
            out.push({ kind: "tool_start", toolUseId: b.id, name: b.name, input: b.input ?? {}, messageId: msg.message.id });
          }
        }
        if (texts.length) this.lastAssistantText = texts.join("\n");
        break;
      }
      case "user": {
        if (msg.parent_tool_use_id) break;
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b.type === "tool_result" && b.tool_use_id) {
              out.push({ kind: "tool_end", toolUseId: b.tool_use_id, name: this.toolNames.get(b.tool_use_id) ?? "unknown", isError: Boolean(b.is_error), output: flatten(b.content).slice(0, 4000) });
            }
          }
        }
        break;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info ?? {};
        const uw = msg.unifiedWindows ?? info.unifiedWindows ?? {};
        const windows: Record<string, { utilization: number | null; resetsAt: number | null }> = {};
        for (const [k, v] of Object.entries(uw as Record<string, { utilization?: number; resetsAt?: number }>)) {
          windows[k] = { utilization: v?.utilization ?? null, resetsAt: v?.resetsAt ?? null };
        }
        if (info.rateLimitType && !windows[info.rateLimitType]) windows[info.rateLimitType] = { utilization: info.utilization ?? null, resetsAt: info.resetsAt ?? null };
        out.push({ kind: "rate_limit", status: String(info.status ?? "unknown"), windows });
        break;
      }
    }
    return out;
  }
}
