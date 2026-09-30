import type { ProviderId } from "@synapse/shared";
import type { HostModule, ModuleContext } from "../phase5/types";

type P = Exclude<ProviderId, "anthropic">;
export interface OnboardingDeps {
  /** First-run setup is done: an Anthropic key, or (any-key setup) a consented provider that worked. */
  tokenConfigured(): boolean;
  /** An Anthropic key is saved. Absent = the same as tokenConfigured (Claude only). */
  anthropicKey?(): boolean;
  /** The account's provider when there is no Anthropic key. */
  provider?(): P | null;
  /** What a new Bot runs on (asks a model on this Mac for its list first); null = Claude's default, or none yet. */
  newBotModel?(): Promise<string | null> | string | null;
}

/**
 * First run: whether the tour was seen, and whether a key is set up (the key itself is set through the auth and
 * provider commands, auth/module.ts and auth/provider-module.ts). Any-key setup: an Anthropic key, or any provider
 * the user allowed whose key worked, or a model on this Mac that answered.
 */
export function createOnboardingModule(ctx: Pick<ModuleContext, "settings">, o: OnboardingDeps): HostModule {
  return {
    name: "onboarding",
    handlers: {
      getOnboarding: async () => {
        const hasSeenOnboarding = ctx.settings.extra("hasSeenOnboarding", false);
        const tokenConfigured = o.tokenConfigured();
        if (!o.anthropicKey) return { hasSeenOnboarding, tokenConfigured };
        const provider = o.provider?.() ?? null;
        return { hasSeenOnboarding, tokenConfigured, anthropicKey: o.anthropicKey(), provider, newBotModel: provider ? (await o.newBotModel?.()) ?? null : null };
      },
      completeOnboarding: () => { ctx.settings.setExtra("hasSeenOnboarding", true); return {}; },
    },
  };
}
