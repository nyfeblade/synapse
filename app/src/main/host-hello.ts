import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { helloMessage } from "@synapse/shared";

/**
 * Proof of host (two accounts on one Mac share 127.0.0.1, and any local user could bind this account's port first).
 * `ours`: the host holding this box's token answered. `refused`: something else answered. `no-answer`: nothing did
 * (not a verdict: a host still starting).
 *
 * `hello` (gateway.json says the host answers /hello): a fresh nonce goes to /hello with NO token, and only a host
 * holding the token can return HMAC-SHA256(token, helloMessage(nonce)). The token never goes to an unproven host.
 * An older host (no `hello` in gateway.json, read from this account's own box) gets the old check, its /health with
 * the token, until the next deploy brings it up to date.
 *
 * Shared by main and the coordinator (both Node).
 */
export type HostVerdict = "ours" | "refused" | "no-answer";

export function helloProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(helloMessage(nonce)).digest("hex");
}

export async function checkHost(o: { baseUrl: string; token: string; hello: boolean; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<HostVerdict> {
  const f = o.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 3000);
  if (!o.hello) {
    const r = await f(`${o.baseUrl}/health`, { headers: { authorization: `Bearer ${o.token}` }, signal }).catch(() => null);
    if (!r) return "no-answer";
    return r.status === 401 || r.status === 403 ? "refused" : "ours";
  }
  const nonce = randomBytes(16).toString("hex");
  const r = await f(`${o.baseUrl}/hello?nonce=${nonce}`, { signal }).catch(() => null);
  if (!r) return "no-answer";
  if (r.status !== 200) return "refused";
  const j = (await r.json().catch(() => null)) as { proof?: unknown } | null;
  const got = typeof j?.proof === "string" ? Buffer.from(j.proof) : Buffer.alloc(0);
  const want = Buffer.from(helloProof(o.token, nonce));
  return got.length === want.length && timingSafeEqual(got, want) ? "ours" : "refused";
}
