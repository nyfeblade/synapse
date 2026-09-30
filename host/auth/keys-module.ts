import {
  DEFAULT_BOT_MODEL, KEYED_PROVIDERS, STR_AUTH, STR_KEYS, isKeyedProvider, keyedProviderOf, keyHealthName, keyLooksRight, providerLabel,
  type BotSummary, type KeyedProvider, type KeysView, type KeyView, type ModelPicksView, type ProviderId, type ProviderTestResult, type RecentModel,
} from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { openSealed, type BoxKeyPair } from "../secrets/crypto";
import type { AuthStore } from "./auth-store";
import type { RingKey } from "./key-ring";
import type { ProviderConsentStore } from "./provider-consent";
import type { ProviderKeyStore } from "./provider-keys";
import { testAnthropicConnection } from "./test-connection";

/**
 * Several keys per provider (0.1.7): which key pays for each call, per-key spend and caps, health rows, and Settings →
 * Account's commands. Keys stay in their stores (auth-store.ts, provider-keys.ts); this only ever hands a key to the two
 * proxies' credential lookups (app.ts) and to a key test in this process. Everything that leaves carries masks.
 *
 * Which key: the Bot's chosen key for the provider (BotProfile.modelKeys) while it's saved, else the provider's default.
 * Host-level calls (no Bot) use the default. A key that is removed moves the Bots that paid with it to the default,
 * with a quiet notice; with no key left they say "No key for this model".
 */
type P = Exclude<ProviderId, "anthropic">;
const RECENT_DAYS = 14;

export interface KeyServicesDeps {
  auth: AuthStore;
  providers: ProviderKeyStore;
  consent: Pick<ProviderConsentStore, "consented">;
  bots: { has(id: string): boolean; ids(): string[]; summary(id: string): BotSummary; setModelKey(id: string, p: KeyedProvider, keyId: string | null): BotSummary; update(id: string, patch: { model?: never }): BotSummary };
  keyPair(): Promise<BoxKeyPair>;
  now(): number;
  /** The first moment of this calendar month (the owner's time zone). */
  monthStart(): number;
  usage(): { keySpend(keyRef: string, since: number): { usd: number; runs: number }; recentModels(since: number, limit?: number): { botId: string; model: string; keyRef: string | null; at: number }[] } | null;
  /** A health row's state (connector-health.ts), for the key's line in Settings. */
  healthState(id: string): string | null;
  /** A saved key's health signal: an HTTP status, or null (saved anew or removed: its row goes). */
  keyHealth(p: KeyedProvider, keyId: string, status: number | null): void;
  notice(botId: string, title: string, detail: string, dedupeKey: string): void;
  nameOf(botId: string): string;
  /** A provider's keys changed (the proxy drops its live tokens; warm Bots pick it up). */
  onKeyChange(p: KeyedProvider): void;
  /** A hosted provider's key was added (any-key setup counts it). */
  onKeySaved?(p: P, key: string): void;
  /** A hosted provider's saved key, tested by id (provider-module.ts testProviderKey). */
  testProvider(p: P, keyId: string): Promise<ProviderTestResult>;
  /** The model a new Bot gets (any-key setup: the account provider's; null = Claude's default). */
  newBotModel?(): string | null;
  /** FUZZ / fake brain: the Anthropic test answers offline (a key with "wrong" in it is rejected). */
  fake?: boolean;
  anthropicBaseUrl?: string;
}

export function keyRefOf(p: KeyedProvider, keyId: string): string { return `${p}/${keyId}`; }

export function createKeyServices(d: KeyServicesDeps) {
  const list = (p: KeyedProvider): RingKey[] => (p === "anthropic" ? d.auth.list() : d.providers.list(p));
  const entry = (p: KeyedProvider, id: string): RingKey | null => (p === "anthropic" ? d.auth.entry(id) : d.providers.entry(p, id));
  const keyOf = (p: KeyedProvider, id: string | null): string | null => (p === "anthropic" ? d.auth.key(id) : d.providers.key(p, id));
  const resolve = (p: KeyedProvider, want: string | null | undefined): string | null => (p === "anthropic" ? d.auth.resolve(want) : d.providers.resolve(p, want));
  const wanted = (botId: string | null | undefined, p: KeyedProvider): string | null => {
    if (!botId || !d.bots.has(botId)) return null;
    return d.bots.summary(botId).profile.modelKeys?.[p] ?? null;
  };
  /** The key id a call for this Bot on this provider pays with (null: no key saved). */
  const keyIdFor = (botId: string | null | undefined, p: ProviderId): string | null => (isKeyedProvider(p) ? resolve(p, wanted(botId, p)) : null);
  const spend = (p: KeyedProvider, id: string) => d.usage()?.keySpend(keyRefOf(p, id), d.monthStart()) ?? { usd: 0, runs: 0 };

  const healthOf = (p: KeyedProvider, id: string): KeyView["health"] => {
    const s = d.healthState(`provider:${p}:${id}`);
    return s === "ok" ? "ok" : s === "needs-sign-in" ? "rejected" : s === "broken" ? "no-credit" : null;
  };
  const view = async (): Promise<KeysView> => ({
    boxPublicKey: (await d.keyPair()).publicKey,
    rings: KEYED_PROVIDERS.map((p) => ({
      provider: p, label: providerLabel(p),
      keys: list(p).map((k) => {
        const s = spend(p, k.id);
        const m = p === "anthropic" ? d.auth.masked(k.id) : d.providers.masked(p, k.id);
        return { id: k.id, label: k.label, masked: m?.masked ?? "", savedAt: k.savedAt, isDefault: k.isDefault, health: healthOf(p, k.id), monthUsd: s.usd, monthRuns: s.runs, capUsd: k.capUsd };
      }),
    })),
  });
  const needP = (x: unknown): KeyedProvider => {
    if (!isKeyedProvider(x)) throw new GatewayError("BAD_PROVIDER", "Unknown provider.");
    return x;
  };
  const needKey = (p: KeyedProvider, id: unknown): string => {
    if (typeof id !== "string" || !entry(p, id)) throw new GatewayError("NO_KEY", "That key isn't saved.", 404);
    return id;
  };
  const unseal = async (sealed: unknown): Promise<string> => {
    if (typeof sealed !== "string" || !sealed) throw new GatewayError("BAD_ARGS", "That doesn't look like a key.");
    try { return (await openSealed(sealed, await d.keyPair())).trim(); } catch { throw new GatewayError("BAD_SEALED", "The key couldn't be opened on the computer. Enter it again."); }
  };
  const changed = (p: KeyedProvider) => { try { d.onKeyChange(p); } catch { /* the proxies catch up on the next call */ } };

  /** The Bots whose model runs on `p` and whose calls pay with `keyId` now. */
  const payingWith = (p: KeyedProvider, keyId: string): string[] =>
    d.bots.ids().filter((b) => { const s = d.bots.summary(b); return !s.group && keyedProviderOf(s.profile.model ?? DEFAULT_BOT_MODEL) === p && keyIdFor(b, p) === keyId; });

  const handlers: CommandHandlers = {
    getKeys: () => view(),
    addKey: async ({ provider, sealed, label }) => {
      const p = needP(provider);
      // Spec §4: nothing about a provider is set up before its consent (Anthropic needs none).
      if (p !== "anthropic" && !d.consent.consented(p)) throw new GatewayError("NO_CONSENT", `${providerLabel(p)} hasn't been allowed yet. Allow it in Settings → Account.`);
      const key = await unseal(sealed);
      if (!keyLooksRight(p, key)) throw new GatewayError("BAD_API_KEY", p === "anthropic" ? STR_AUTH.badKeyFormat : "That doesn't look like a key.");
      const name = typeof label === "string" && label.trim() ? label : list(p).length ? `${providerLabel(p)} ${list(p).length + 1}` : providerLabel(p);
      const id = p === "anthropic" ? d.auth.add(key, name) : d.providers.add(p, key, name);
      if (p !== "anthropic") d.onKeySaved?.(p, key);
      d.keyHealth(p, id, null);
      changed(p);
      return view();
    },
    renameKey: async ({ provider, keyId, label }) => {
      const p = needP(provider);
      const id = needKey(p, keyId);
      if (p === "anthropic") d.auth.rename(id, String(label ?? "")); else d.providers.rename(p, id, String(label ?? ""));
      return view();
    },
    setDefaultKey: async ({ provider, keyId }) => {
      const p = needP(provider);
      const id = needKey(p, keyId);
      if (p === "anthropic") d.auth.setDefault(id); else d.providers.setDefault(p, id);
      changed(p);
      return view();
    },
    setKeyCap: async ({ provider, keyId, capUsd }) => {
      const p = needP(provider);
      const id = needKey(p, keyId);
      const cap = capUsd === null || capUsd === undefined ? null : Number(capUsd);
      if (p === "anthropic") d.auth.setCap(id, cap); else d.providers.setCap(p, id, cap);
      return view();
    },
    removeKey: async ({ provider, keyId }) => {
      const p = needP(provider);
      const id = needKey(p, keyId);
      const users = payingWith(p, id);
      if (p === "anthropic") d.auth.remove(id); else d.providers.remove(p, id);
      d.keyHealth(p, id, null);
      const next = resolve(p, null);
      const nextLabel = next ? entry(p, next)?.label ?? providerLabel(p) : null;
      for (const b of d.bots.ids()) if (wanted(b, p) === id) d.bots.setModelKey(b, p, null);
      for (const b of users) {
        // A quiet notice: the Bot keeps working on the default key, or says plainly that its model has no key now.
        if (nextLabel) d.notice(b, STR_KEYS.fellBackTitle, STR_KEYS.fellBack(d.nameOf(b), nextLabel), `key-fallback:${b}:${p}`);
        else d.notice(b, STR_KEYS.noKeyForModelTitle, STR_KEYS.noKeyForModel(p), `key-none:${b}:${p}`);
      }
      changed(p);
      return view();
    },
    testKey: async ({ provider, keyId }) => {
      const p = needP(provider);
      const id = needKey(p, keyId);
      if (p !== "anthropic") {
        const r = await d.testProvider(p, id);
        return { ok: r.ok, kind: r.kind, title: r.title, detail: r.detail };
      }
      const key = d.auth.key(id)!;
      const r = d.fake
        ? (/wrong/i.test(key) ? { ok: false, kind: "invalid-key", status: 401, title: STR_AUTH.keyRejected, detail: STR_AUTH.keyRejectedDetail } : { ok: true, kind: "ok", status: 200, title: STR_AUTH.ok, detail: "" })
        : await testAnthropicConnection(key, d.anthropicBaseUrl ? { baseUrl: d.anthropicBaseUrl } : {});
      if (typeof r.status === "number") d.keyHealth("anthropic", id, r.status);
      return { ok: r.ok, kind: r.kind, title: r.title, detail: r.detail };
    },
    getModelPicks: async ({ botId }): Promise<ModelPicksView> => {
      const me = String(botId ?? "");
      const keys: ModelPicksView["keys"] = {};
      for (const p of KEYED_PROVIDERS) {
        if (p !== "anthropic" && !d.consent.consented(p)) continue;
        const ks = list(p);
        if (ks.length) keys[p] = ks.map((k) => ({ id: k.id, label: k.label, isDefault: k.isDefault }));
      }
      const rows = d.usage()?.recentModels(d.now() - RECENT_DAYS * 86_400_000, 60) ?? [];
      const keyIdOfRef = (ref: string | null): string | null => {
        if (!ref) return null;
        const i = ref.indexOf("/");
        const p = ref.slice(0, i);
        return isKeyedProvider(p) && entry(p, ref.slice(i + 1)) ? ref.slice(i + 1) : null;
      };
      const seen = new Set<string>();
      const recent: RecentModel[] = [];
      for (const mine of [true, false]) {
        for (const r of rows) {
          if ((r.botId === me) !== mine) continue;
          const keyId = keyIdOfRef(r.keyRef);
          const k = `${r.model}\u0000${keyId ?? ""}`;
          if (seen.has(k)) continue;
          seen.add(k);
          recent.push({ ref: r.model, keyId, at: r.at, mine });
        }
      }
      const inUse = d.bots.ids().filter((b) => !d.bots.summary(b).group).map((b) => {
        const ref = d.bots.summary(b).profile.model ?? DEFAULT_BOT_MODEL;
        const p = keyedProviderOf(ref);
        return { ref, keyId: p ? wanted(b, p) : null };
      });
      return { keys, recent: recent.slice(0, 8), inUse, newBotModel: d.newBotModel?.() ?? DEFAULT_BOT_MODEL };
    },
    pickAgentModel: async ({ id, model, keyId }) => {
      const botId = String(id ?? "");
      const ref = String(model ?? "");
      const p = keyedProviderOf(ref);
      if (keyId !== undefined && keyId !== null && (!p || !entry(p, String(keyId)))) throw new GatewayError("NO_KEY", "That key isn't saved.", 404);
      let agent = d.bots.summary(botId);
      if ((agent.profile.model ?? DEFAULT_BOT_MODEL) !== ref) agent = d.bots.update(botId, { model: ref as never });
      if (p && keyId !== undefined) agent = d.bots.setModelKey(botId, p, keyId === null ? null : String(keyId));
      return { agent };
    },
  };

  return {
    handlers,
    keyIdFor,
    /** The Anthropic key proxy's credential: the key this Bot pays with. */
    anthropicCredential: (botId?: string | null): string | null => keyOf("anthropic", keyIdFor(botId, "anthropic")),
    /** The provider proxy's credential. */
    providerCredential: (p: P, botId?: string | null): string | null => (isKeyedProvider(p) ? keyOf(p, keyIdFor(botId, p)) : null),
    /** A key's monthly cap, asked before each model call with the budget. */
    allowKey: (botId: string | null, p: ProviderId): { ok: boolean; message: string | null } => {
      if (!isKeyedProvider(p)) return { ok: true, message: null };
      const id = keyIdFor(botId, p);
      const e = id ? entry(p, id) : null;
      if (!e?.capUsd) return { ok: true, message: null };
      return spend(p, e.id).usd >= e.capUsd ? { ok: false, message: STR_KEYS.capReached(e.label) } : { ok: true, message: null };
    },
    /** usage.db's key column: the key a run on `model` for this Bot paid with. */
    usageKeyRef: (botId: string, model: string): string | null => {
      const p = keyedProviderOf(model);
      const id = p ? keyIdFor(botId, p) : null;
      return p && id ? keyRefOf(p, id) : null;
    },
    /** One key's health row: id and name (the key's label beside the provider's while it has more than one). */
    keyRow: (p: ProviderId, keyId?: string | null): { id: string; name: string } | null => {
      if (!isKeyedProvider(p)) return { id: `provider:${p}`, name: `${providerLabel(p)} API key` };
      const id = keyId ?? resolve(p, null);
      const e = id ? entry(p, id) : null;
      return id && e ? { id: `provider:${p}:${id}`, name: keyHealthName(p, e.label, list(p).length > 1) } : null;
    },
  };
}
export type KeyServices = ReturnType<typeof createKeyServices>;
