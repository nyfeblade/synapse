import { adapterFor, modelTarget } from "../brain/provider/adapters/index";
import { STRUCTURED_TOOL } from "../brain/provider/adapters/anthropic-messages";
import type { CanonMessage } from "../brain/provider/adapters/types";
import { providerFetch } from "../usage/metered-provider";

/**
 * HelperLLM (spec 2026-09-29 §7a): one call, no tools, on a provider's model — the provider twin of the Claude helper
 * paths (brain/one-shot.ts, helper-model/one-shot.ts, the dreaming and reviewer calls). Metered by providerFetch under
 * the call's purpose and Bot. Structured output uses the provider's `json_schema` (quirks.structuredOutput), then the
 * host's own schema check, then ONE repair retry that shows the model what was wrong.
 */
export interface HelperRequest {
  purpose: string;
  botId: string | null;
  /** "<provider>:<model>", or a Claude model id (Anthropic's Messages API). */
  ref: string;
  system: string;
  user: string;
  /** Structured output: the reply must be JSON matching this schema. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra body fields (OpenRouter's web plugin). */
  extra?: Record<string, unknown>;
  /** Default true: one repair retry when the JSON doesn't validate. The reviewer passes false (one verdict, one call). */
  repair?: boolean;
}
export interface HelperResult { text: string; json?: unknown }

export class HelperOutputError extends Error {
  constructor(message: string) { super(message); this.name = "HelperOutputError"; }
}

/** The JSON inside a reply: the whole text, or a fenced ```json block, or the outermost {...}. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1];
  for (const cand of [t, fenced, /\{[\s\S]*\}/.exec(t)?.[0]]) {
    if (!cand) continue;
    try { return JSON.parse(cand); } catch { /* next */ }
  }
  throw new HelperOutputError("the reply was not JSON");
}

/** A small JSON Schema check (type, enum, required, properties, additionalProperties:false, items, min/max, pattern, maxLength). */
export function schemaErrors(schema: Record<string, unknown>, v: unknown, at = "$"): string[] {
  const out: string[] = [];
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
  const typeOf = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  if (types && !types.some((t) => t === typeOf(v) || (t === "number" && typeOf(v) === "integer"))) return [`${at}: expected ${types.join("|")}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === v)) out.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  if (typeof v === "string") {
    if (typeof schema.maxLength === "number" && v.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) out.push(`${at}: doesn't match ${schema.pattern}`);
  }
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && v > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(v) && schema.items && typeof schema.items === "object") v.forEach((x, i) => out.push(...schemaErrors(schema.items as Record<string, unknown>, x, `${at}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in (v as object))) out.push(`${at}.${r}: missing`);
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) out.push(...schemaErrors(props[k]!, x, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: not allowed`);
    }
  }
  return out;
}

/** One helper call on a provider model. Throws what providerFetch throws, or HelperOutputError. */
export async function providerComplete(req: HelperRequest): Promise<HelperResult> {
  const p = modelTarget(req.ref);
  if (!p) throw new Error(`not a provider model: ${req.ref}`);
  const adapter = adapterFor(p.provider);
  const ac = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => ac.abort(), req.timeoutMs) : null;
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const messages: CanonMessage[] = [{ role: "user", parts: [{ type: "text", text: req.user }] }];
  const once = async (): Promise<string> => {
    const body = adapter.encode({
      model: p.model, system: req.system, messages, tools: [], wireName: (n) => n, maxOutputTokens: req.maxTokens ?? 2_000,
      ...(req.schema ? { jsonSchema: { name: "output", schema: req.schema, strict: false } } : {}),
      ...(req.extra ? { extra: req.extra } : {}),
    });
    const s = await providerFetch({ purpose: req.purpose, botId: req.botId }, adapter, { ref: req.ref, body, signal: ac.signal });
    const dec = adapter.decoder();
    for await (const c of s.chunks) dec.push(c);
    const m = dec.finish();
    // Claude answers structured output through its StructuredOutput tool: the tool's input is the JSON.
    const structured = req.schema ? m.toolCalls.find((c) => c.name === STRUCTURED_TOOL) : undefined;
    return structured ? structured.arguments : m.text;
  };
  try {
    const text = await once();
    if (!req.schema) return { text };
    let json: unknown;
    let errs: string[];
    try { json = extractJson(text); errs = schemaErrors(req.schema, json); } catch (e) { errs = [String((e as Error).message)]; }
    if (!errs.length) return { text, json };
    if (req.repair === false) throw new HelperOutputError(`the reply didn't match the schema: ${errs.slice(0, 5).join("; ")}`);
    messages.push({ role: "assistant", text, toolCalls: [] }, { role: "user", parts: [{ type: "text", text: `That reply wasn't valid (${errs.slice(0, 5).join("; ")}). Reply with only the corrected JSON object.` }] });
    const again = await once();
    json = extractJson(again);
    errs = schemaErrors(req.schema, json);
    if (errs.length) throw new HelperOutputError(`the reply didn't match the schema: ${errs.slice(0, 5).join("; ")}`);
    return { text: again, json };
  } finally {
    if (timer) clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}
