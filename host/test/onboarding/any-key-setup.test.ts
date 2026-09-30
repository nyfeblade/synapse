import { afterEach, describe, expect, it } from "vitest";
import type { ModelCatalogView, ProvidersView, SafetyReviewerView } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { credentialsReady } from "../../auth/auth-env";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";
import { reply, startFakeChatServer, type FakeReply, type FakeRequest } from "../brain/provider/fake-chat-server";

/**
 * Any-key setup (Wave 2): "an OpenAI-only user gets the full product with no Anthropic key". First-run setup finishes
 * with any provider whose key worked (or a model on this Mac that answered), new Bots get that provider's main model,
 * host-level helpers run on it, and the Anthropic path is unchanged. Every provider here is a fake server.
 */
const ANTHROPIC_KEY = "sk-ant-api03-" + "A".repeat(80) + "Zq12";
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await app?.close(); app = null; for (const c of closers.splice(0)) await c(); });

type H = Record<string, (a: unknown) => Promise<unknown>>;
type Onb = { hasSeenOnboarding: boolean; tokenConfigured: boolean; anthropicKey?: boolean; provider?: string | null; newBotModel?: string | null };

/** A provider that answers the model list and one tiny call; a key with "wrong" in it gets 401. */
function provider(localModels: string[] = []) {
  return (req: FakeRequest): FakeReply => {
    if (/wrong/.test(String(req.headers.authorization ?? ""))) return { status: 401, body: "{}" };
    if (req.path.endsWith("/api/tags")) return { status: 200, body: JSON.stringify({ models: localModels.map((name) => ({ name })) }) };
    if (req.path.endsWith("/models")) return { status: 200, body: JSON.stringify({ data: localModels.map((id) => ({ id, type: "llm" })) }) };
    return reply({ text: "OK" });
  };
}

async function host(localModels: string[] = []) {
  const up = await startFakeChatServer(provider(localModels));
  closers.push(() => up.close());
  const cfg = tmpConfig();
  app = await createHostApp(cfg, { providerUpstream: () => up.url });
  const h = app.handlers as unknown as H;
  const v = (await h.getProviders!({})) as ProvidersView;
  return { h, up, v, cfg, onb: async () => (await h.getOnboarding!({})) as Onb };
}
const consent = (h: H, v: ProvidersView, p: string) => h.consentProvider!({ provider: p, textVersion: v.providers[0]!.consentVersion });
const sealed = (v: ProvidersView, k: string) => sealTo(v.boxPublicKey, k);

describe("any-key setup: the key step with each provider", () => {
  const cloud = [
    ["openai", "openai:gpt-6.1-sol"],
    ["openrouter", "openrouter:openrouter/auto"],
    ["gemini", "gemini:gemini-3.5-flash"],
    ["mistral", "mistral:mistral-medium-latest"],
    ["deepseek", "deepseek:deepseek-flash"],
  ] as const;
  for (const [p, model] of cloud) {
    it(`${p}: consent, a key that worked, and setup is done with no Anthropic key; new Bots run on ${model}`, async () => {
      const { h, v, onb } = await host();
      expect(credentialsReady()).toBe(false);
      expect(await onb()).toMatchObject({ tokenConfigured: false, anthropicKey: false, provider: null });
      await consent(h, v, p);
      const key = `sk-${p}-0123456789abcdefghij`;
      // The key step tests the typed key, then saves that same key: no second paid call.
      expect(await h.testProviderKey!({ provider: p, sealed: await sealed(v, key) })).toMatchObject({ ok: true });
      await h.setProviderKey!({ provider: p, sealed: await sealed(v, key) });
      expect(await onb()).toEqual({ hasSeenOnboarding: false, tokenConfigured: true, anthropicKey: false, provider: p, newBotModel: model });
      const { id } = (await h.createAgent!({ name: "Iris", isKickstartRequested: false })) as { id: string };
      expect(app!.services.bots.summary(id).profile.model).toBe(model);
    });
  }

  it("On this Mac (Ollama): consent and an answer finish setup; a new Bot gets the first model it lists", async () => {
    const { h, v, onb } = await host(["qwen3:4b", "llama4:8b"]);
    await consent(h, v, "ollama");
    expect(await h.testProviderKey!({ provider: "ollama" })).toMatchObject({ ok: true });
    expect(await onb()).toMatchObject({ tokenConfigured: true, anthropicKey: false, provider: "ollama", newBotModel: "ollama:qwen3:4b" });
    const { id } = (await h.createAgent!({ name: "Juno", isKickstartRequested: false })) as { id: string };
    expect(app!.services.bots.summary(id).profile.model).toBe("ollama:qwen3:4b");
  });

  it("On this Mac (LM Studio) with no model downloaded: setup is done, and there is no model to give a new Bot", async () => {
    const { h, v, onb } = await host([]);
    await consent(h, v, "lmstudio");
    expect(await h.testProviderKey!({ provider: "lmstudio" })).toMatchObject({ ok: true });
    expect(await onb()).toMatchObject({ tokenConfigured: true, provider: "lmstudio", newBotModel: null });
    const { id } = (await h.createAgent!({ name: "Juno", isKickstartRequested: false })) as { id: string };
    expect(app!.services.bots.summary(id).profile.model).toBeUndefined();
  });
});

describe("any-key setup: starter Bots", () => {
  it("a starter Bot (and one made for Claude) gets the account provider's main model; a group gets none", async () => {
    const { h, v } = await host();
    await consent(h, v, "deepseek");
    await h.testProviderKey!({ provider: "deepseek", sealed: await sealed(v, "sk-deepseek-0123456789ab") });
    await h.setProviderKey!({ provider: "deepseek", sealed: await sealed(v, "sk-deepseek-0123456789ab") });
    const { starters } = (await h.listStarterTemplates!({})) as { starters: { id: string }[] };
    expect(starters.length).toBeGreaterThan(0);
    const { token } = (await h.previewTemplateImport!({ starterId: starters[0]!.id })) as { token: string };
    const { id } = (await h.importTemplate!({ token })) as { id: string };
    expect(app!.services.bots.summary(id).profile.model).toBe("deepseek:deepseek-flash");
    // The starter's first turn (it speaks first) runs on DeepSeek; let it settle before the host closes.
    const t = Date.now() + 10_000;
    while (!app!.services.runner.isIdle(id) && Date.now() < t) await new Promise((r) => setTimeout(r, 20));
    // A Bot asked for on a Claude model with no Anthropic key would never answer: it runs on the account's provider.
    const bot = app!.services.bots.create({ name: "Cato", model: "claude-sonnet-5" as never, origin: "user", kickstart: false });
    expect(app!.services.bots.summary(bot).profile.model).toBe("deepseek:deepseek-flash");
    // A provider model asked for is kept.
    const kept = app!.services.bots.create({ name: "Kit", model: "openai:gpt-6-astra" as never, origin: "user", kickstart: false });
    expect(app!.services.bots.summary(kept).profile.model).toBe("openai:gpt-6-astra");
  });
});

describe("any-key setup: the gate", () => {
  it("counts only a consented provider whose saved key worked", async () => {
    const { h, v, onb } = await host();
    await consent(h, v, "openai");
    // Saved without a test: not yet (a key that was never shown to work doesn't finish setup).
    await h.setProviderKey!({ provider: "openai", sealed: await sealed(v, "sk-openai-untested-0123456789") });
    expect((await onb()).tokenConfigured).toBe(false);
    // Test key on the saved key: it works, setup is done.
    expect(await h.testProviderKey!({ provider: "openai" })).toMatchObject({ ok: true });
    expect((await onb()).tokenConfigured).toBe(true);
    // Replacing it with a key that is rejected: not set up any more, until a key works again.
    await h.setProviderKey!({ provider: "openai", sealed: await sealed(v, "sk-wrong-key-0123456789") });
    expect((await onb()).tokenConfigured).toBe(false);
    expect(await h.testProviderKey!({ provider: "openai" })).toMatchObject({ ok: false, kind: "invalid-key" });
    expect((await onb()).tokenConfigured).toBe(false);
    // Removing the key forgets it.
    await h.setProviderKey!({ provider: "openai", sealed: await sealed(v, "sk-openai-good-0123456789") });
    await h.testProviderKey!({ provider: "openai" });
    expect((await onb()).tokenConfigured).toBe(true);
    await h.clearProviderKey!({ provider: "openai" });
    expect((await onb()).tokenConfigured).toBe(false);
  });

  it("a rejected typed key isn't remembered as working, and a key that worked survives a restart", async () => {
    const { h, v, cfg, onb } = await host();
    await consent(h, v, "gemini");
    expect(await h.testProviderKey!({ provider: "gemini", sealed: await sealed(v, "sk-wrong-gem-0123456789") })).toMatchObject({ ok: false });
    await h.setProviderKey!({ provider: "gemini", sealed: await sealed(v, "sk-wrong-gem-0123456789") });
    expect((await onb()).tokenConfigured).toBe(false);
    const good = "AIza-good-gemini-0123456789";
    await h.testProviderKey!({ provider: "gemini", sealed: await sealed(v, good) });
    await h.setProviderKey!({ provider: "gemini", sealed: await sealed(v, good) });
    expect((await onb()).tokenConfigured).toBe(true);
    await app!.close();
    app = null;
    app = await createHostApp(cfg, { providerUpstream: () => "http://127.0.0.1:9" });
    expect(((await (app.handlers as unknown as H).getOnboarding!({})) as Onb)).toMatchObject({ tokenConfigured: true, provider: "gemini" });
  });

  it("no consent, no setup: a key can't be saved before the provider is allowed", async () => {
    const { h, v, onb } = await host();
    await expect(h.setProviderKey!({ provider: "openai", sealed: await sealed(v, "sk-openai-0123456789abcdef") })).rejects.toThrow();
    expect(await h.testProviderKey!({ provider: "openai", sealed: await sealed(v, "sk-openai-0123456789abcdef") })).toMatchObject({ ok: false, kind: "no-consent" });
    expect((await onb()).tokenConfigured).toBe(false);
  });
});

describe("any-key setup: the account helper, the reviewer and Claude-only features with no Anthropic key", () => {
  it("host-level work runs on the chosen provider; the reviewer is ask-only; coding agents and computer helpers need an Anthropic key", async () => {
    const { h, v } = await host();
    // Two providers set up: the one setup chose (Mistral) is the account's, ahead of OpenAI in the default order.
    for (const p of ["mistral", "openai"]) {
      await consent(h, v, p);
      await h.testProviderKey!({ provider: p, sealed: await sealed(v, `sk-${p}-0123456789abcdef`) });
      await h.setProviderKey!({ provider: p, sealed: await sealed(v, `sk-${p}-0123456789abcdef`) });
    }
    expect(((await h.getOnboarding!({})) as Onb).provider).toBe("mistral");
    const r = (await h.getSafetyReviewer!({})) as SafetyReviewerView;
    expect(r).toMatchObject({ ref: "mistral:mistral-small-latest", onClaude: false, qualified: false, state: "not-checked" });
    const cat = (await h.getModelCatalog!({})) as ModelCatalogView;
    expect(cat.groups.some((g) => g.provider === "anthropic")).toBe(false); // no Claude models without a key
    const row = cat.groups.find((g) => g.provider === "openai")!.models.find((m) => m.ref === "openai:gpt-6.1-sol")!;
    expect(row.whatWorks).toEqual(expect.arrayContaining([{ label: "Coding agents", state: "needs-key" }, { label: "Computer helpers", state: "needs-key" }, { label: "Auto-review", state: "asks" }]));
  });

  it("OpenRouter alone: host-level work has a model from the first minute (its auto router), with no Bot on it yet", async () => {
    const { h, v } = await host();
    await consent(h, v, "openrouter");
    await h.testProviderKey!({ provider: "openrouter", sealed: await sealed(v, "sk-or-0123456789abcdefgh") });
    await h.setProviderKey!({ provider: "openrouter", sealed: await sealed(v, "sk-or-0123456789abcdefgh") });
    expect(await h.getSafetyReviewer!({})).toMatchObject({ ref: "openrouter:openrouter/auto", onClaude: false });
  });
});

describe("any-key setup: the Anthropic path is unchanged", () => {
  it("an Anthropic key finishes setup, new Bots keep Claude's default, host-level work stays on Claude", async () => {
    const { h, v: pv, onb } = await host();
    const v0 = (await h.getAuth!({})) as { boxPublicKey: string };
    await h.setApiKey!({ sealed: await sealTo(v0.boxPublicKey, ANTHROPIC_KEY) });
    expect(credentialsReady()).toBe(true);
    expect(await onb()).toEqual({ hasSeenOnboarding: false, tokenConfigured: true, anthropicKey: true, provider: null, newBotModel: null });
    // Even with a provider set up too, a new Bot keeps Claude's default and the reviewer stays on Claude.
    await consent(h, pv, "openai");
    await h.testProviderKey!({ provider: "openai", sealed: await sealed(pv, "sk-openai-0123456789abcdef") });
    await h.setProviderKey!({ provider: "openai", sealed: await sealed(pv, "sk-openai-0123456789abcdef") });
    const { id } = (await h.createAgent!({ name: "Ada", isKickstartRequested: false })) as { id: string };
    expect(app!.services.bots.summary(id).profile.model).toBeUndefined();
    expect(await h.getSafetyReviewer!({})).toMatchObject({ onClaude: true });
    expect((await onb()).provider).toBe(null);
    await h.clearApiKey!({});
  });
});
