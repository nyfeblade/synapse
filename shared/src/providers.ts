/**
 * Multi-provider Bots (spec 2026-09-29 §5): the providers a Bot can run on besides Claude, and how a Bot's model names
 * one. A Claude Bot's model stays a plain ModelId ("claude-sonnet-5"); every other model is "<provider>:<id>"
 * ("openai:gpt-5.1", "gemini:gemini-3.5-flash", "ollama:qwen3:4b" — the id may itself hold colons).
 */
export const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "ollama", "lmstudio", "gemini", "mistral", "deepseek"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** A non-Claude model: "<provider>:<model id>". */
export type ProviderModelRef = `${Exclude<ProviderId, "anthropic">}:${string}`;

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === "string" && (PROVIDER_IDS as readonly string[]).includes(x);
}

/** A well-formed provider ref for a provider other than Anthropic (Claude models keep their plain ids). */
export function isProviderModelRef(x: unknown): x is ProviderModelRef {
  if (typeof x !== "string") return false;
  const i = x.indexOf(":");
  if (i <= 0 || i === x.length - 1) return false;
  const p = x.slice(0, i);
  return isProviderId(p) && p !== "anthropic" && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(x.slice(i + 1));
}

export function parseProviderModelRef(ref: string): { provider: Exclude<ProviderId, "anthropic">; model: string } | null {
  if (!isProviderModelRef(ref)) return null;
  const i = ref.indexOf(":");
  return { provider: ref.slice(0, i) as Exclude<ProviderId, "anthropic">, model: ref.slice(i + 1) };
}

/** Providers that run on this Mac: no key, no per-token cost. */
export function isLocalProvider(p: ProviderId): boolean {
  return p === "ollama" || p === "lmstudio";
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", ollama: "Ollama", lmstudio: "LM Studio",
  gemini: "Gemini", mistral: "Mistral", deepseek: "DeepSeek",
};
export function providerLabel(p: ProviderId): string {
  return PROVIDER_LABELS[p];
}

/** The providers offered in Settings → Account in this version (P2 providers stay off the list). */
export const OFFERED_PROVIDERS = ["openai", "openrouter", "gemini", "mistral", "deepseek", "ollama", "lmstudio"] as const satisfies readonly ProviderId[];

/** A provider key as typed: no spaces, printable, a sane length (OpenAI sk-…, OpenRouter sk-or-…, Gemini AIza…). */
export const PROVIDER_KEY_RE = /^[A-Za-z0-9_\-.:]{20,300}$/;
export function maskProviderKey(key: string): string {
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Settings → Account, one row per provider. The key never comes back, only its mask. */
export interface ProviderView {
  id: Exclude<ProviderId, "anthropic">;
  label: string;
  local: boolean;
  key: { masked: string; savedAt: number } | null;
  consented: boolean;
  /** The consent text to show before first use, and its version (a new version asks again). */
  consentText: string;
  consentVersion: number;
}
export interface ProvidersView { providers: ProviderView[]; boxPublicKey: string }
export interface ProviderTestResult { ok: boolean; kind: "ok" | "no-key" | "invalid-key" | "no-credit" | "rate-limited" | "over-budget" | "unreachable" | "no-consent" | "error"; title: string; detail: string }

type None = Record<string, never>;
type P = Exclude<ProviderId, "anthropic">;
declare module "./gateway" {
  interface GatewayCommands {
    getProviders: { args: None; result: ProvidersView };
    /** `sealed` = base64 crypto_box_seal of the key to ProvidersView.boxPublicKey; never the plaintext key. */
    setProviderKey: { args: { provider: P; sealed: string }; result: ProvidersView };
    clearProviderKey: { args: { provider: P }; result: ProvidersView };
    /** The saved key, or a sealed candidate: a free model list, then one tiny metered call. */
    testProviderKey: { args: { provider: P; sealed?: string; keyId?: string }; result: ProviderTestResult };
    /** The user agreed to version `textVersion` of the provider's consent text. */
    consentProvider: { args: { provider: P; textVersion: number }; result: ProvidersView };
  }
}

/** Spec §7a: the safety reviewer's model and whether it may decide on its own. */
export interface SafetyReviewerView {
  ref: string | null; onClaude: boolean; qualified: boolean; checkedAt: number | null; reasons: string[];
  /** Qualified (decides on its own), Ask-only (checked and failed), Not checked. */
  state?: "qualified" | "ask-only" | "not-checked";
  /** The models the reviewer can run on (ref null = the default choice). */
  choices?: { ref: string | null; label: string }[];
  /** The user's pick (null = the default). */
  chosen?: string | null;
  /** A safety check running in the background: how far it is. */
  job?: { id: string; done: number; total: number } | null;
}
declare module "./gateway" {
  interface GatewayCommands {
    getSafetyReviewer: { args: None; result: SafetyReviewerView };
    /** Runs the reviewer bench on the current reviewer model (5 runs of the full set; `sample` = that many cases once, never qualifying). */
    runSafetyCheck: { args: { sample?: number }; result: SafetyReviewerView };
    /** Stops the running safety check; nothing is recorded. */
    cancelSafetyCheck: { args: None; result: SafetyReviewerView };
  }
}

/** Spec §10–11: a model's badges in the picker, driven by what was measured (provider conformance, the coding bench). */
export type ModelBadge = "supported" | "experimental" | "blocked" | "unchecked" | "local";
export const BADGE_LABELS: Record<ModelBadge, string> = { supported: "Supported", experimental: "Experimental", blocked: "Blocked", unchecked: "Not checked", local: "Local" };
/** One row of a model's "What works" list (spec §9). */
/** `needs-key`: it runs on Claude, and no Anthropic key is saved (any-key setup). */
export interface WhatWorks { label: string; state: "yes" | "no" | "asks" | "experimental" | "unchecked" | "needs-key" }
export interface ModelChoice {
  ref: string; label: string; badges: ModelBadge[]; whatWorks: WhatWorks[]; contextWindow: number;
  /** Dollars per million tokens, when known (the catalog, or the provider's live list). Local models have none. */
  price?: { input: number; output: number };
  /** Listed only because the provider's live list has it (no Bot uses it yet): the Composer's short menu leaves it out. */
  liveOnly?: true;
}
/** "acp": the vendor coding CLIs (Wave 3), grouped apart from the model providers. */
export interface ModelGroup {
  provider: ProviderId | "acp"; label: string; models: ModelChoice[];
  /** A long live list (OpenRouter's): the picker shows a search box for this group. */
  searchable?: true;
}
export interface ModelCatalogView { groups: ModelGroup[] }
/** Spec §10 cost preview: dollars per 100 turns like this Bot's last 30 days, on a given model. null = no turns yet. */
export interface CostPreview { model: string; usdPer100: number | null; turns: number }
export interface ConformanceView { ref: string; at: number; mustPass: boolean; results: { id: string; status: "pass" | "fail" | "skip"; detail: string }[]; badges: ModelBadge[] }
declare module "./gateway" {
  interface GatewayCommands {
    getModelCatalog: { args: None; result: ModelCatalogView };
    getCostPreview: { args: { id: string; model: string }; result: CostPreview };
    /** Provider conformance (PC-01..15) on a model; `only` runs just those checks (a tiny live sample). */
    runProviderConformance: { args: { ref: string; only?: string[] }; result: ConformanceView };
    /** The safety reviewer's model: a provider model ref, or null for the default. */
    setSafetyReviewer: { args: { ref: string | null }; result: SafetyReviewerView };
  }
}
