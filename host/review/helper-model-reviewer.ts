import { LIMITS } from "@synapse/shared";
import { loadPrompt } from "../prompts/index";
import { providerComplete } from "../helper-model/llm";
import type { HelperRouter } from "../helper-model/router";
import { checkVerdict, OUTPUT_SCHEMA, type ModelReviewer } from "./model-reviewer";
import type { Verdict } from "./types";

/**
 * The safety reviewer on a provider model (spec §7a): the same prompt (orig/reviewer.md, with its one line about the
 * StructuredOutput tool swapped for the provider's JSON reply), the same schema, the same output cap and the same
 * host-side check (checkVerdict). One verdict is one model call: no repair retry; anything malformed is an error, which
 * the Reviewer turns into a card. Whether it may decide at all is the qualification record's business (qualification.ts).
 */
const PROVIDER_REPLY = "Output. Your whole reply is one JSON object: {\"verdict\": { … }} with the verdict object in its";
export function providerReviewerPrompt(): string {
  return loadPrompt("orig/reviewer.md").replace("Output. Your whole reply is one StructuredOutput tool call, with the verdict object in its", PROVIDER_REPLY);
}
const REPLY_NUDGE = "Reply with the JSON object only. No other text.";

export class HelperModelReviewer implements ModelReviewer {
  constructor(private ref: string) {}
  async review(input: Record<string, unknown>, signal: AbortSignal, botId: string | null = null): Promise<Verdict> {
    const r = await providerComplete({
      purpose: "review", botId, ref: this.ref, system: providerReviewerPrompt(), user: `${JSON.stringify(input)}\n\n${REPLY_NUDGE}`,
      schema: OUTPUT_SCHEMA, maxTokens: Math.max(LIMITS.reviewerMaxOutputTokens, 1024), signal, repair: false, extra: { temperature: 0 },
    });
    const v = (r.json as { verdict?: unknown } | undefined)?.verdict;
    if (!v) throw new Error("reviewer returned no verdict");
    return checkVerdict(v);
  }
}

/** The ModelReviewer the app uses: Claude's (unchanged) when the reviewer runs on Claude, else the provider's. */
export class RoutedModelReviewer implements ModelReviewer {
  constructor(private router: HelperRouter, private claude: ModelReviewer) {}
  review(input: Record<string, unknown>, signal: AbortSignal, botId?: string | null): Promise<Verdict> {
    const t = this.router.reviewer();
    return t.kind === "claude" ? this.claude.review(input, signal, botId) : new HelperModelReviewer(t.ref).review(input, signal, botId ?? null);
  }
}
