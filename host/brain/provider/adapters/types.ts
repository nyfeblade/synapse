import type { ProviderId } from "@synapse/shared";
import type { ToolImage } from "../../types";

/**
 * Canonical messages (spec §2 ProviderAdapter): what ProviderBrain keeps, whatever the wire dialect. Tool calls keep
 * the Claude canonical tool name ("mcp__bot__Shell"); the adapter maps it to the model-facing name when it encodes.
 *
 * `providerMeta` is opaque: whatever a provider hands back beside a message or a tool call that it needs to see again
 * on the next request (Gemini 3's thought signatures, `extra_content.google.thought_signature`, phase 0 unknown 4).
 * It is stored with the message and echoed back verbatim; nothing else reads it.
 */
export type CanonPart = { type: "text"; text: string } | { type: "image"; mediaType: string; dataBase64: string };

export interface CanonToolCall {
  id: string;
  /** Claude canonical name (mcp__bot__SendMessage). */
  name: string;
  /** The arguments exactly as the model produced them (a JSON string, possibly invalid). */
  arguments: string;
  providerMeta?: unknown;
}

export type CanonMessage =
  | { role: "user"; parts: CanonPart[] }
  | { role: "assistant"; text: string; toolCalls: CanonToolCall[]; providerMeta?: unknown }
  | { role: "tool"; toolCallId: string; name: string; text: string; isError: boolean; images?: ToolImage[] };

/** A function tool as the model sees it. */
export interface WireTool { name: string; description: string; parameters: Record<string, unknown>; strict: boolean }

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface CanonRequest {
  model: string;
  system: string;
  messages: CanonMessage[];
  tools: WireTool[];
  /** Canonical name → model-facing name, for encoding history. */
  wireName(canonical: string): string;
  maxOutputTokens?: number;
  effort?: ReasoningEffort;
  /** A stable per-Bot key for providers with an explicit prompt-cache key (OpenAI prompt_cache_key). */
  cacheKey?: string;
  /** Structured output (helpers, the reviewer): the reply must be JSON matching this schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict: boolean };
  /** Provider-specific extras merged into the body last (OpenRouter's web plugin). */
  extra?: Record<string, unknown>;
}

/** Token usage one model call reported (or that was estimated when it reported none). */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The provider's own price for the call (OpenRouter usage.cost), authoritative when present. */
  costUsd?: number;
  /** The prompt as the provider counted it (input + cached), for the context meter. */
  promptTokens: number;
  /** No usage frame arrived (an aborted or broken stream): these numbers are estimated from the bytes. */
  estimated?: boolean;
}

export type DecodedEvent =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  /** A tool call started or grew. `id`/`name` arrive on its first delta; `delta` is more of its JSON arguments. */
  | { kind: "tool_delta"; index: number; id?: string; name?: string; delta: string }
  | { kind: "usage"; usage: CallUsage }
  | { kind: "finish"; reason: string };

export interface DecodedToolCall { index: number; id: string; name: string; arguments: string; providerMeta?: unknown }
export interface DecodedMessage {
  text: string;
  reasoning: string;
  toolCalls: DecodedToolCall[];
  finishReason: string | null;
  providerMeta?: unknown;
  usage: CallUsage | null;
}

export interface StreamDecoder {
  /** One parsed stream chunk (the JSON of one SSE `data:` line). */
  push(chunk: unknown): DecodedEvent[];
  /** The whole message, once the stream is complete. */
  finish(): DecodedMessage;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** The request body for a streamed call. */
  encode(req: CanonRequest): Record<string, unknown>;
  decoder(): StreamDecoder;
  /** Maps a usage object the provider reported (in a stream chunk or a JSON response) to CallUsage. */
  usage(raw: unknown): CallUsage | null;
}
