import type { ProviderId } from "@synapse/shared";
import type {
  CallUsage, CanonMessage, CanonRequest, DecodedEvent, DecodedMessage, DecodedToolCall, ProviderAdapter, StreamDecoder,
} from "./types";
import { quirksFor, type ProviderQuirks } from "./quirks";

/**
 * The OpenAI Chat Completions dialect (spec §2), spoken by OpenAI, OpenRouter, Gemini's OpenAI-compatible endpoint,
 * Ollama and LM Studio. Every difference between them is a field of the provider's quirks record, never a branch on
 * the provider's name.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The keys a provider may hang on a tool call or a message that must be echoed back (Gemini thought signatures). */
const ECHO_KEYS = ["extra_content"] as const;
function echoOf(o: Obj): Obj | undefined {
  const out: Obj = {};
  for (const k of ECHO_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}
function mergeMeta(a: unknown, b: Obj | undefined): unknown {
  if (!b) return a;
  return isObj(a) ? deepMerge(a, b) : b;
}
function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  return out;
}

export function mapUsage(q: ProviderQuirks, raw: unknown): CallUsage | null {
  if (!isObj(raw)) return null;
  const prompt = num(raw.prompt_tokens);
  const completion = num(raw.completion_tokens);
  const total = num(raw.total_tokens);
  if (!prompt && !completion && !total) return null;
  const details = isObj(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  let cached = num(details.cached_tokens);
  let output = completion;
  let costUsd: number | undefined;
  if (q.usageShape === "gemini") {
    // Phase 0: for thinking models total_tokens > prompt + completion (the reasoning is hidden); meter from the total.
    output = Math.max(completion, total - prompt);
  } else if (q.usageShape === "deepseek") {
    cached = num(raw.prompt_cache_hit_tokens);
  } else if (q.usageShape === "openrouter" && typeof raw.cost === "number" && Number.isFinite(raw.cost)) {
    costUsd = raw.cost;
  }
  cached = Math.min(cached, prompt);
  return { inputTokens: prompt - cached, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0, promptTokens: prompt, ...(costUsd !== undefined ? { costUsd } : {}) };
}

function encodeMessages(q: ProviderQuirks, req: CanonRequest): Obj[] {
  const out: Obj[] = [{ role: "system", content: req.system }];
  const msgs = req.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "user") {
      const texts = m.parts.filter((p) => p.type === "text");
      if (texts.length === m.parts.length) out.push({ role: "user", content: texts.map((p) => p.text).join("\n\n") });
      else out.push({ role: "user", content: m.parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } })) });
    } else if (m.role === "assistant") {
      // An empty reply (no text, no calls) is not sent: providers reject an assistant message with nothing in it.
      if (!m.text && !m.toolCalls.length) continue;
      const msg: Obj = { role: "assistant", content: m.text || null };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id, type: "function", function: { name: req.wireName(c.name), arguments: c.arguments.trim() ? c.arguments : "{}" },
          ...(isObj(c.providerMeta) ? c.providerMeta : {}),
        }));
      }
      if (isObj(m.providerMeta)) Object.assign(msg, m.providerMeta);
      out.push(msg);
    } else {
      // A run of tool results: each gets its tool message; their images follow in one user message (or inline).
      const run: Extract<CanonMessage, { role: "tool" }>[] = [];
      for (; i < msgs.length && msgs[i]!.role === "tool"; i++) run.push(msgs[i] as Extract<CanonMessage, { role: "tool" }>);
      i--;
      const images: Obj[] = [];
      for (const t of run) {
        const imgs = t.images ?? [];
        if (imgs.length && q.toolImages === "inline") {
          out.push({ role: "tool", tool_call_id: t.toolCallId, content: [{ type: "text", text: t.text }, ...imgs.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimeType};base64,${im.data}` } }))] });
          continue;
        }
        const note = imgs.length && q.toolImages === "none" ? `\n[${imgs.length} image(s) omitted: this model can't read images]` : "";
        out.push({ role: "tool", tool_call_id: t.toolCallId, content: t.text + note });
        if (q.toolImages === "followup-user-message") for (const im of imgs) images.push({ type: "image_url", image_url: { url: `data:${im.mimeType};base64,${im.data}` } });
      }
      if (images.length) out.push({ role: "user", content: [{ type: "text", text: "The images returned by the tool calls above:" }, ...images] });
    }
  }
  return out;
}

class ChatCompletionsDecoder implements StreamDecoder {
  private text = "";
  private reasoning = "";
  private calls: (DecodedToolCall & { order: number })[] = [];
  /** Wire index → slot in `calls` (Ollama has sent several calls all at index 0, told apart only by id). */
  private slot = new Map<number, number>();
  private finishReason: string | null = null;
  private meta: unknown;
  private used: CallUsage | null = null;

  constructor(private q: ProviderQuirks) {}

  push(chunk: unknown): DecodedEvent[] {
    if (!isObj(chunk)) return [];
    const out: DecodedEvent[] = [];
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const ch of choices) {
      if (!isObj(ch) || num(ch.index) !== 0) continue;
      const d = isObj(ch.delta) ? ch.delta : isObj(ch.message) ? ch.message : {};
      if (typeof d.content === "string" && d.content) { this.text += d.content; out.push({ kind: "text", delta: d.content }); }
      const r = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
      if (r) { this.reasoning += r; out.push({ kind: "reasoning", delta: r }); }
      const echo = echoOf(d);
      if (echo) this.meta = mergeMeta(this.meta, echo);
      if (Array.isArray(d.tool_calls)) {
        d.tool_calls.forEach((tc, pos) => { if (isObj(tc)) out.push(...this.toolDelta(tc, pos)); });
      }
      if (typeof ch.finish_reason === "string" && ch.finish_reason) { this.finishReason = ch.finish_reason; out.push({ kind: "finish", reason: ch.finish_reason }); }
    }
    const u = mapUsage(this.q, chunk.usage);
    if (u) { this.used = u; out.push({ kind: "usage", usage: u }); }
    return out;
  }

  private toolDelta(tc: Obj, pos: number): DecodedEvent[] {
    const wireIndex = typeof tc.index === "number" ? tc.index : pos;
    const id = typeof tc.id === "string" && tc.id ? tc.id : undefined;
    const fn = isObj(tc.function) ? tc.function : {};
    const name = typeof fn.name === "string" && fn.name ? fn.name : undefined;
    const args = typeof fn.arguments === "string" ? fn.arguments : fn.arguments !== undefined && fn.arguments !== null ? JSON.stringify(fn.arguments) : "";
    const seen = this.slot.get(wireIndex);
    let fresh = false;
    const cur = seen === undefined ? undefined : this.calls[seen];
    let k = seen ?? this.calls.length;
    // A new call: an unseen index, a different id at a seen index, or (no ids at all) a fresh name after a complete one.
    if (!cur || (id && cur.id && cur.id !== id) || (!id && name && !tc.index && cur.name && cur.arguments)) {
      k = this.calls.length;
      this.slot.set(wireIndex, k);
      this.calls.push({ index: k, order: k, id: id ?? "", name: "", arguments: "" });
      fresh = true;
    }
    const c = this.calls[k]!;
    if (id && !c.id) c.id = id;
    if (name) c.name = !c.name || c.name === name ? name : c.name + name;
    c.arguments += args;
    const echo = echoOf(tc);
    if (echo) c.providerMeta = mergeMeta(c.providerMeta, echo);
    return [{ kind: "tool_delta", index: k, ...(fresh || id ? { id: c.id || undefined } : {}), ...(name ? { name: c.name } : {}), delta: args }];
  }

  finish(): DecodedMessage {
    return {
      text: this.text, reasoning: this.reasoning, finishReason: this.finishReason, usage: this.used,
      toolCalls: this.calls.map(({ order: _o, ...c }, i) => ({ ...c, id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}` })),
      ...(this.meta !== undefined ? { providerMeta: this.meta } : {}),
    };
  }
}

export class ChatCompletionsAdapter implements ProviderAdapter {
  readonly q: ProviderQuirks;
  constructor(readonly provider: ProviderId) {
    this.q = quirksFor(provider);
  }

  encode(req: CanonRequest): Record<string, unknown> {
    const q = this.q;
    const body: Obj = { model: req.model, stream: true, messages: encodeMessages(q, req) };
    if (q.streamUsage) body.stream_options = { include_usage: true };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        // Phase 0 unknown 3c: never `strict` to a non-OpenAI provider (it makes models invent optional values).
        function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict && q.schemaDialect === "openai-strict" ? { strict: true } : {}) },
      }));
      if (q.parallelToolCalls) body.parallel_tool_calls = true;
    }
    if (req.maxOutputTokens) body[q.maxTokensParam] = req.maxOutputTokens;
    if (req.effort && q.reasoningParam === "reasoning_effort") body.reasoning_effort = req.effort;
    else if (req.effort && q.reasoningParam === "openrouter-reasoning") body.reasoning = req.effort === "none" ? { enabled: false } : { effort: req.effort };
    if (req.cacheKey && q.cacheKeyParam) body[q.cacheKeyParam] = req.cacheKey;
    if (req.jsonSchema) {
      // Phase 0 unknown 6: json_schema structured output works on Gemini compat; Ollama takes it as `format` too.
      const strict = req.jsonSchema.strict && q.schemaDialect === "openai-strict";
      body.response_format = { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, ...(strict ? { strict: true } : {}) } };
      if (q.structuredOutput === "ollama-format") body.format = req.jsonSchema.schema;
    }
    if (q.extraBody) for (const [k, v] of Object.entries(q.extraBody)) body[k] = isObj(v) && isObj(body[k]) ? deepMerge(body[k] as Obj, v) : v;
    if (req.extra) for (const [k, v] of Object.entries(req.extra)) body[k] = v;
    return body;
  }

  decoder(): StreamDecoder {
    return new ChatCompletionsDecoder(this.q);
  }

  usage(raw: unknown): CallUsage | null {
    return mapUsage(this.q, raw);
  }
}
