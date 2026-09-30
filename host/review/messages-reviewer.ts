import { HELPER_MODEL, LIMITS } from "@synapse/shared";
import { AnthropicMessagesAdapter, STRUCTURED_TOOL } from "../brain/provider/adapters/anthropic-messages";
import { loadPrompt } from "../prompts/index";
import { providerFetch } from "../usage/metered-provider";
import { checkVerdict, OUTPUT_SCHEMA, REPLY_NUDGE, type ModelReviewer } from "./model-reviewer";
import type { Verdict } from "./types";

/**
 * The safety reviewer on Claude without the Agent SDK (2026-09-30): the same call SdkModelReviewer makes through the
 * CLI, made directly on the Messages API through the auth proxy. Same model (Haiku 4.5), same prompt
 * (orig/reviewer.md, whose reply is "one StructuredOutput tool call"), the same StructuredOutput tool carrying
 * OUTPUT_SCHEMA and forced, no thinking, the same 256-token output cap and the same host-side check (checkVerdict).
 * One verdict is one model request; a reply cut at the cap or without the tool call is an error (the Reviewer cards
 * it), never a verdict. There is no process to prewarm, so no pool.
 */
export class MessagesModelReviewer implements ModelReviewer {
  constructor(private o: { model?: string } = {}) {}

  async review(input: Record<string, unknown>, signal: AbortSignal, botId: string | null = null): Promise<Verdict> {
    const adapter = new AnthropicMessagesAdapter();
    const model = this.o.model ?? HELPER_MODEL;
    const body = adapter.encode({
      model, system: loadPrompt("orig/reviewer.md"), wireName: (n) => n, tools: [], maxOutputTokens: LIMITS.reviewerMaxOutputTokens,
      messages: [{ role: "user", parts: [{ type: "text", text: JSON.stringify(input) }, { type: "text", text: REPLY_NUDGE }] }],
      jsonSchema: { name: "verdict", schema: OUTPUT_SCHEMA, strict: false }, cacheTtl: "5m",
    });
    const s = await providerFetch({ purpose: "review", botId }, adapter, { ref: model, body, signal });
    const dec = adapter.decoder();
    for await (const c of s.chunks) dec.push(c);
    const m = dec.finish();
    if (m.finishReason === "length") throw new Error("reviewer hit its output cap");
    const call = m.toolCalls.find((c) => c.name === STRUCTURED_TOOL);
    if (!call) throw new Error("reviewer returned no structured output");
    let out: { verdict?: unknown };
    try { out = JSON.parse(call.arguments) as { verdict?: unknown }; } catch { throw new Error("reviewer returned no structured output"); }
    if (!out?.verdict) throw new Error("reviewer returned no structured output");
    return checkVerdict(out.verdict);
  }
}
