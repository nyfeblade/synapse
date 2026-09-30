import { isLocalProvider, parseProviderModelRef, PROVIDER_CATALOG, type ProviderId } from "@synapse/shared";

/**
 * HelperRouter (spec 2026-09-29 §7a): which model a helper call runs on.
 * - A call for a Bot on a provider model runs on that provider's small model (catalog helperModel), or on the Bot's own
 *   model when the provider has none, so a Bot's helpers never cross to another provider.
 * - Every other call (host-level, or a Claude Bot's) runs on the ACCOUNT helper: Claude when an Anthropic key is
 *   saved, otherwise the first provider the user consented to and set up, in the order Anthropic, OpenAI, Gemini,
 *   OpenRouter, Mistral, DeepSeek, then local models. Any-key setup: the provider setup chose (`preferred`) goes
 *   first, and a provider with no helper model and no Bot on it yet lends its main model (OpenRouter's auto router,
 *   the first model on this Mac: `fallbackModel`), so host-level work runs from the first minute.
 * - The safety reviewer runs on the account helper provider's reviewer model (its helper model today).
 */
export type HelperTarget = { kind: "claude" } | { kind: "provider"; ref: string };
type P = Exclude<ProviderId, "anthropic">;
export const ACCOUNT_HELPER_ORDER: readonly P[] = ["openai", "gemini", "openrouter", "mistral", "deepseek", "ollama", "lmstudio"];

export interface HelperRouterDeps {
  /** The Bot's model (profile.model), or undefined for none / a deleted Bot. */
  botModel(botId: string): string | undefined;
  /** An Anthropic API key is saved. */
  anthropicReady(): boolean;
  consented(p: ProviderId): boolean;
  hasKey(p: ProviderId): boolean;
  /** Every Bot's model: a provider with no helper model (OpenRouter, local) lends one of its Bots' models. */
  botModels?(): string[];
  /** Settings → Auto-review → Safety reviewer: the user's pick (a provider model ref), or null for the default. */
  reviewerChoice?(): string | null;
  /** Any-key setup: the account's provider (the one setup chose), tried first. */
  preferred?(): P | null;
  /** A model to lend when the provider has no helper model and none of its Bots lends one (a provider model ref). */
  fallbackModel?(p: P): string | null;
}

export class HelperRouter {
  constructor(private d: HelperRouterDeps) {}

  /** A provider's helper ref; null when it has no helper model and no fallback was given. */
  static helperRef(p: P, fallback?: string): string | null {
    const h = PROVIDER_CATALOG[p].helperModel;
    return h ? `${p}:${h}` : fallback ?? null;
  }

  private usable(p: P): boolean {
    return this.d.consented(p) && (isLocalProvider(p) || this.d.hasKey(p));
  }

  forBot(botId: string | null): HelperTarget {
    if (botId) {
      const m = this.d.botModel(botId);
      const r = m ? parseProviderModelRef(m) : null;
      if (r && this.usable(r.provider)) return { kind: "provider", ref: HelperRouter.helperRef(r.provider, m)! };
    }
    return this.account();
  }

  account(): HelperTarget {
    if (this.d.anthropicReady()) return { kind: "claude" };
    const first = this.d.preferred?.() ?? null;
    const order = first ? [first, ...ACCOUNT_HELPER_ORDER.filter((p) => p !== first)] : ACCOUNT_HELPER_ORDER;
    for (const p of order) {
      if (!this.usable(p)) continue;
      const lent = this.d.botModels?.().find((m) => parseProviderModelRef(m)?.provider === p) ?? this.d.fallbackModel?.(p) ?? undefined;
      const ref = HelperRouter.helperRef(p, lent);
      if (ref) return { kind: "provider", ref };
    }
    return { kind: "claude" }; // nothing set up: the Claude path fails as it does today (no key)
  }

  /** The safety reviewer's model (spec §7a: the account helper provider's reviewerModel ?? helperModel). */
  reviewer(): HelperTarget {
    const pick = this.d.reviewerChoice?.() ?? null;
    const p = pick ? parseProviderModelRef(pick) : null;
    if (p && this.usable(p.provider)) return { kind: "provider", ref: pick! };
    return this.account();
  }
}
