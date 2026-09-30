import { afterEach, describe, expect, it } from "vitest";
import { contextWindow, HIGHEST_PROVIDER_PRICE, MODEL_CATALOG, PROVIDER_CATALOG, providerPrice, setLiveProviderPrices } from "@synapse/shared";
import { providerCostUsd } from "../../usage/metered-provider";
import { LivePriceRefresher, parseOpenRouterModels } from "../../usage/provider-prices";
import { startFakeChatServer } from "../brain/provider/fake-chat-server";
import { startProviderRuntime } from "../brain/provider/runtime";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { setLiveProviderPrices(new Map()); for (const c of closers.splice(0)) await c(); });
const u = (inputTokens: number, cacheReadTokens: number, outputTokens: number, promptTokens = inputTokens + cacheReadTokens) => ({ inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens, promptTokens });

describe("the model catalog (spec §5)", () => {
  it("every row names a known provider, has a sane price and window, and a verifiedAt no older than 90 days", () => {
    for (const r of MODEL_CATALOG) {
      const [p] = r.ref.split(":");
      expect(PROVIDER_CATALOG[p as keyof typeof PROVIDER_CATALOG], r.ref).toBeTruthy();
      expect(r.usdPerMTok.input).toBeGreaterThan(0);
      expect(r.usdPerMTok.cachedInput).toBeLessThanOrEqual(r.usdPerMTok.input);
      expect(r.usdPerMTok.output).toBeGreaterThanOrEqual(r.usdPerMTok.input);
      expect(r.contextWindow).toBeGreaterThan(100_000);
      const age = (Date.now() - Date.parse(r.verifiedAt)) / 86_400_000;
      // Spec §5: a warning, not a failure: prices drift and someone must re-check the vendor pages.
      if (age > 90) console.warn(`catalog: ${r.ref} prices were verified ${Math.floor(age)} days ago; re-check the vendor page`);
      expect(age).toBeGreaterThan(-2);
    }
    for (const p of Object.values(PROVIDER_CATALOG)) if (p.helperModel) expect(MODEL_CATALOG.some((r) => r.ref === `${p.id}:${p.helperModel}`)).toBe(true);
  });

  it("prices a call: cached at its own rate, the long-context tier, a dated change, $0 locally, the highest rate when unknown", () => {
    // GPT-6.1 Sol: $2 in, $0.10 cached, $10 out
    expect(providerCostUsd("openai:gpt-6.1-sol", u(100_000, 0, 0))).toBeCloseTo(0.2, 10);
    expect(providerCostUsd("openai:gpt-6.1-sol", u(20_000, 80_000, 10_000))).toBeCloseTo(0.04 + 0.008 + 0.1, 10);
    // past 272k prompt tokens: $4 / $0.20 / $15
    expect(providerCostUsd("openai:gpt-6.1-sol", u(300_000, 0, 0))).toBeCloseTo(1.2, 10);
    // Gemini 3.8 Flash: introductory until the end of 2026
    expect(providerCostUsd("gemini:gemini-3.8-flash", u(100_000, 0, 0), "2026-12-31")).toBeCloseTo(0.075, 10);
    expect(providerCostUsd("gemini:gemini-3.8-flash", u(100_000, 0, 0), "2027-01-01")).toBeCloseTo(0.15, 10);
    expect(providerCostUsd("ollama:qwen3:4b", u(5_000_000, 0, 1_000_000))).toBe(0);
    expect(providerCostUsd("lmstudio:x", u(5_000_000, 0, 1_000_000))).toBe(0);
    expect(providerPrice("openai:gpt-unknown")).toEqual({ ...HIGHEST_PROVIDER_PRICE, known: false });
    expect(HIGHEST_PROVIDER_PRICE).toEqual({ input: 20, cachedInput: 2, output: 75 });
    // OpenRouter: its usage.cost wins over any price
    expect(providerCostUsd("openrouter:anything", { ...u(1_000_000, 0, 0), costUsd: 0.0123 })).toBe(0.0123);
  });

  it("context windows for provider models: catalog, live, then the provider default", () => {
    expect(contextWindow("openai:gpt-6-luna")).toBe(1_050_000);
    expect(contextWindow("gemini:gemini-3.5-flash-lite")).toBe(1_048_576);
    expect(contextWindow("ollama:qwen3:4b")).toBe(32_768);
    expect(contextWindow("openrouter:meta/llama-x")).toBe(128_000);
    expect(contextWindow("claude-sonnet-5")).toBe(200_000);
  });
});

describe("OpenRouter live prices", () => {
  const BODY = JSON.stringify({ data: [
    { id: "meta/llama-x", context_length: 131072, pricing: { prompt: "0.0000002", completion: "0.0000008", input_cache_read: "0.00000005" } },
    { id: "free/model", pricing: { prompt: "0", completion: "0" } },
    { id: "broken", pricing: { prompt: "n/a" } },
  ] });

  it("parses $/token strings to $/MTok, with the cache rate and context", () => {
    const m = parseOpenRouterModels(BODY);
    expect(m.get("openrouter:meta/llama-x")).toEqual({ input: 0.2, cachedInput: 0.05, output: 0.8, contextWindow: 131072 });
    expect(m.get("openrouter:free/model")).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(m.has("openrouter:broken")).toBe(false);
    expect(parseOpenRouterModels("not json").size).toBe(0);
  });

  it("keeps the model's name and whether it takes tools; odd ids and control characters never reach the picker", () => {
    const m = parseOpenRouterModels(JSON.stringify({ data: [
      { id: "maker/tool-model", name: "Maker: Tool\u0007 Model", supported_parameters: ["tools", "temperature"], pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "maker/no-tools", name: "No tools", supported_parameters: ["temperature"], pricing: { prompt: "0", completion: "0" } },
      { id: "../etc/passwd", pricing: { prompt: "0", completion: "0" } },
      { id: "maker/<script>", pricing: { prompt: "0", completion: "0" } },
    ] }));
    expect(m.get("openrouter:maker/tool-model")).toMatchObject({ name: "Maker: Tool Model", tools: true, input: 1, output: 2 });
    expect(m.get("openrouter:maker/no-tools")).toMatchObject({ tools: false });
    expect([...m.keys()]).toEqual(["openrouter:maker/tool-model", "openrouter:maker/no-tools"]);
  });

  it("fetches through the proxy once a day and prices calls with it", async () => {
    const up = await startFakeChatServer(() => ({ status: 200, body: BODY }));
    closers.push(() => up.close());
    const rt = await startProviderRuntime({ upstream: up.url });
    closers.push(rt.stop);
    let now = 1_000;
    const r = new LivePriceRefresher({ ready: () => true, now: () => now });
    await r.ensure();
    await r.ensure();
    expect(up.requests.map((q) => q.path)).toEqual(["/models"]);
    expect(providerPrice("openrouter:meta/llama-x")).toMatchObject({ input: 0.2, output: 0.8, known: true });
    expect(contextWindow("openrouter:meta/llama-x")).toBe(131072);
    expect(providerCostUsd("openrouter:meta/llama-x", u(1_000_000, 0, 1_000_000))).toBeCloseTo(1, 10);
    now += 25 * 3600_000;
    await r.ensure();
    expect(up.requests).toHaveLength(2);
  });
});
