import {
  OFFERED_PROVIDERS, PROVIDER_CATALOG, PROVIDER_CONSENT_VERSION, STR_PROVIDER, STR_PROVIDER_UI, isLocalProvider, providerConsentText, providerLabel,
  type ProviderId, type ProviderTestResult, type ProvidersView,
} from "@synapse/shared";
import { ChatCompletionsAdapter } from "../brain/provider/adapters/chat-completions";
import { quirksFor } from "../brain/provider/adapters/quirks";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { openSealed, type BoxKeyPair } from "../secrets/crypto";
import { providerFetch, providerGet, ProviderCallError } from "../usage/metered-provider";
import type { ProviderConsentStore } from "./provider-consent";
import type { ProviderKeyStore } from "./provider-keys";
import type { ProviderSetupStore } from "./provider-setup";

/**
 * Settings → Account, the model providers (spec §4): save, test and remove a key, and give the one-time consent. A key
 * arrives sealed to the box public key (the Mac seals it in main, app/src/main/auth-key.ts) and is opened only here;
 * every answer carries the masked key at most. The key test's answers use the app's own words, never the upstream's
 * body, so nothing a provider echoes back can carry the key out.
 */
type P = Exclude<ProviderId, "anthropic">;
const isOffered = (p: unknown): p is P => typeof p === "string" && (OFFERED_PROVIDERS as readonly string[]).includes(p);

export function createProviderCommands(o: {
  keys: ProviderKeyStore;
  consent: ProviderConsentStore;
  keyPair(): Promise<BoxKeyPair>;
  /** A key was saved or removed: the proxy drops that provider's live tokens, warm provider Bots pick it up. */
  onKeyChange?(p: P): void;
  /** FUZZ / fake brain: the key test answers offline (a key with "wrong" in it is rejected). */
  fake?: boolean;
  /** Any-key setup: which keys worked (auth/provider-setup.ts). */
  setup?: Pick<ProviderSetupStore, "markWorking" | "forget" | "noteCandidateWorked" | "keySaved">;
  /** 0.1.7: a saved key's test answered (its health row). */
  onTested?(p: P, keyId: string, r: ProviderTestResult): void;
}): CommandHandlers {
  const view = async (): Promise<ProvidersView> => ({
    boxPublicKey: (await o.keyPair()).publicKey,
    providers: OFFERED_PROVIDERS.map((id) => ({
      id, label: providerLabel(id), local: isLocalProvider(id), key: o.keys.masked(id), consented: o.consent.consented(id),
      consentText: providerConsentText(id), consentVersion: PROVIDER_CONSENT_VERSION,
    })),
  });
  const need = (p: unknown): P => {
    if (!isOffered(p)) throw new GatewayError("BAD_PROVIDER", "Unknown provider.");
    return p;
  };
  const unseal = async (sealed: unknown): Promise<string> => {
    if (typeof sealed !== "string" || !sealed) throw new GatewayError("BAD_ARGS", STR_PROVIDER_UI.badFormat);
    try {
      return await openSealed(sealed, await o.keyPair());
    } catch {
      throw new GatewayError("BAD_SEALED", "The key couldn't be opened on the computer. Enter it again.");
    }
  };
  const result = (kind: ProviderTestResult["kind"], title: string, detail = ""): ProviderTestResult => ({ ok: kind === "ok", kind, title, detail });

  return {
    getProviders: () => view(),
    setProviderKey: async ({ provider, sealed }) => {
      const p = need(provider);
      if (isLocalProvider(p)) throw new GatewayError("BAD_PROVIDER", "A model on this Mac needs no key.");
      // Spec §4: nothing about a provider is set up before its consent.
      if (!o.consent.consented(p)) throw new GatewayError("NO_CONSENT", STR_PROVIDER.noConsent(p));
      const key = await unseal(sealed);
      o.keys.set(p, key);
      o.setup?.keySaved(p, key);
      o.onKeyChange?.(p);
      return view();
    },
    clearProviderKey: async ({ provider }) => {
      const p = need(provider);
      o.keys.clear(p);
      o.setup?.forget(p);
      o.onKeyChange?.(p);
      return view();
    },
    consentProvider: async ({ provider, textVersion }) => {
      const p = need(provider);
      if (textVersion !== PROVIDER_CONSENT_VERSION) throw new GatewayError("STALE_CONSENT", "The consent text changed. Read it again.");
      o.consent.consent(p, textVersion);
      return view();
    },
    testProviderKey: async ({ provider, sealed, keyId }): Promise<ProviderTestResult> => {
      const p = need(provider);
      const candidate = sealed ? await unseal(sealed) : undefined;
      // 0.1.7: one saved key by id (several keys per provider); it stays in this process, as the proxy's key override.
      const saved = !candidate && typeof keyId === "string" && keyId ? o.keys.key(p, keyId) : null;
      if (!candidate && keyId && !saved) throw new GatewayError("NO_KEY", "That key isn't saved.", 404);
      const r = await test(p, candidate ?? saved ?? undefined);
      const isDefault = !keyId || keyId === o.keys.defaultId(p);
      // Any-key setup: a key (or the app on this Mac) that answered counts toward finishing setup.
      if (r.ok) { if (candidate) o.setup?.noteCandidateWorked(p, candidate); else o.setup?.markWorking(p); }
      else if (!candidate && isDefault && r.kind === "invalid-key") o.setup?.forget(p);
      const kid = candidate ? null : keyId || o.keys.defaultId(p);
      if (kid) { try { o.onTested?.(p, kid, r); } catch { /* health is advisory */ } }
      return r;
    },
  };

  async function test(p: P, candidate: string | undefined): Promise<ProviderTestResult> {
    if (!o.consent.consented(p)) return result("no-consent", STR_PROVIDER.noConsentTitle, STR_PROVIDER.noConsent(p));
    const local = quirksFor(p).authHeader === "none";
    if (!local && !candidate && !o.keys.has(p)) return result("no-key", STR_PROVIDER.noKeyTitle, STR_PROVIDER.noKey(p));
    if (o.fake) return /wrong/i.test(candidate ?? o.keys.key(p) ?? "") ? result("invalid-key", STR_PROVIDER.keyRejectedTitle, STR_PROVIDER.keyRejected(p)) : result("ok", STR_PROVIDER_UI.keyOk);
    // 1. The free model list.
    let status = 0;
    try { status = (await providerGet(p, "models", candidate ? { keyOverride: candidate } : {})).status; } catch { status = 0; }
    const bad = statusResult(p, status);
    if (bad) return bad;
    // 2. One tiny metered call on the provider's helper model (spec §4 Test key), when it has one.
    const helper = PROVIDER_CATALOG[p].helperModel;
    if (!helper) return result("ok", STR_PROVIDER_UI.keyOk);
    const adapter = new ChatCompletionsAdapter(p);
    const body = adapter.encode({ model: helper, system: "Reply with OK.", messages: [{ role: "user", parts: [{ type: "text", text: "OK?" }] }], tools: [], wireName: (n) => n, maxOutputTokens: 8 });
    try {
      const s = await providerFetch({ purpose: "key-check", botId: null }, adapter, { ref: `${p}:${helper}`, body, signal: AbortSignal.timeout(60_000), ...(candidate ? { keyOverride: candidate } : {}) });
      for await (const _ of s.chunks) { /* drain: the call is metered when it ends */ }
      return result("ok", STR_PROVIDER_UI.keyOk);
    } catch (e) {
      if (e instanceof ProviderCallError) {
        if (e.cls.trayTitle === STR_PROVIDER.overBudgetTitle) return result("over-budget", STR_PROVIDER.overBudgetTitle, STR_PROVIDER.overBudget);
        return statusResult(p, e.status ?? 0) ?? result("error", e.cls.trayTitle, e.cls.message);
      }
      return result("unreachable", STR_PROVIDER.serverTitle, STR_PROVIDER.unreachable(p));
    }
  }
}

/** A key test's HTTP status in the app's words (never the upstream's body). null = fine. */
function statusResult(p: P, status: number): ProviderTestResult | null {
  const r = (kind: ProviderTestResult["kind"], title: string, detail: string): ProviderTestResult => ({ ok: false, kind, title, detail });
  if (status >= 200 && status < 300) return null;
  if (status === 401) return r("invalid-key", STR_PROVIDER.keyRejectedTitle, STR_PROVIDER.keyRejected(p));
  if (status === 402 || status === 403) return r("no-credit", STR_PROVIDER.noCreditTitle, STR_PROVIDER.noCredit(p));
  if (status === 429) return r("rate-limited", STR_PROVIDER.rateLimitedTitle, STR_PROVIDER.rateLimited(p));
  if (status === 0 || status === 502 || status === 504) return r("unreachable", STR_PROVIDER.serverTitle, STR_PROVIDER.unreachable(p));
  return r("error", STR_PROVIDER.serverTitle, STR_PROVIDER.server(p, status));
}
