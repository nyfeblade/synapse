import type { GatewayCommands } from "@synapse/shared";

export type Call = <K extends keyof GatewayCommands>(cmd: K, args: GatewayCommands[K]["args"]) => Promise<GatewayCommands[K]["result"]>;

/** Electron main's own gateway client (the coordinator serves the renderer; main needs a few calls for secrets and box operations). */
export function gatewayCall(baseUrl: string, token: string): Call {
  return (async (cmd: string, args: unknown) => {
    const r = await fetch(`${baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args ?? {}) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!j.ok) throw new Error(j.error?.message ?? `gateway ${cmd} failed`);
    return j.result;
  }) as Call;
}
