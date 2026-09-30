import { isLocalProvider, parseProviderModelRef, type ProviderId, type ProviderModelRef } from "./providers";

/**
 * The model catalog (spec 2026-09-29 §5). Prices are list prices in US dollars per million tokens, copied from the
 * vendors' own pricing pages on `verifiedAt` (a test warns once a row is 90 days old). OpenRouter's prices come live
 * from its /models list and its `usage.cost` is authoritative; local models cost $0.
 *
 * Sources (2026-09-30): developers.openai.com/api/docs/pricing and /docs/models; ai.google.dev/gemini-api/docs/pricing
 * and /docs/models/<id>.
 */
export interface TokenPrice { input: number; cachedInput: number; output: number }
export interface ModelRow {
  ref: ProviderModelRef;
  label: string;
  contextWindow: number;
  maxOutput: number;
  usdPerMTok: TokenPrice;
  /** A higher rate for a prompt longer than `aboveTokens` (OpenAI long context, Gemini Pro > 200k). */
  longContext?: { aboveTokens: number } & TokenPrice;
  /** A dated price change the vendor has announced (Gemini 3.x Flash introductory prices end). */
  priceFrom?: { date: string } & TokenPrice;
  vision: boolean;
  reasoning: boolean;
  status: "supported" | "experimental";
  verifiedAt: string;
}
export interface ProviderRow {
  id: Exclude<ProviderId, "anthropic">;
  /** The provider's small, fast tier (helpers, the key check). */
  helperModel: string | null;
  /**
   * Any-key setup: the model a new Bot gets when this provider is the account's (setup chose it and there is no
   * Anthropic key). null = none fixed (a model on this Mac: the first one it lists).
   */
  mainModel: string | null;
  /** When a model isn't in the catalog: this context window. */
  defaultContextWindow: number;
}

const V = "2026-09-30";
const OPENAI_CTX = 1_050_000;
const GEMINI_CTX = 1_048_576;

export const MODEL_CATALOG: readonly ModelRow[] = [
  { ref: "openai:gpt-6-astra", label: "GPT-6 Astra", contextWindow: OPENAI_CTX, maxOutput: 128_000, usdPerMTok: { input: 10, cachedInput: 1, output: 50 }, longContext: { aboveTokens: 272_000, input: 20, cachedInput: 2, output: 75 }, vision: true, reasoning: true, status: "supported", verifiedAt: V },
  { ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", contextWindow: OPENAI_CTX, maxOutput: 128_000, usdPerMTok: { input: 2, cachedInput: 0.1, output: 10 }, longContext: { aboveTokens: 272_000, input: 4, cachedInput: 0.2, output: 15 }, vision: true, reasoning: true, status: "supported", verifiedAt: V },
  { ref: "openai:gpt-6-luna", label: "GPT-6 Luna", contextWindow: OPENAI_CTX, maxOutput: 128_000, usdPerMTok: { input: 0.1, cachedInput: 0.01, output: 0.5 }, longContext: { aboveTokens: 272_000, input: 0.2, cachedInput: 0.02, output: 0.75 }, vision: true, reasoning: true, status: "supported", verifiedAt: V },
  { ref: "gemini:gemini-3.8-flash", label: "Gemini 3.8 Flash", contextWindow: GEMINI_CTX, maxOutput: 65_536, usdPerMTok: { input: 0.75, cachedInput: 0.075, output: 3.75 }, priceFrom: { date: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 }, vision: true, reasoning: true, status: "experimental", verifiedAt: V },
  { ref: "gemini:gemini-3.5-flash", label: "Gemini 3.5 Flash", contextWindow: GEMINI_CTX, maxOutput: 65_536, usdPerMTok: { input: 1.5, cachedInput: 0.15, output: 9 }, vision: true, reasoning: true, status: "experimental", verifiedAt: V },
  { ref: "gemini:gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", contextWindow: GEMINI_CTX, maxOutput: 65_536, usdPerMTok: { input: 0.3, cachedInput: 0.03, output: 2.5 }, vision: true, reasoning: true, status: "experimental", verifiedAt: V },
  // Mistral (mistral.ai/pricing/api, 2026-09-30): no separate cached-input price is published, so cached = input.
  // Context windows aren't on the public pages today: 128k assumed, the size Mistral has used for years (rulings 59).
  { ref: "mistral:mistral-medium-latest", label: "Mistral Medium 3.5", contextWindow: 128_000, maxOutput: 32_000, usdPerMTok: { input: 1.5, cachedInput: 1.5, output: 7.5 }, vision: true, reasoning: false, status: "experimental", verifiedAt: V },
  { ref: "mistral:mistral-large-latest", label: "Mistral Large 3", contextWindow: 128_000, maxOutput: 32_000, usdPerMTok: { input: 0.5, cachedInput: 0.5, output: 1.5 }, vision: true, reasoning: false, status: "experimental", verifiedAt: V },
  { ref: "mistral:mistral-small-latest", label: "Mistral Small 4", contextWindow: 128_000, maxOutput: 32_000, usdPerMTok: { input: 0.15, cachedInput: 0.15, output: 0.6 }, vision: false, reasoning: true, status: "experimental", verifiedAt: V },
  // DeepSeek (api-docs.deepseek.com/quick_start/pricing, 2026-09-30): the PEAK rate (off-peak is half), so spend is
  // never under-counted; 1M context, up to 384K output. No image input.
  { ref: "deepseek:deepseek-flash", label: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, maxOutput: 384_000, usdPerMTok: { input: 0.3, cachedInput: 0.006, output: 1.2 }, vision: false, reasoning: false, status: "experimental", verifiedAt: V },
  { ref: "deepseek:deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxOutput: 384_000, usdPerMTok: { input: 1.32, cachedInput: 0.044, output: 3.96 }, vision: false, reasoning: true, status: "experimental", verifiedAt: V },
];

export const PROVIDER_CATALOG: Readonly<Record<Exclude<ProviderId, "anthropic">, ProviderRow>> = {
  openai: { id: "openai", helperModel: "gpt-6-luna", mainModel: "gpt-6.1-sol", defaultContextWindow: 128_000 },
  openrouter: { id: "openrouter", helperModel: null, mainModel: "openrouter/auto", defaultContextWindow: 128_000 },
  gemini: { id: "gemini", helperModel: "gemini-3.5-flash-lite", mainModel: "gemini-3.5-flash", defaultContextWindow: GEMINI_CTX },
  // Phase 0: Ollama's default context was 32,768 on a 32 GB Mac (it depends on memory); LM Studio's is per model.
  ollama: { id: "ollama", helperModel: null, mainModel: null, defaultContextWindow: 32_768 },
  lmstudio: { id: "lmstudio", helperModel: null, mainModel: null, defaultContextWindow: 32_768 },
  mistral: { id: "mistral", helperModel: "mistral-small-latest", mainModel: "mistral-medium-latest", defaultContextWindow: 128_000 },
  deepseek: { id: "deepseek", helperModel: "deepseek-flash", mainModel: "deepseek-flash", defaultContextWindow: 1_000_000 },
};

/**
 * Any-key setup: the model a new Bot gets on provider `p` — the catalog's main model, or for a model on this Mac the
 * first one it lists (`localModels`, in its own order); null when there is none.
 */
export function newBotModelFor(p: Exclude<ProviderId, "anthropic">, localModels: readonly string[] = []): ProviderModelRef | null {
  const m = PROVIDER_CATALOG[p].mainModel ?? (isLocalProvider(p) ? localModels[0] ?? null : null);
  return m ? (`${p}:${m}` as ProviderModelRef) : null;
}

/** The highest catalog rate: what a model the catalog doesn't know is priced at, so spend is never under-counted. */
export const HIGHEST_PROVIDER_PRICE: TokenPrice = MODEL_CATALOG.reduce<TokenPrice>((m, r) => {
  const all = [r.usdPerMTok, ...(r.longContext ? [r.longContext] : []), ...(r.priceFrom ? [r.priceFrom] : [])];
  for (const p of all) m = { input: Math.max(m.input, p.input), cachedInput: Math.max(m.cachedInput, p.cachedInput), output: Math.max(m.output, p.output) };
  return m;
}, { input: 0, cachedInput: 0, output: 0 });

export function catalogModel(ref: string): ModelRow | undefined {
  return MODEL_CATALOG.find((r) => r.ref === ref);
}

/** Live prices a provider publishes (OpenRouter's /models), in $ per million tokens; set by the host, cached a day. */
export type LivePrices = ReadonlyMap<string, TokenPrice & { contextWindow?: number; name?: string; tools?: boolean }>;
let live: LivePrices = new Map();
export function setLiveProviderPrices(p: LivePrices): void { live = p; }
/** One model from a provider's live list (OpenRouter's /models): the picker lists these. */
export interface LiveModel { ref: string; name: string | null; price: TokenPrice; tools: boolean | null }
/** The provider's live models, in the provider's own order (empty until the daily list has been read). */
export function liveProviderModels(provider: string): LiveModel[] {
  const out: LiveModel[] = [];
  for (const [ref, v] of live) {
    if (!ref.startsWith(`${provider}:`)) continue;
    out.push({ ref, name: v.name ?? null, price: { input: v.input, cachedInput: v.cachedInput, output: v.output }, tools: v.tools ?? null });
  }
  return out;
}

/**
 * The price for one call of `ref` with a prompt of `promptTokens`, on `day` (YYYY-MM-DD). Order: local → $0; the
 * catalog (long-context tier, dated change); live prices; else the highest catalog rate.
 */
export function providerPrice(ref: string, promptTokens = 0, day: string = new Date().toISOString().slice(0, 10)): TokenPrice & { known: boolean } {
  const p = parseProviderModelRef(ref);
  if (p && isLocalProvider(p.provider)) return { input: 0, cachedInput: 0, output: 0, known: true };
  const row = catalogModel(ref);
  if (row) {
    const base = row.priceFrom && day >= row.priceFrom.date ? row.priceFrom : row.usdPerMTok;
    const long = row.longContext && promptTokens > row.longContext.aboveTokens ? row.longContext : null;
    const use = long ?? base;
    return { input: use.input, cachedInput: use.cachedInput, output: use.output, known: true };
  }
  const l = live.get(ref);
  if (l) return { input: l.input, cachedInput: l.cachedInput, output: l.output, known: true };
  return { ...HIGHEST_PROVIDER_PRICE, known: false };
}

/** A provider model's context window: the catalog, live data, then the provider's default. */
export function providerContextWindow(ref: string): number {
  const row = catalogModel(ref);
  if (row) return row.contextWindow;
  const l = live.get(ref)?.contextWindow;
  if (l) return l;
  const p = parseProviderModelRef(ref);
  return p ? PROVIDER_CATALOG[p.provider].defaultContextWindow : 200_000;
}
