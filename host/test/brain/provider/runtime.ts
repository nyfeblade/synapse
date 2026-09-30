import type { ProviderId } from "@synapse/shared";
import { ProviderProxy } from "../../../auth/provider-proxy";
import { AuthProxy, type ReportedTokens } from "../../../auth/proxy";
import { setProviderRuntime, type ProviderRuntime } from "../../../usage/metered-provider";

export const TEST_KEY = "sk-test-0123456789abcdefKEY";
export const ANTHROPIC_TEST_KEY = "sk-ant-api03-test-0123456789abcdefKEY";

/** The provider runtime as app.ts wires it: a real ProviderProxy (holding the key) in front of a fake upstream. */
export async function startProviderRuntime(o: {
  /** Absent: the provider's real upstream (live tests only). */
  upstream?: string; key?: string | null; consented?: (p: ProviderId) => boolean;
  allow?: ProviderRuntime["allow"]; proxyAllow?: ProviderRuntime["allow"]; firstByteMs?: number; idleMs?: number;
  /** Claude on the own loop: the real AuthProxy (holding the Anthropic key) in front of this fake Messages upstream. */
  anthropicUpstream?: string; anthropicKey?: string | null;
}) {
  const key = o.key === undefined ? TEST_KEY : o.key;
  const proxy = new ProviderProxy({ credential: () => key, ...(o.upstream ? { upstream: () => o.upstream } : {}), ...(o.proxyAllow ? { allow: o.proxyAllow } : {}) });
  await proxy.start();
  const rt: ProviderRuntime = {
    proxy, allow: o.allow ?? (() => ({ ok: true, message: null })), consented: o.consented ?? (() => true), hasKey: () => key !== null,
    ...(o.firstByteMs ? { firstByteMs: o.firstByteMs } : {}), ...(o.idleMs ? { idleMs: o.idleMs } : {}),
  };
  // What the auth proxy saw go past it that the call's own report didn't cover (should stay empty: no double count).
  const unreported: { botId: string | null; model: string; u: ReportedTokens }[] = [];
  let auth: AuthProxy | null = null;
  if (o.anthropicUpstream) {
    const akey = o.anthropicKey === undefined ? ANTHROPIC_TEST_KEY : o.anthropicKey;
    const a = new AuthProxy({ upstream: o.anthropicUpstream, port: 0, credential: () => akey, unref: true, ...(o.proxyAllow ? { allow: o.proxyAllow } : {}), onUnreported: (botId, model, u) => unreported.push({ botId, model, u }) });
    await a.start();
    auth = a;
    rt.anthropic = { get url() { return a.url; }, issue: (g) => a.issue(g), revoke: (t, r) => a.revoke(t, r), hasKey: () => akey !== null };
  }
  setProviderRuntime(rt);
  return { proxy, rt, auth, unreported, stop: async () => { setProviderRuntime(null); await proxy.stop(); await auth?.stop(); } };
}
