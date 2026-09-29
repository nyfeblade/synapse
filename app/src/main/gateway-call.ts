import { STR, WRONG_HOST_MESSAGE, type GatewayCommands } from "@synapse/shared";
import { checkHost } from "./host-hello";

export type Call = <K extends keyof GatewayCommands>(cmd: K, args: GatewayCommands[K]["args"]) => Promise<GatewayCommands[K]["result"]>;

/** Where the host is and how to prove it (host-hello.ts). */
export interface HostCreds { baseUrl: string; token: string; hello?: boolean }

const REFUSED = Symbol("refused");

/**
 * Electron main's own gateway client (the coordinator serves the renderer; main needs a few calls for secrets and box
 * operations). Every failure is a plain sentence the UI can show as it is.
 *
 * - `hello`: each call first proves the host (a /hello challenge, no token), so the token never goes to whatever
 *   bound the port while the host was down, unless `proven()` says the coordinator's stream is up on it.
 * - A refusal (a 401, or a failed proof) first asks `onStale` for fresh credentials: a machine recreated under this
 *   closure has a new token. Only when there are none does it name another account's host.
 * - No time limit unless the caller asks for one: a restore or an import may legitimately take long.
 */
export function gatewayCall(baseUrl: string, token: string, o: {
  fetchImpl?: typeof fetch; timeoutMs?: number; hello?: boolean; onStale?: () => Promise<HostCreds | null>;
  /** The coordinator's stream is up on exactly this host (address and token): its proof is reused (host-fetch.ts streamProves). */
  proven?: (c: HostCreds) => boolean;
} = {}): Call {
  const f = o.fetchImpl ?? fetch;
  let cur: HostCreds = { baseUrl, token, hello: o.hello === true };
  const attempt = async (c: HostCreds, cmd: string, args: unknown): Promise<unknown> => {
    if (c.hello && !o.proven?.(c)) {
      const v = await checkHost({ baseUrl: c.baseUrl, token: c.token, hello: true, fetchImpl: f });
      if (v === "no-answer") throw new Error(STR.hostNoAnswer);
      if (v === "refused") return REFUSED;
    }
    let r: Response;
    try {
      r = await f(`${c.baseUrl}/api/${cmd}`, {
        method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify(args ?? {}),
        ...(o.timeoutMs !== undefined ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}),
      });
    } catch (e) {
      const n = (e as { name?: string }).name;
      throw new Error(n === "TimeoutError" || n === "AbortError" ? STR.hostTimeout : STR.hostNoAnswer);
    }
    if (r.status === 401) return REFUSED;
    const j = (await r.json().catch(() => null)) as { ok?: unknown; result?: unknown; error?: { message?: string } } | null;
    if (!j || typeof j.ok !== "boolean") throw new Error(STR.hostBadAnswer(r.status));
    if (!j.ok) throw new Error(j.error?.message || STR.hostBadAnswer(r.status));
    return j.result;
  };
  return (async (cmd: string, args: unknown) => {
    let r = await attempt(cur, cmd, args);
    if (r === REFUSED) {
      const fresh = await o.onStale?.().catch(() => null);
      if (fresh && fresh.token !== cur.token) { cur = { ...fresh, hello: fresh.hello === true }; r = await attempt(cur, cmd, args); }
      if (r === REFUSED) throw new Error(WRONG_HOST_MESSAGE);
    }
    return r;
  }) as Call;
}
