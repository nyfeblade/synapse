import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { helloMessage } from "@synapse/shared";
import { deployAndReconnect, hostMoved } from "../../src/main/auto-update-steps";
import { createHostFetch } from "../../src/main/host-fetch";
import type { HostCreds } from "../../src/main/gateway-call";
import { redeployHostIfChanged } from "../../src/main/native/host-redeploy";

// The automatic host update moves a box to this user's own port (box_apply_ports in deploy.sh). Everything after the
// deploy must talk to the host where it now is: the app reconnects (re-reading gateway.json) before it waits for the
// host, so the health checks go to the new port and nothing goes to the old one. No network: fakes only.
describe("automatic host update across a port move", () => {
  it("after the deploy, the health checks go to the new port and never the old one", async () => {
    const box = { port: 47800, token: "tok" };
    let creds: HostCreds = { baseUrl: "http://127.0.0.1:47800", token: "tok", hello: true };
    let deployed = false;
    const after: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const url = new URL(String(u));
      if (deployed) after.push(`${url.port}${url.pathname}`);
      if (Number(url.port) !== box.port) throw new TypeError("fetch failed");
      if (url.pathname === "/hello") return new Response(JSON.stringify({ ok: true, proof: createHmac("sha256", box.token).update(helloMessage(url.searchParams.get("nonce")!)).digest("hex") }));
      return new Response(JSON.stringify({ ok: true, hostBuild: deployed ? "new" : "old" }));
    }) as typeof fetch;
    const hostFetch = createHostFetch({ creds: () => creds, streamUp: () => false, fetchImpl });
    const health = async () => { const r = await hostFetch("/health").catch(() => null); return r?.ok ? (await r.json()) as { hostBuild?: string } : null; };
    const r = await redeployHostIfChanged({
      bundledBuild: () => "new", health, prepare: async () => ({ ok: true, busyBotIds: [] }), log: () => {},
      deploy: deployAndReconnect({
        deploy: async () => { box.port = 47900; deployed = true; },
        // connect(): re-reads gateway.json and proves the host where it is now.
        reconnect: async () => { creds = { baseUrl: `http://127.0.0.1:${box.port}`, token: box.token, hello: true }; },
      }),
      waitHealthy: async () => { for (let i = 0; i < 3; i++) if (await health()) return; throw new Error("not healthy"); },
    });
    expect(r).toBe("deployed");
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((l) => l.startsWith("47900/"))).toBe(true);
  });

  it("a refusal reconnects when the port or the proof changed, not only the token", () => {
    const h = { baseUrl: "http://127.0.0.1:47800", token: "tok", hello: false };
    expect(hostMoved(h, { port: 47800, token: "tok" })).toBe(false);
    expect(hostMoved(h, { port: 47900, token: "tok", hello: true })).toBe(true);
    expect(hostMoved(h, { port: 47800, token: "tok", hello: true })).toBe(true);
    expect(hostMoved(h, { port: 47800, token: "new" })).toBe(true);
  });
});
