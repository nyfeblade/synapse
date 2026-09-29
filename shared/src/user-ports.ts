/**
 * Two macOS accounts on one Mac: each account runs its own OrbStack machine, and OrbStack forwards the machine's
 * listening ports to the Mac's 127.0.0.1, which every account shares. With fixed ports the second account's box
 * couldn't get them and its app reached the FIRST account's host. So each Mac user gets their own three ports, from
 * their uid (per user, stable across re-provision and updates):
 *
 *   uid 501 (the first account on a Mac, and every existing single-user install) keeps 47800/47801/47802, so an
 *   update moves nothing there. Every other uid gets a 10-port slot from 47900: 47900 + ((uid - 502) mod 125) * 10,
 *   i.e. 47900..49142, above the OAuth loopback ports (47823-47825) and below macOS's ephemeral range (49152+).
 *   125 consecutive uids never share a slot.
 *
 * box/orb.sh computes the same numbers in shell (a test keeps the two in step).
 */
export interface UserPorts { gateway: number; webhook: number; authProxy: number }

export const LEGACY_PORT_UID = 501;
const LEGACY_BASE = 47800;
const SLOT_BASE = 47900;
const SLOT_STRIDE = 10;
const SLOTS = 125;

export function userPorts(uid: number): UserPorts {
  const u = Math.trunc(Number.isFinite(uid) ? uid : LEGACY_PORT_UID);
  const base = u === LEGACY_PORT_UID ? LEGACY_BASE : SLOT_BASE + ((((u - 502) % SLOTS) + SLOTS) % SLOTS) * SLOT_STRIDE;
  return { gateway: base, webhook: base + 1, authProxy: base + 2 };
}

/** The env the box scripts (deploy.sh, provision-from-mac.sh, verify-box.sh) read. */
export function boxPortEnv(uid: number): Record<"SYNAPSE_GATEWAY_PORT" | "SYNAPSE_WEBHOOK_PORT" | "SYNAPSE_AUTH_PROXY_PORT", string> {
  const p = userPorts(uid);
  return { SYNAPSE_GATEWAY_PORT: String(p.gateway), SYNAPSE_WEBHOOK_PORT: String(p.webhook), SYNAPSE_AUTH_PROXY_PORT: String(p.authProxy) };
}

/** A port answered, but the host there refused this account's gateway token: it belongs to another Mac user. */
export const WRONG_HOST_MESSAGE = "Synapse is running in another account on this Mac and is using this account's connection. Quit Synapse there, then retry.";
export const WRONG_HOST_CODE = "WRONG_HOST";

/**
 * Proof of host: before the app sends its gateway token to whatever answers on 127.0.0.1:port, it sends a fresh
 * nonce to `/hello` (no token) and the host answers HMAC-SHA256(key = token, message = helloMessage(nonce)), hex.
 * Only the host holding this box's token can answer; the token itself never leaves. A host writes `hello: 1` into
 * gateway.json when it answers /hello; an older host (no `hello`) gets the old check, its /health with the token.
 */
export const helloMessage = (nonce: string): string => `synapse-hello:${nonce}`;
export const HELLO_NONCE_RE = /^[0-9a-f]{32}$/;
/** The port a box may report: this user's own, or 47800 while an install from before per-user ports moves. */
export function acceptableGatewayPorts(uid: number): number[] {
  return [...new Set([userPorts(uid).gateway, userPorts(LEGACY_PORT_UID).gateway])];
}
