import { API_KEY_RE } from "./auth";
import { providerLabel, PROVIDER_KEY_RE, type ProviderId } from "./providers";

/**
 * Several keys per provider (0.1.7): each provider that takes a key (Anthropic and the hosted providers) holds a ring
 * of named keys ("Personal", "Work"). The first one added is the provider's default; the owner can make another the
 * default. A Bot pays for its model with the key it chose for that provider (BotProfile.modelKeys), else the default.
 * Keys stay sealed on the box and never reach a Bot: the proxies pick the key per call. Consent stays per provider.
 */
export const KEYED_PROVIDERS = ["anthropic", "openai", "openrouter", "gemini", "mistral", "deepseek"] as const satisfies readonly ProviderId[];
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];
export function isKeyedProvider(x: unknown): x is KeyedProvider {
  return typeof x === "string" && (KEYED_PROVIDERS as readonly string[]).includes(x);
}

/** A key's label: short, one line. */
export const KEY_LABEL_MAX = 24;
export function cleanKeyLabel(s: unknown): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, KEY_LABEL_MAX);
}
/** A key id: short, safe in a file and a health row id. */
export const KEY_ID_RE = /^k[a-z0-9]{1,16}$/;
export function isKeyId(x: unknown): x is string {
  return typeof x === "string" && KEY_ID_RE.test(x);
}
/** Whether a typed key has the provider's shape. */
export function keyLooksRight(p: KeyedProvider, key: string): boolean {
  return p === "anthropic" ? API_KEY_RE.test(key) : PROVIDER_KEY_RE.test(key);
}
/** The provider a model ref runs on ("claude-…" is Anthropic; "acp:…" and models on this Mac have no key). */
export function keyedProviderOf(ref: string | undefined | null): KeyedProvider | null {
  if (!ref) return "anthropic";
  if (ref.startsWith("acp:")) return null;
  const i = ref.indexOf(":");
  if (i < 0) return "anthropic";
  const p = ref.slice(0, i);
  return isKeyedProvider(p) ? p : null;
}

/** A health row's name for one key: the provider's alone while it has one key, the key's label beside it when more. */
export function keyHealthName(p: KeyedProvider, label: string, several: boolean): string {
  const base = p === "anthropic" ? "Anthropic API key" : `${providerLabel(p)} API key`;
  return several ? `${base} · ${label}` : base;
}

/** One saved key, as Settings shows it. The key itself never comes back, only its mask. */
export interface KeyView {
  id: string;
  label: string;
  masked: string;
  savedAt: number;
  isDefault: boolean;
  /** What the last call with it said: null = no call yet. */
  health: "ok" | "rejected" | "no-credit" | null;
  /** This calendar month so far, recorded per key. */
  monthUsd: number;
  monthRuns: number;
  /** A monthly cap on this key; null = none (the account's budgets still apply). */
  capUsd: number | null;
}
export interface KeyRingView { provider: KeyedProvider; label: string; keys: KeyView[] }
export interface KeysView { boxPublicKey: string; rings: KeyRingView[] }
/** The picker's view of a provider's keys: labels only. */
export interface KeyChoice { id: string; label: string; isDefault: boolean }
/** A model recently used, with the key that paid for it (null = the provider's default, or none). */
export interface RecentModel { ref: string; keyId: string | null; at: number; mine: boolean }
export interface ModelPicksView {
  /** Per provider with keys: the keys, default first. */
  keys: Partial<Record<KeyedProvider, KeyChoice[]>>;
  /** This Bot's recent models first, then the others', newest first. */
  recent: RecentModel[];
  /** The models Bots use now, with their key. */
  inUse: { ref: string; keyId: string | null }[];
  /** The model a new Bot gets unless the owner picks another (creating a Bot; `botId` ""). */
  newBotModel?: string;
}

export const STR_KEYS = {
  addKey: "Add key",
  label: "Label",
  labelPlaceholder: "Personal",
  rename: "Rename",
  test: "Test",
  testing: "Testing…",
  makeDefault: "Make default",
  remove: "Remove",
  save: "Save",
  cancel: "Cancel",
  isDefault: "Default",
  noKeys: "No key",
  rejected: "Rejected",
  noCredit: "No credit",
  cap: "Monthly cap",
  capNone: "No cap",
  capReached: (label: string) => `This key's monthly cap is reached (${label}).`,
  noKeyForModelTitle: "No key for this model",
  noKeyForModel: (p: ProviderId) => `There's no ${providerLabel(p)} key saved. Add one in Settings → Account.`,
  fellBackTitle: "Key removed",
  fellBack: (bot: string, label: string) => `${bot} now uses ${label}.`,
  usage: (usd: number, runs: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)} · ${runs} ${runs === 1 ? "run" : "runs"}`,
  /** The picker. */
  searchModels: "Search models",
  recent: "Recent",
  inUse: "In use",
  allModels: "All models…",
  noMatches: "No matches",
  engine: "Engine",
  model: "Model",
  key: "Key",
} as const;

type None = Record<string, never>;
declare module "./gateway" {
  interface GatewayCommands {
    getKeys: { args: None; result: KeysView };
    /** `sealed` = base64 crypto_box_seal of the key to KeysView.boxPublicKey. The first key of a provider is its default. */
    addKey: { args: { provider: KeyedProvider; sealed: string; label?: string }; result: KeysView };
    renameKey: { args: { provider: KeyedProvider; keyId: string; label: string }; result: KeysView };
    setDefaultKey: { args: { provider: KeyedProvider; keyId: string }; result: KeysView };
    /** Bots that paid with it fall back to the provider's default key (a quiet notice); with none left they say so. */
    removeKey: { args: { provider: KeyedProvider; keyId: string }; result: KeysView };
    setKeyCap: { args: { provider: KeyedProvider; keyId: string; capUsd: number | null }; result: KeysView };
    /** One saved key: the free model list, then one tiny metered call. */
    testKey: { args: { provider: KeyedProvider; keyId: string }; result: { ok: boolean; kind: string; title: string; detail: string } };
    /** The picker's data for one Bot: keys by provider, recent models, models in use. */
    getModelPicks: { args: { botId: string }; result: ModelPicksView };
    /** Pick a model and the key that pays for it (null = the provider's default) in one step. */
    pickAgentModel: { args: { id: string; model: string; keyId?: string | null }; result: { agent: import("./bots").BotSummary } };
  }
}
