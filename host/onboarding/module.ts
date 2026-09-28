import type { HostModule, ModuleContext } from "../phase5/types";

/**
 * First run: whether the tour was seen, and whether an Anthropic API key is saved (the one way Bots reach Claude;
 * the key itself is set through the auth commands, auth/module.ts).
 */
export function createOnboardingModule(ctx: Pick<ModuleContext, "settings">, o: { tokenConfigured(): boolean }): HostModule {
  return {
    name: "onboarding",
    handlers: {
      getOnboarding: () => ({ hasSeenOnboarding: ctx.settings.extra("hasSeenOnboarding", false), tokenConfigured: o.tokenConfigured() }),
      completeOnboarding: () => { ctx.settings.setExtra("hasSeenOnboarding", true); return {}; },
    },
  };
}
