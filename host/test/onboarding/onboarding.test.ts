import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOnboardingModule } from "../../onboarding/module";
import { HostSettingsStore } from "../../store/host-settings";

describe("onboarding module (ONB-01; api-key-only)", () => {
  it("reports whether an API key is saved and marks onboarding seen; there is no Claude login to store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onb-"));
    const settings = new HostSettingsStore(path.join(dir, "s.json"));
    let key = false;
    const m = createOnboardingModule({ settings } as never, { tokenConfigured: () => key });
    expect((m.handlers as Record<string, unknown>).storeClaudeToken).toBeUndefined();
    expect(await m.handlers.getOnboarding!({})).toEqual({ hasSeenOnboarding: false, tokenConfigured: false });
    key = true;
    await m.handlers.completeOnboarding!({});
    expect(await m.handlers.getOnboarding!({})).toEqual({ hasSeenOnboarding: true, tokenConfigured: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("any-key setup: says whether the key is Anthropic's, the account's provider and a new Bot's model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onb-"));
    const settings = new HostSettingsStore(path.join(dir, "s.json"));
    const m = createOnboardingModule({ settings } as never, { tokenConfigured: () => true, anthropicKey: () => false, provider: () => "ollama", newBotModel: async () => null });
    expect(await m.handlers.getOnboarding!({})).toEqual({ hasSeenOnboarding: false, tokenConfigured: true, anthropicKey: false, provider: "ollama", newBotModel: null });
    const a = createOnboardingModule({ settings } as never, { tokenConfigured: () => true, anthropicKey: () => true, provider: () => null, newBotModel: () => "never asked" });
    expect(await a.handlers.getOnboarding!({})).toEqual({ hasSeenOnboarding: false, tokenConfigured: true, anthropicKey: true, provider: null, newBotModel: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
