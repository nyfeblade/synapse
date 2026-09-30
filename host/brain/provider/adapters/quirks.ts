import type { ProviderId } from "@synapse/shared";

/**
 * One record per provider (spec §2 `quirks.ts`). Everything the Chat Completions adapter, the tool registry and the
 * metered transport need to know about a provider's dialect lives here, so no other code branches on a provider id.
 *
 * `baseUrl` is fixed per provider (no custom endpoints, spec §1 non-goals). Only usage/metered-provider.ts reads it
 * (guarded by test/brain/provider/metering-guard.test.ts): nothing else in the host may address a provider.
 */
export type SchemaDialect = "openai-strict" | "gemini" | "loose";
export type ToolImages = "inline" | "followup-user-message" | "none";
export type UsageShape = "openai" | "gemini" | "openrouter" | "deepseek";
export type StructuredOutput = "json_schema" | "ollama-format" | "forced-tool";

export interface ProviderQuirks {
  id: Exclude<ProviderId, "anthropic">;
  baseUrl: string;
  /** How the key is sent; "none" for local providers. */
  authHeader: "bearer" | "none";
  schemaDialect: SchemaDialect;
  toolImages: ToolImages;
  /** How reasoning effort is asked for; null = not sent. */
  reasoningParam: "reasoning_effort" | "openrouter-reasoning" | null;
  /** The body field that caps output tokens. */
  maxTokensParam: "max_completion_tokens" | "max_tokens";
  cacheKeyParam: "prompt_cache_key" | null;
  usageShape: UsageShape;
  structuredOutput: StructuredOutput;
  /** stream_options.include_usage is understood (usage arrives as a final chunk). */
  streamUsage: boolean;
  parallelToolCalls: boolean;
  nativeSearch: boolean;
  maxTools: number;
  /** Error bodies can come back as a JSON array (Gemini compat: [{"error":…}], phase 0). */
  errorArrays: boolean;
  /** Extra fields merged into every request body (OpenRouter: no data collection, usage accounting). */
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  contextProbe: "none" | "ollama-ps" | "lmstudio-models";
}

const BASE = { parallelToolCalls: true, nativeSearch: false, maxTools: 128, errorArrays: false, contextProbe: "none", streamUsage: true } as const;

export const PROVIDER_QUIRKS: Readonly<Record<Exclude<ProviderId, "anthropic">, ProviderQuirks>> = {
  openai: {
    ...BASE, id: "openai", baseUrl: "https://api.openai.com/v1", authHeader: "bearer", schemaDialect: "openai-strict",
    // Chat Completions tool messages carry text only; an image goes in a user message after the results.
    toolImages: "followup-user-message", reasoningParam: "reasoning_effort", maxTokensParam: "max_completion_tokens",
    cacheKeyParam: "prompt_cache_key", usageShape: "openai", structuredOutput: "json_schema", nativeSearch: true,
  },
  openrouter: {
    ...BASE, id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", authHeader: "bearer", schemaDialect: "loose",
    toolImages: "followup-user-message", reasoningParam: "openrouter-reasoning", maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "openrouter", structuredOutput: "json_schema", nativeSearch: true,
    // Spec §4: requests never go to a provider that keeps them (the consent text names it); usage.cost is authoritative.
    extraBody: { provider: { data_collection: "deny" }, usage: { include: true } },
  },
  gemini: {
    ...BASE, id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", authHeader: "bearer", schemaDialect: "gemini",
    // Phase 0 unknown 4: an image_url part inside a tool message is a 400; a follow-up user message works.
    toolImages: "followup-user-message", reasoningParam: "reasoning_effort", maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "gemini", structuredOutput: "json_schema", errorArrays: true, nativeSearch: true,
  },
  ollama: {
    ...BASE, id: "ollama", baseUrl: "http://host.orb.internal:11434/v1", authHeader: "none", schemaDialect: "loose",
    toolImages: "followup-user-message", reasoningParam: "reasoning_effort", maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "openai", structuredOutput: "ollama-format", contextProbe: "ollama-ps", maxTools: 40,
  },
  lmstudio: {
    ...BASE, id: "lmstudio", baseUrl: "http://host.orb.internal:1234/v1", authHeader: "none", schemaDialect: "loose",
    toolImages: "followup-user-message", reasoningParam: null, maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "openai", structuredOutput: "json_schema", contextProbe: "lmstudio-models", maxTools: 40,
  },
  // P2 providers (spec §13 P2).
  mistral: {
    ...BASE, id: "mistral", baseUrl: "https://api.mistral.ai/v1", authHeader: "bearer", schemaDialect: "loose",
    // Mistral streams its usage in the last chunk on its own; it isn't sent stream_options (an unknown field there
    // is a 422 on strict validators). Web search is an Agents/Conversations feature, not Chat Completions: Mistral
    // Bots borrow another provider's search (rulings 60).
    streamUsage: false, toolImages: "followup-user-message", reasoningParam: null, maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "openai", structuredOutput: "json_schema",
  },
  deepseek: {
    ...BASE, id: "deepseek", baseUrl: "https://api.deepseek.com/v1", authHeader: "bearer", schemaDialect: "loose",
    // No image input: a tool's images become a note. Cached tokens come as prompt_cache_hit_tokens.
    toolImages: "none", reasoningParam: null, maxTokensParam: "max_tokens",
    cacheKeyParam: null, usageShape: "deepseek", structuredOutput: "json_schema",
  },
};

export function quirksFor(p: ProviderId): ProviderQuirks {
  if (p === "anthropic") throw new Error("Anthropic models run on the Claude brain, not a provider adapter");
  return PROVIDER_QUIRKS[p];
}
