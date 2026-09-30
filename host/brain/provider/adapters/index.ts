import { isClaudeModel, parseProviderModelRef, type ProviderId } from "@synapse/shared";
import { AnthropicMessagesAdapter } from "./anthropic-messages";
import { ChatCompletionsAdapter } from "./chat-completions";
import { quirksFor, type SchemaDialect } from "./quirks";
import type { ProviderAdapter } from "./types";

/**
 * Where a model ref runs on Synapse's own loop: "<provider>:<model>" for a model provider, or a Claude model id
 * ("claude-sonnet-5", "[1m]" allowed) on Anthropic's Messages API (2026-09-30: Claude is one provider among many).
 */
export interface ModelTarget { provider: ProviderId; model: string }
export function modelTarget(ref: string | null | undefined): ModelTarget | null {
  if (!ref) return null;
  const p = parseProviderModelRef(ref);
  if (p) return p;
  const bare = ref.replace(/\[1m\]$/, "");
  if (isClaudeModel(bare) || /^claude-[a-z0-9][a-z0-9.-]{0,80}$/.test(bare)) return { provider: "anthropic", model: bare };
  return null;
}
export const isAnthropicRef = (ref: string | null | undefined): boolean => modelTarget(ref)?.provider === "anthropic";

/** The adapter that speaks the provider's dialect. */
export function adapterFor(provider: ProviderId): ProviderAdapter {
  return provider === "anthropic" ? new AnthropicMessagesAdapter() : new ChatCompletionsAdapter(provider);
}

/** What the tool registry and the brain need to know about the provider's dialect. */
export interface BrainDialect { schemaDialect: SchemaDialect; maxTools: number }
export function dialectFor(provider: ProviderId): BrainDialect {
  // Claude takes zod's JSON Schema as it is (no strict mode); the tool cap matches the cloud providers'.
  if (provider === "anthropic") return { schemaDialect: "loose", maxTools: 128 };
  const q = quirksFor(provider);
  return { schemaDialect: q.schemaDialect, maxTools: q.maxTools };
}
