import { z, type ZodType } from "zod";
import type { BotToolDef } from "../types";
import type { SchemaDialect } from "./adapters/quirks";
import type { WireTool } from "./adapters/types";

/**
 * ToolRegistry (spec §2): canonical tool names ⇄ the model-facing function tools, with each tool's JSON Schema in the
 * provider's dialect. A ToolCall always carries the Claude canonical name (`mcp__bot__Shell`), so the approval gate,
 * the classifier, discipline and presence all work unchanged.
 *
 * The handlers are NOT reachable from a registry entry: they sit in a module-private table that only
 * `handlerForTicket` reads, and only tool-loop.ts calls that (with a GateTicket the gate step minted). Guarded by
 * test/brain/provider/handler-guard.test.ts.
 */
export interface RegisteredTool {
  canonical: string;
  /** The name the model sees (`^[A-Za-z0-9_-]{1,64}$`). */
  wireName: string;
  description: string;
  readOnly: boolean;
  /** The zod validator for the tool's input. */
  validator: ZodType;
  wire: WireTool;
}

const handlers = new WeakMap<RegisteredTool, BotToolDef["handler"]>();

/** Only tool-loop.ts may call this (the guard test enforces it); `ticket` is checked there. */
export function handlerForTicket(t: RegisteredTool): BotToolDef["handler"] {
  const h = handlers.get(t);
  if (!h) throw new Error(`no handler registered for ${t.canonical}`);
  return h;
}

const WIRE_RE = /^[A-Za-z0-9_-]{1,64}$/;
function sanitizeName(n: string): string {
  const s = n.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s || "tool";
}

/** zod 4's own converter (phase 0 unknown 3a: zod-to-json-schema returns an empty schema for zod 4). */
export function zodToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const s = z.toJSONSchema(z.object(shape), { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return stripIntNoise(s) as Record<string, unknown>;
}

/** z.int() emits ±MAX_SAFE_INTEGER bounds; they say nothing and some providers reject them. */
function stripIntNoise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIntNoise);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === "maximum" && x === Number.MAX_SAFE_INTEGER) || (k === "minimum" && x === Number.MIN_SAFE_INTEGER)) continue;
    out[k] = stripIntNoise(x);
  }
  return out;
}

const STRICT_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$ref", "$defs", "definitions", "description", "title",
  "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems"]);
const STRICT_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
/** Phase 0 unknown 3c: with every field required, models invent values for optional ones. Strict only when few are. */
export const STRICT_MAX_OPTIONAL = 2;

/**
 * The per-tool sanitizer (phase 0 unknown 3d): returns the schema to send and whether it can go `strict`.
 * - `gemini` / `loose`: zod's schema as it is, never strict (3b: Gemini takes it; 3c: strict makes models invent values).
 * - `openai-strict`: every field required and nullable, `additionalProperties:false`, unsupported keywords moved into
 *   the description. A free-form object can't be strict at all, and a tool with more than STRICT_MAX_OPTIONAL optional
 *   fields isn't made strict either: both go loose (`strict:false`) and rely on zod validation.
 */
export function sanitizeSchema(schema: Record<string, unknown>, dialect: SchemaDialect): { schema: Record<string, unknown>; strict: boolean } {
  if (dialect !== "openai-strict") return { schema, strict: false };
  let freeForm = false;
  let optional = 0;
  const fix = (s: Record<string, unknown>, isOptional: boolean): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...s };
    for (const k of Object.keys(o)) {
      if (STRICT_KEYWORDS.has(k)) continue;
      if (k === "default" || k === "minLength" || k === "maxLength") o.description = `${o.description ? `${String(o.description)} ` : ""}(${k}: ${JSON.stringify(o[k])})`;
      delete o[k];
    }
    if (typeof o.format === "string" && !STRICT_FORMATS.has(o.format)) delete o.format;
    const t = o.type;
    if (t === "object" || o.properties) {
      if (o.additionalProperties && typeof o.additionalProperties === "object") freeForm = true;
      if (!o.properties || !Object.keys(o.properties as object).length) freeForm = true;
      const req = new Set((o.required as string[] | undefined) ?? []);
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((o.properties as Record<string, Record<string, unknown>>) ?? {})) {
        if (!req.has(k)) optional++;
        props[k] = fix(v, !req.has(k));
      }
      o.properties = props;
      o.required = Object.keys(props);
      o.additionalProperties = false;
    }
    if (o.items && typeof o.items === "object" && !Array.isArray(o.items)) o.items = fix(o.items as Record<string, unknown>, false);
    if (Array.isArray(o.anyOf)) o.anyOf = (o.anyOf as Record<string, unknown>[]).map((a) => fix(a, false));
    if (isOptional) {
      if (Array.isArray(o.anyOf)) (o.anyOf as unknown[]).push({ type: "null" });
      else if (typeof o.type === "string") o.type = [o.type, "null"];
      if (Array.isArray(o.enum) && !o.enum.includes(null)) o.enum = [...o.enum, null];
    }
    return o;
  };
  const out = fix(schema, false);
  if (freeForm || optional > STRICT_MAX_OPTIONAL) return { schema, strict: false };
  return { schema: out, strict: true };
}

/** A JSON-Schema tool's local check: an object with its top-level required fields present. */
function requiredKeysValidator(schema: Record<string, unknown>): ZodType {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return z.looseObject({}).superRefine((v, ctx) => {
    for (const k of required) if (!(k in v) || v[k] === null) ctx.addIssue({ code: "custom", path: [k], message: "Required" });
  });
}

/** Canonical names: bot tools are served as `mcp__bot__<name>` (the Claude brain's MCP server "bot"). */
export const BOT_PREFIX = "mcp__bot__";

export class ToolRegistry {
  private byCanonical = new Map<string, RegisteredTool>();
  private byWire = new Map<string, RegisteredTool>();

  /**
   * `tools`: the Bot's tools (runner.wiring(botId).botTools()), in a fixed order so the request prefix stays
   * byte-stable for prompt caching. Bot tools go to the model under their bare name (`SendMessage`), which is how the
   * standalone prompt names them; anything else keeps its sanitized canonical name.
   */
  constructor(tools: { canonical: string; def: BotToolDef; jsonSchema?: Record<string, unknown> }[], dialect: SchemaDialect, maxTools = Number.POSITIVE_INFINITY) {
    for (const { canonical, def, jsonSchema } of tools) {
      if (this.byCanonical.has(canonical) || this.byCanonical.size >= maxTools) continue;
      const bare = canonical.startsWith(BOT_PREFIX) ? canonical.slice(BOT_PREFIX.length) : canonical;
      let wireName = WIRE_RE.test(bare) ? bare : sanitizeName(bare);
      for (let n = 2; this.byWire.has(wireName); n++) wireName = `${sanitizeName(bare).slice(0, 60)}_${n}`;
      // An MCP server's tool (spec P2) brings its own JSON Schema; the server validates the rest itself.
      const { schema, strict } = sanitizeSchema(jsonSchema ? { type: "object", properties: {}, ...jsonSchema } : zodToJsonSchema(def.schema), dialect);
      const t: RegisteredTool = {
        canonical, wireName, description: def.description, readOnly: def.readOnly, validator: jsonSchema ? requiredKeysValidator(jsonSchema) : z.object(def.schema),
        wire: { name: wireName, description: def.description, parameters: schema, strict },
      };
      handlers.set(t, def.handler);
      this.byCanonical.set(canonical, t);
      this.byWire.set(wireName, t);
    }
  }

  static forBotTools(defs: BotToolDef[], dialect: SchemaDialect, maxTools?: number): ToolRegistry {
    return new ToolRegistry(defs.map((def) => ({ canonical: `${BOT_PREFIX}${def.name}`, def })), dialect, maxTools);
  }

  wireTools(): WireTool[] {
    return [...this.byCanonical.values()].map((t) => t.wire);
  }
  canonicalNames(): string[] {
    return [...this.byCanonical.keys()];
  }
  /** A model-facing name back to its tool; an invented name is undefined. */
  fromWire(name: string): RegisteredTool | undefined {
    return this.byWire.get(name) ?? this.byCanonical.get(name);
  }
  wireName(canonical: string): string {
    return this.byCanonical.get(canonical)?.wireName ?? sanitizeName(canonical.startsWith(BOT_PREFIX) ? canonical.slice(BOT_PREFIX.length) : canonical);
  }
}
