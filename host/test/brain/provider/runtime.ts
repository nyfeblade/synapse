import type { ProviderId } from "@synapse/shared";
import { ProviderProxy } from "../../../auth/provider-proxy";
import { setProviderRuntime, type ProviderRuntime } from "../../../usage/metered-provider";

export const TEST_KEY = "sk-test-0123456789abcdefKEY";

/** The provider runtime as app.ts wires it: a real ProviderProxy (holding the key) in front of a fake upstream. */
export async function startProviderRuntime(o: {
  /** Absent: the provider's real upstream (live tests only). */
  upstream?: string; key?: string | null; consented?: (p: ProviderId) => boolean;
  allow?: ProviderRuntime["allow"]; proxyAllow?: ProviderRuntime["allow"]; firstByteMs?: number; idleMs?: number;
}) {
  const key = o.key === undefined ? TEST_KEY : o.key;
  const proxy = new ProviderProxy({ credential: () => key, ...(o.upstream ? { upstream: () => o.upstream } : {}), ...(o.proxyAllow ? { allow: o.proxyAllow } : {}) });
  await proxy.start();
  const rt: ProviderRuntime = {
    proxy, allow: o.allow ?? (() => ({ ok: true, message: null })), consented: o.consented ?? (() => true), hasKey: () => key !== null,
    ...(o.firstByteMs ? { firstByteMs: o.firstByteMs } : {}), ...(o.idleMs ? { idleMs: o.idleMs } : {}),
  };
  setProviderRuntime(rt);
  return { proxy, rt, stop: async () => { setProviderRuntime(null); await proxy.stop(); } };
}
