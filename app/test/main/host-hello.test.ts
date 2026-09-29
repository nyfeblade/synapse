import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "@synapse/host/gateway/server";
import { SseHub } from "@synapse/host/gateway/sse-hub";
import { checkHost } from "../../src/main/host-hello";

// Two accounts on one Mac, or a local user who bound this account's port first: the app proves it reached ITS host
// (a /hello challenge the token answers) before the token goes anywhere. A host too old for /hello (gateway.json has
// no `hello`) gets the old check: its /health with the token.
const servers: http.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });
async function host(token: string): Promise<string> {
  const s = createGateway({ token, hub: new SseHub(), health: () => ({ ok: true, hostVersion: "t" }), handlers: {} });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
/** A fetch that records every Authorization header it was asked to send. */
const spy = (sent: string[]) => (async (u: RequestInfo | URL, init?: RequestInit) => {
  sent.push(`${new URL(String(u)).pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? "-"}`);
  return fetch(u, init);
}) as typeof fetch;

describe("checkHost", () => {
  it("this account's host answers the challenge: ours, and the token never left", async () => {
    const base = await host("mine");
    const sent: string[] = [];
    expect(await checkHost({ baseUrl: base, token: "mine", hello: true, fetchImpl: spy(sent) })).toBe("ours");
    expect(sent).toEqual(["/hello -"]);
  });

  it("another host on the port (another account's, or anyone's) is refused before the token is sent", async () => {
    const base = await host("someone-elses");
    const sent: string[] = [];
    expect(await checkHost({ baseUrl: base, token: "mine", hello: true, fetchImpl: spy(sent) })).toBe("refused");
    expect(sent.every((l) => l.endsWith(" -"))).toBe(true);
  });

  it("an impostor that answers /hello with anything but the proof is refused", async () => {
    const fake = (async () => new Response(JSON.stringify({ ok: true, proof: "00".repeat(32) }), { status: 200 })) as unknown as typeof fetch;
    expect(await checkHost({ baseUrl: "http://x", token: "mine", hello: true, fetchImpl: fake })).toBe("refused");
    const four04 = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await checkHost({ baseUrl: "http://x", token: "mine", hello: true, fetchImpl: four04 })).toBe("refused");
  });

  it("nothing answering is not a verdict", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await checkHost({ baseUrl: "http://x", token: "mine", hello: true, fetchImpl: down })).toBe("no-answer");
  });

  it("an old host (no hello in gateway.json) gets the old token check", async () => {
    const base = await host("mine");
    expect(await checkHost({ baseUrl: base, token: "mine", hello: false })).toBe("ours");
    expect(await checkHost({ baseUrl: base, token: "stale", hello: false })).toBe("refused");
  });
});
