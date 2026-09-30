import type { EffortLevel } from "@synapse/shared";
import type {
  CallUsage, CanonMessage, CanonRequest, DecodedEvent, DecodedMessage, DecodedToolCall, ProviderAdapter, StreamDecoder,
} from "./types";

/**
 * Anthropic's Messages API (2026-09-30: Claude Bots on Synapse's own loop). The same canonical conversation ProviderBrain
 * keeps for every provider, encoded as a Messages request and decoded from its SSE stream (message_start,
 * content_block_start / _delta / _stop, message_delta, message_stop). It goes out through providerFetch and the auth
 * proxy, which alone holds the key.
 *
 * - Tools and tool results, images included (a tool_result carries its images inline, as Claude reads them).
 * - Thinking: the model's thinking blocks (signatures, redacted blocks) and any server-tool blocks are kept verbatim in
 *   the assistant message's `providerMeta.anthropic.blocks`, in the order they came, and echoed back unchanged. The
 *   history is append-only, so the thinking check on edited history never trips.
 * - Prompt caching: breakpoints on the last tool, the system prompt, and the last block of the last two user messages,
 *   so the stable prefix (tools + system) and the growing conversation are both read from the cache on the next call.
 * - Usage: message_start's input, cache read and cache write counts (1-hour writes apart) and message_delta's output
 *   count, for the metering.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The tool a structured-output request is answered through (the CLI's own name for it). */
export const STRUCTURED_TOOL = "StructuredOutput";
export const ANTHROPIC_VERSION = "2023-06-01";
/** The CLI's default output cap for a Bot turn (CLAUDE_CODE_MAX_OUTPUT_TOKENS). */
export const DEFAULT_MAX_OUTPUT = 32_000;

/** What a Claude model takes (claude-api skill, 2026-09-25 table). Unknown Claude models get the most careful answer. */
export interface ClaudeCaps {
  /** Adaptive thinking is sent; "none" = the model has no adaptive thinking (Haiku 4.5): nothing is sent. */
  thinking: "adaptive" | "none";
  /** output_config.effort is accepted. */
  effort: boolean;
  /** tool_choice {type:"tool"} is accepted (400 on Opus 5.5, Sonnet 5.5, Fable 5.1). */
  forcedTool: boolean;
  /** thinking {type:"disabled"} is accepted (needed with a forced tool). */
  canDisableThinking: boolean;
  /** The web search server tool this model takes. */
  webSearchTool: string;
}
export function claudeCaps(model: string): ClaudeCaps {
  const m = model.replace(/\[1m\]$/, "");
  if (/^claude-haiku/.test(m)) return { thinking: "none", effort: false, forcedTool: true, canDisableThinking: true, webSearchTool: "web_search_20250305" };
  if (m === "claude-sonnet-5" || m === "claude-opus-5") return { thinking: "adaptive", effort: true, forcedTool: true, canDisableThinking: true, webSearchTool: "web_search_20260209" };
  // Opus 5.5, Sonnet 5.5, Fable 5.1 and anything newer: thinking can't be turned off and a forced tool is a 400.
  return { thinking: "adaptive", effort: true, forcedTool: false, canDisableThinking: false, webSearchTool: "web_search_20260209" };
}

/** A block of an assistant message as it came, kept so it can be sent back exactly (tool_use by id only). */
export type LayoutBlock =
  | { type: "text"; text: string; citations?: unknown[] }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string }
  | Obj;
export interface AnthropicMeta { anthropic: { blocks: LayoutBlock[] } }
export function layoutOf(meta: unknown): LayoutBlock[] | null {
  if (!isObj(meta) || !isObj(meta.anthropic) || !Array.isArray(meta.anthropic.blocks)) return null;
  return meta.anthropic.blocks as LayoutBlock[];
}

/** Tool-use ids must match ^[A-Za-z0-9_-]+$ (a history started on another provider may hold other ids). */
const safeId = (id: string) => (id.replace(/[^A-Za-z0-9_-]/g, "_") || "toolu_x").slice(0, 200);
function parseInput(args: string): Obj {
  if (!args.trim()) return {};
  try { const v = JSON.parse(args) as unknown; return isObj(v) ? v : {}; } catch { return {}; }
}

export function mapAnthropicUsage(raw: unknown): CallUsage | null {
  if (!isObj(raw)) return null;
  const input = num(raw.input_tokens);
  const read = num(raw.cache_read_input_tokens);
  const write = num(raw.cache_creation_input_tokens);
  const out = num(raw.output_tokens);
  if (!input && !read && !write && !out) return null;
  const w1h = isObj(raw.cache_creation) ? Math.min(write, num(raw.cache_creation.ephemeral_1h_input_tokens)) : 0;
  const ws = isObj(raw.server_tool_use) ? num(raw.server_tool_use.web_search_requests) : 0;
  return {
    inputTokens: input, outputTokens: out, cacheReadTokens: read, cacheWriteTokens: write, promptTokens: input + read + write,
    ...(w1h ? { cacheWrite1hTokens: w1h } : {}), ...(ws ? { webSearchRequests: ws } : {}),
  };
}

type WireMsg = { role: "user" | "assistant"; content: Obj[] };

function userBlocks(m: Extract<CanonMessage, { role: "user" }>): Obj[] {
  return m.parts.flatMap((p): Obj[] => (p.type === "text"
    ? (p.text ? [{ type: "text", text: p.text }] : [])
    : [{ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } }]));
}

function assistantBlocks(m: Extract<CanonMessage, { role: "assistant" }>, wireName: (n: string) => string): Obj[] {
  const toolUse = (c: { id: string; name: string; arguments: string }): Obj => ({ type: "tool_use", id: safeId(c.id), name: wireName(c.name), input: parseInput(c.arguments) });
  const layout = layoutOf(m.providerMeta);
  if (!layout) return [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.toolCalls.map(toolUse)];
  const out: Obj[] = [];
  const used = new Set<string>();
  for (const b of layout) {
    if (b.type === "text") { if (typeof b.text === "string" && b.text) out.push({ ...b }); }
    else if (b.type === "tool_use") {
      const c = m.toolCalls.find((x) => x.id === b.id);
      if (c) { out.push(toolUse(c)); used.add(c.id); }
    } else out.push({ ...b });
  }
  for (const c of m.toolCalls) if (!used.has(c.id)) out.push(toolUse(c));
  return out;
}

/**
 * The canonical conversation as Messages: user and tool messages become user turns (tool results first), consecutive
 * turns of one role are merged, a thinking-only assistant turn is left out, and a tool call without a result gets a
 * "not run" one, so the request is always well-formed. Deterministic, so the same history encodes to the same bytes.
 */
export function encodeAnthropicMessages(msgs: CanonMessage[], wireName: (n: string) => string): WireMsg[] {
  const out: WireMsg[] = [];
  const push = (role: WireMsg["role"], content: Obj[]) => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of msgs) {
    if (m.role === "user") push("user", userBlocks(m));
    else if (m.role === "assistant") {
      const blocks = assistantBlocks(m, wireName);
      if (blocks.some((b) => b.type !== "thinking" && b.type !== "redacted_thinking")) push("assistant", blocks);
    } else if (m.toolRefs?.length && !m.isError) {
      // ToolSearch (0.1.8): the loaded tools as tool_reference blocks; the API expands each into its definition here.
      push("user", [{ type: "tool_result", tool_use_id: safeId(m.toolCallId), content: m.toolRefs.map((n): Obj => ({ type: "tool_reference", tool_name: wireName(n) })) }]);
    } else {
      const content: Obj[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const im of m.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: im.mimeType, data: im.data } });
      push("user", [{ type: "tool_result", tool_use_id: safeId(m.toolCallId), ...(content.length ? { content } : {}), ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  // Every tool_use needs its tool_result at the start of the next user turn.
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    if (a.role !== "assistant") continue;
    const ids = a.content.filter((b) => b.type === "tool_use").map((b) => String(b.id));
    if (!ids.length) continue;
    let next = out[i + 1];
    if (!next || next.role !== "user") { next = { role: "user", content: [] }; out.splice(i + 1, 0, next); }
    const have = new Set(next.content.filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id)));
    const missing = ids.filter((id) => !have.has(id)).map((id): Obj => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Not run: the turn ended before this call ran." }], is_error: true }));
    const results = next.content.filter((b) => b.type === "tool_result");
    const rest = next.content.filter((b) => b.type !== "tool_result");
    next.content = [...results, ...missing, ...rest];
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
  return out;
}

const cacheControl = (ttl: CanonRequest["cacheTtl"]): Obj => (ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
const CACHEABLE = new Set(["text", "image", "tool_result", "tool_use", "document"]);

/** Puts a breakpoint on a message's last block that can hold one; true when it did. */
function mark(m: WireMsg | undefined, cc: Obj): boolean {
  if (!m) return false;
  for (let i = m.content.length - 1; i >= 0; i--) {
    const b = m.content[i]!;
    if (!CACHEABLE.has(String(b.type))) continue;
    m.content[i] = { ...b, cache_control: cc };
    return true;
  }
  return false;
}

export function encodeAnthropic(req: CanonRequest): Record<string, unknown> {
  const caps = claudeCaps(req.model);
  const cc = cacheControl(req.cacheTtl);
  const messages = encodeAnthropicMessages(req.messages, req.wireName);
  // The moving breakpoints: the newest user turn (written now) and the one before it (read now, written last call).
  const users = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  let marks = 0;
  for (const i of users.slice(-2).reverse()) if (mark(messages[i], cc)) marks++;
  void marks;

  const structured = req.jsonSchema;
  const force = !!structured && caps.forcedTool;
  const wire = (t: CanonRequest["tools"][number]): Obj => ({
    name: t.name, description: t.description,
    input_schema: { type: "object", ...t.parameters },
    // The reply streams as the model writes SendMessage's arguments (the CT-01 equivalent); zod checks every input.
    ...(structured ? {} : { eager_input_streaming: true }),
  });
  const tools: Obj[] = req.tools.filter((t) => !t.defer).map(wire);
  if (structured) tools.push({ name: STRUCTURED_TOOL, description: "Give your answer as this tool's input.", input_schema: { type: "object", ...structured.schema } });
  const all: Obj[] = [...tools, ...(req.serverTools ?? [])];
  // The cache breakpoint sits on the last tool that loads up front (a deferred tool can't carry one, and isn't in the
  // prompt); the deferred tools follow it with defer_loading, in their fixed order.
  if (all.length) all[all.length - 1] = { ...all[all.length - 1], cache_control: cc };
  if (all.length) all.push(...req.tools.filter((t) => t.defer).map((t) => ({ ...wire(t), defer_loading: true })));

  const system = structured && !force ? `${req.system}\n\nAnswer only by calling the ${STRUCTURED_TOOL} tool.` : req.system;
  const body: Obj = {
    model: req.model.replace(/\[1m\]$/, ""),
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    stream: true,
    ...(system ? { system: [{ type: "text", text: system, cache_control: cc }] } : {}),
    messages,
    ...(all.length ? { tools: all } : {}),
  };
  if (force) body.tool_choice = { type: "tool", name: STRUCTURED_TOOL };
  // A forced tool can't run with thinking: it is turned off where the model allows (Haiku has none to turn off).
  const off = (force || req.thinkingOff) && caps.canDisableThinking;
  if (caps.thinking === "adaptive") body.thinking = off ? { type: "disabled" } : { type: "adaptive" };
  const effort: EffortLevel | undefined = req.claudeEffort;
  // Disabled thinking is only accepted at effort high or below.
  if (effort && caps.effort) body.output_config = { effort: off && (effort === "xhigh" || effort === "max") ? "high" : effort };
  if (req.extra) for (const [k, v] of Object.entries(req.extra)) body[k] = v;
  return body;
}

const STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter", pause_turn: "pause_turn", model_context_window_exceeded: "length" };

type Open =
  | { kind: "text"; text: string; citations: unknown[] }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; ordinal: number }
  | { kind: "server"; block: Obj; json: string };

export class AnthropicDecoder implements StreamDecoder {
  private blocks = new Map<number, Open>();
  private order: number[] = [];
  private calls: DecodedToolCall[] = [];
  private text = "";
  private reasoning = "";
  private stop: string | null = null;
  private used: CallUsage | null = null;
  private tracker = new UsageTracker();

  push(chunk: unknown): DecodedEvent[] {
    if (!isObj(chunk)) return [];
    const out: DecodedEvent[] = [];
    const u = this.tracker.push(chunk);
    if (u) { this.used = u; out.push({ kind: "usage", usage: u }); }
    const index = typeof chunk.index === "number" ? chunk.index : -1;
    switch (chunk.type) {
      case "content_block_start": {
        const b = isObj(chunk.content_block) ? chunk.content_block : {};
        if (!this.blocks.has(index)) this.order.push(index);
        if (b.type === "text") {
          const t = typeof b.text === "string" ? b.text : "";
          this.blocks.set(index, { kind: "text", text: t, citations: [] });
          if (t) { this.text += t; out.push({ kind: "text", delta: t }); }
        } else if (b.type === "thinking") {
          this.blocks.set(index, { kind: "thinking", thinking: typeof b.thinking === "string" ? b.thinking : "", signature: typeof b.signature === "string" ? b.signature : "" });
        } else if (b.type === "redacted_thinking") {
          this.blocks.set(index, { kind: "redacted", data: typeof b.data === "string" ? b.data : "" });
        } else if (b.type === "tool_use") {
          const ordinal = this.calls.length;
          const id = typeof b.id === "string" ? b.id : "";
          const name = typeof b.name === "string" ? b.name : "";
          this.calls.push({ index: ordinal, id, name, arguments: "" });
          this.blocks.set(index, { kind: "tool", ordinal });
          out.push({ kind: "tool_delta", index: ordinal, ...(id ? { id } : {}), ...(name ? { name } : {}), delta: "" });
        } else {
          // server_tool_use, web_search_tool_result, …: kept as they are and sent back verbatim.
          this.blocks.set(index, { kind: "server", block: { ...b }, json: "" });
        }
        break;
      }
      case "content_block_delta": {
        const d = isObj(chunk.delta) ? chunk.delta : {};
        const cur = this.blocks.get(index);
        if (!cur) break;
        if (d.type === "text_delta" && cur.kind === "text" && typeof d.text === "string") {
          cur.text += d.text;
          this.text += d.text;
          if (d.text) out.push({ kind: "text", delta: d.text });
        } else if (d.type === "citations_delta" && cur.kind === "text" && d.citation !== undefined) {
          cur.citations.push(d.citation);
        } else if (d.type === "thinking_delta" && cur.kind === "thinking" && typeof d.thinking === "string") {
          cur.thinking += d.thinking;
          this.reasoning += d.thinking;
          if (d.thinking) out.push({ kind: "reasoning", delta: d.thinking });
        } else if (d.type === "signature_delta" && cur.kind === "thinking" && typeof d.signature === "string") {
          cur.signature += d.signature;
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          if (cur.kind === "tool") {
            this.calls[cur.ordinal]!.arguments += d.partial_json;
            out.push({ kind: "tool_delta", index: cur.ordinal, delta: d.partial_json });
          } else if (cur.kind === "server") cur.json += d.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const cur = this.blocks.get(index);
        if (cur?.kind === "server" && cur.json) {
          try { cur.block.input = JSON.parse(cur.json); } catch { /* keep what started the block */ }
          cur.json = "";
        }
        break;
      }
      case "message_delta": {
        const d = isObj(chunk.delta) ? chunk.delta : {};
        if (typeof d.stop_reason === "string" && d.stop_reason) {
          this.stop = d.stop_reason;
          out.push({ kind: "finish", reason: STOP[d.stop_reason] ?? d.stop_reason });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** The blocks in the order the model wrote them; null when there is nothing a plain text + tool calls can't say. */
  private layout(): LayoutBlock[] | null {
    const blocks: LayoutBlock[] = [];
    let special = false;
    let texts = 0;
    for (const i of this.order) {
      const b = this.blocks.get(i)!;
      if (b.kind === "text") { texts++; blocks.push({ type: "text", text: b.text, ...(b.citations.length ? { citations: b.citations } : {}) }); if (b.citations.length) special = true; }
      else if (b.kind === "thinking") { special = true; blocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature }); }
      else if (b.kind === "redacted") { special = true; blocks.push({ type: "redacted_thinking", data: b.data }); }
      else if (b.kind === "tool") blocks.push({ type: "tool_use", id: this.calls[b.ordinal]!.id });
      else { special = true; blocks.push(b.block); }
    }
    // Text after a tool call, or several text blocks, would be re-ordered or merged by the plain encoding.
    const firstTool = blocks.findIndex((b) => b.type === "tool_use");
    const textAfterTool = firstTool >= 0 && blocks.slice(firstTool).some((b) => b.type === "text");
    return special || texts > 1 || textAfterTool ? blocks : null;
  }

  finish(): DecodedMessage {
    const layout = this.layout();
    return {
      text: this.text, reasoning: this.reasoning, finishReason: this.stop ? STOP[this.stop] ?? this.stop : null, usage: this.used,
      toolCalls: this.calls.map((c, i) => ({ ...c, id: c.id || `toolu_${i}_${Math.random().toString(36).slice(2, 10)}`, arguments: c.arguments })),
      ...(layout ? { providerMeta: { anthropic: { blocks: layout } } satisfies AnthropicMeta } : {}),
    };
  }

  /** The server blocks this message carried (web search results), for the search helper. */
  serverBlocks(): Obj[] {
    return this.order.map((i) => this.blocks.get(i)!).filter((b): b is Extract<Open, { kind: "server" }> => b.kind === "server").map((b) => b.block);
  }
}

/**
 * A call's usage as it builds up: message_start opens it with the input side; each message_delta's usage is the
 * message's cumulative count, so a field it carries replaces the running value (never lowering it).
 */
export class UsageTracker {
  private cur: Obj = {};
  push(chunk: unknown): CallUsage | null {
    if (!isObj(chunk)) return null;
    let raw: unknown = null;
    if (chunk.type === "message_start" && isObj(chunk.message) && isObj(chunk.message.usage)) {
      const u = { ...chunk.message.usage };
      delete u.output_tokens; // a stream's message_start output count is a placeholder
      this.cur = u;
      raw = this.cur;
    } else if (chunk.type === "message_delta" && isObj(chunk.usage)) {
      for (const [k, v] of Object.entries(chunk.usage)) {
        if (typeof v === "number") this.cur[k] = Math.max(num(this.cur[k]), num(v));
        else if (isObj(v)) this.cur[k] = { ...(isObj(this.cur[k]) ? this.cur[k] as Obj : {}), ...v };
      }
      raw = this.cur;
    }
    return raw ? mapAnthropicUsage(raw) : null;
  }
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;
  encode(req: CanonRequest): Record<string, unknown> { return encodeAnthropic(req); }
  decoder(): AnthropicDecoder { return new AnthropicDecoder(); }
  usage(raw: unknown): CallUsage | null { return mapAnthropicUsage(raw); }
  meter(): { push(chunk: unknown): CallUsage | null } { return new UsageTracker(); }
}

/** Names the coding engines' first cut of this adapter used (release-017), kept so one adapter serves both. */
export const CLAUDE_LOOP_MAX_TOKENS = DEFAULT_MAX_OUTPUT;
export const messagesUsage = mapAnthropicUsage;
