import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newBotModelFor, type ProviderId } from "@synapse/shared";
import { HelperRouter } from "../../helper-model/router";
import { ProviderSetupStore } from "../../auth/provider-setup";

/** Any-key setup: with no Anthropic key, work not tied to a Bot runs on the provider setup chose. */
type P = Exclude<ProviderId, "anthropic">;
const router = (o: { anthropic?: boolean; usable: P[]; preferred?: P | null; local?: string[]; bots?: string[] }) => new HelperRouter({
  botModel: () => undefined, anthropicReady: () => o.anthropic ?? false,
  consented: (p) => p === "anthropic" || o.usable.includes(p as P), hasKey: (p) => o.usable.includes(p as P),
  botModels: () => o.bots ?? [], preferred: () => o.preferred ?? null, fallbackModel: (p) => newBotModelFor(p, o.local ?? []),
});

describe("the account helper without an Anthropic key", () => {
  it("runs on the provider setup chose, ahead of the default order", () => {
    expect(router({ usable: ["openai", "deepseek"], preferred: "deepseek" }).account()).toEqual({ kind: "provider", ref: "deepseek:deepseek-flash" });
    expect(router({ usable: ["openai", "deepseek"] }).account()).toEqual({ kind: "provider", ref: "openai:gpt-6-luna" });
    // The chosen provider no longer usable (its consent or key went): the default order again.
    expect(router({ usable: ["gemini"], preferred: "deepseek" }).account()).toEqual({ kind: "provider", ref: "gemini:gemini-3.5-flash-lite" });
  });

  it("a provider with no helper model lends its main model before any Bot runs on it: OpenRouter's auto router, the first local model", () => {
    expect(router({ usable: ["openrouter"], preferred: "openrouter" }).account()).toEqual({ kind: "provider", ref: "openrouter:openrouter/auto" });
    expect(router({ usable: ["ollama"], preferred: "ollama", local: ["qwen3:4b"] }).account()).toEqual({ kind: "provider", ref: "ollama:qwen3:4b" });
    // A Bot's model is still preferred over the fallback.
    expect(router({ usable: ["ollama"], local: ["qwen3:4b"], bots: ["ollama:llama4:8b"] }).account()).toEqual({ kind: "provider", ref: "ollama:llama4:8b" });
    // Nothing on this Mac yet: nothing to run on (the Claude path fails as it does with no key).
    expect(router({ usable: ["lmstudio"], preferred: "lmstudio" }).account()).toEqual({ kind: "claude" });
  });

  it("the safety reviewer defaults to the account helper; with an Anthropic key everything stays on Claude", () => {
    expect(router({ usable: ["mistral"], preferred: "mistral" }).reviewer()).toEqual({ kind: "provider", ref: "mistral:mistral-small-latest" });
    expect(router({ anthropic: true, usable: ["mistral"], preferred: "mistral" }).account()).toEqual({ kind: "claude" });
    expect(router({ anthropic: true, usable: ["mistral"], preferred: "mistral" }).reviewer()).toEqual({ kind: "claude" });
  });
});

describe("ProviderSetupStore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psetup-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  it("a key works only as saved; the first provider to work is the account's; consent withdrawn = not set up", () => {
    const consented = new Set<P>(["openai", "ollama"]);
    const saved: Partial<Record<P, number>> = { openai: 10 };
    const s = new ProviderSetupStore({ dir, consented: (p) => consented.has(p), keySavedAt: (p) => saved[p] ?? null });
    expect(s.ready()).toBe(false);
    s.noteCandidateWorked("openai", "sk-a");
    s.keySaved("openai", "sk-b"); // a different key than the one tested
    expect(s.working("openai")).toBe(false);
    s.noteCandidateWorked("openai", "sk-a");
    s.keySaved("openai", "sk-a");
    expect(s.working("openai")).toBe(true);
    s.markWorking("ollama");
    expect(s.account()).toBe("openai");
    saved.openai = 11; // replaced without a test
    expect(s.working("openai")).toBe(false);
    expect(s.account()).toBe("ollama");
    consented.delete("ollama");
    expect(s.ready()).toBe(false);
    expect(new ProviderSetupStore({ dir, consented: () => true, keySavedAt: () => 10 }).working("openai")).toBe(true); // kept on disk
  });
});
