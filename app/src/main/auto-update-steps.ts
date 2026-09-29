/**
 * The automatic box updates (reprovisionIfChanged, redeployHostIfChanged) deploy the host, and a deploy can move it to
 * this Mac user's own port (box_apply_ports, shared/src/user-ports.ts). So the app reconnects right after the deploy,
 * re-reading gateway.json and proving the host where it now is, BEFORE it waits for the host to be healthy, the way
 * Settings → Update does (box-lifecycle.ts). Otherwise the wait polls the old port with the token for minutes and the
 * coordinator keeps dialling it.
 */
export function deployAndReconnect(o: { deploy(): Promise<void>; reconnect(): Promise<void> }): () => Promise<void> {
  return async () => {
    await o.deploy();
    await o.reconnect();
  };
}

/**
 * A refused request: did the host move (a redeploy to this user's port, an update that added /hello) or get a new token
 * (a recreated machine)? Then the app reconnects; only an unchanged box means another account's host.
 */
export function hostMoved(h: { baseUrl: string; token: string; hello?: boolean }, info: { port: number; token: string; hello?: boolean }): boolean {
  let port: string;
  try { port = new URL(h.baseUrl).port; } catch { return true; }
  return info.token !== h.token || String(info.port) !== port || (info.hello === true) !== (h.hello === true);
}
