import { STR, WRONG_HOST_MESSAGE } from "@synapse/shared";
import type { HostCreds } from "./gateway-call";
import { checkHost } from "./host-hello";

/** A token-bearing request to this account's host, by path ("/health", "/backup/snapshot", …). */
export type HostFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Main's own raw requests to the host (health polls, backup snapshot/restore, snapshot upload/download, file saves)
 * prove the host before the token is sent, like every gateway call (host-hello.ts). While the coordinator's event
 * stream is up the host was proven for this connection (a restarted host drops the stream first), so that proof is
 * reused and there's no extra round trip; otherwise each request challenges /hello first. An older host (no `hello`
 * in gateway.json) gets the direct request until its next deploy.
 */
/** The coordinator's stream proves only the host it is on: the same address and token, while it is up. */
export function streamProves(streamUp: boolean, current: HostCreds | null, c: HostCreds): boolean {
  return streamUp && !!current && current.baseUrl === c.baseUrl && current.token === c.token;
}

export function createHostFetch(o: { creds(): HostCreds | null; streamUp(): boolean; fetchImpl?: typeof fetch }): HostFetch {
  return async (p, init) => {
    const c = o.creds();
    if (!c) throw new Error(STR.hostNotConnected);
    const f = o.fetchImpl ?? fetch;
    if (c.hello && !o.streamUp()) {
      const v = await checkHost({ baseUrl: c.baseUrl, token: c.token, hello: true, fetchImpl: f });
      if (v === "refused") throw new Error(WRONG_HOST_MESSAGE);
      if (v === "no-answer") throw new Error(STR.hostNoAnswer);
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${c.token}`);
    return f(`${c.baseUrl}${p}`, { ...init, headers });
  };
}
