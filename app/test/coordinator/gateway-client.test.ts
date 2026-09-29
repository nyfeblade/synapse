import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WRONG_HOST_MESSAGE, type SseEvent } from "@synapse/shared";
import { GatewayError } from "@synapse/host/gateway/errors";
import { createGateway } from "@synapse/host/gateway/server";
import { SseHub } from "@synapse/host/gateway/sse-hub";
import { GatewayCallError, GatewayClient, type ConnectionState } from "../../src/coordinator/gateway-client";

let server: http.Server | null = null;
let client: GatewayClient | null = null;
afterEach(async () => { client?.stop(); server?.closeAllConnections(); await new Promise((r) => server?.close(r)); });

async function setup() {
  const hub = new SseHub();
  server = createGateway({
    token: "tok", hub, heartbeatMs: 50, health: () => ({ ok: true, hostVersion: "t" }),
    handlers: {
      getHostSettings: () => ({ autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "UTC", userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false }),
      deleteAgent: () => { throw new GatewayError("NOT_FOUND", "No such Bot", 404); },
    },
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const events: SseEvent[] = [];
  const states: ConnectionState[] = [];
  client = new GatewayClient({
    baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, token: "tok", retryMs: 50,
    onEvent: (e) => events.push(e), onState: (s) => states.push(s),
  });
  return { hub, events, states };
}
const until = async (f: () => boolean) => { const t = Date.now() + 3000; while (!f() && Date.now() < t) await new Promise((r) => setTimeout(r, 10)); };

describe("GatewayClient", () => {
  it("calls commands, maps errors, and checks health", async () => {
    await setup();
    expect((await client!.call("getHostSettings", {})).autoReviewEnabled).toBe(true);
    await expect(client!.call("deleteAgent", { id: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client!.call("deleteAgent", { id: "x" })).rejects.toBeInstanceOf(GatewayCallError);
    expect(await client!.health()).toMatchObject({ ok: true });
  });

  it("a host that refuses this app's token (another account's, on a shared port) says so plainly, never \"connected\"", async () => {
    await setup();
    const states: ConnectionState[] = [];
    const port = (server!.address() as AddressInfo).port;
    client = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "someone-elses", retryMs: 20, onEvent: () => {}, onState: (s) => states.push(s) });
    client.start();
    await until(() => states.some((s) => s.kind === "unreachable"));
    expect(states.some((s) => s.kind === "connected")).toBe(false);
    expect(states.find((s) => s.kind === "unreachable")).toEqual({ kind: "unreachable", error: WRONG_HOST_MESSAGE });
    // A command through the same connection fails with the same plain words, not "Missing or invalid token".
    await expect(client.call("getHostSettings", {})).rejects.toMatchObject({ code: "WRONG_HOST", message: WRONG_HOST_MESSAGE });
  });

  it("with a host that answers /hello, the stream and the calls prove the host first; an impostor never gets the token", async () => {
    await setup();
    const port = (server!.address() as AddressInfo).port;
    const sent: string[] = [];
    const spyFetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${new URL(String(u)).pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? "-"}`);
      return fetch(u, init);
    }) as typeof fetch;
    const states: ConnectionState[] = [];
    let refused = 0;
    client = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "not-tok", hello: true, retryMs: 20, fetchImpl: spyFetch, onEvent: () => {}, onState: (s) => states.push(s), onRefused: () => { refused++; } });
    client.start();
    await until(() => states.some((s) => s.kind === "unreachable"));
    expect(states.find((s) => s.kind === "unreachable")).toEqual({ kind: "unreachable", error: WRONG_HOST_MESSAGE });
    await expect(client.call("getHostSettings", {})).rejects.toMatchObject({ code: "WRONG_HOST" });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((l) => l.startsWith("/hello ") && l.endsWith(" -"))).toBe(true);
    // Main is asked once whether the token went stale (a recreated machine), not on every retry.
    expect(refused).toBe(1);
    client.stop();

    const ok: string[] = [];
    const good = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "tok", hello: true, retryMs: 20, onEvent: () => {}, onState: () => {},
      fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => { ok.push(new URL(String(u)).pathname); return fetch(u, init); }) as typeof fetch });
    expect((await good.call("getHostSettings", {})).autoReviewEnabled).toBe(true);
    expect(ok).toEqual(["/hello", "/api/getHostSettings"]);
  });

  it("provenForUse: the live stream's proof is reused; otherwise /hello is asked; an old host needs none", async () => {
    await setup();
    const port = (server!.address() as AddressInfo).port;
    const paths: string[] = [];
    const spyFetch = (async (u: RequestInfo | URL, init?: RequestInit) => { paths.push(new URL(String(u)).pathname); return fetch(u, init); }) as typeof fetch;
    const mk = (token: string, hello: boolean) => new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token, hello, retryMs: 20, fetchImpl: spyFetch, onEvent: () => {}, onState: () => {} });
    expect(await mk("tok", true).provenForUse()).toBe(true);
    expect(paths).toEqual(["/hello"]);
    expect(await mk("not-tok", true).provenForUse()).toBe(false);
    paths.length = 0;
    expect(await mk("tok", false).provenForUse()).toBe(true);
    expect(paths).toEqual([]);
  });

  it("a command gets no time limit unless one is asked for (restore, import)", async () => {
    let signal: AbortSignal | undefined | null = null;
    const c = new GatewayClient({ baseUrl: "http://x", token: "t", onEvent: () => {}, onState: () => {},
      fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return new Response(JSON.stringify({ ok: true, result: {} })); }) as typeof fetch });
    await c.call("getHostSettings", {});
    expect(signal).toBeUndefined();
  });

  it("a command whose answer isn't JSON, or never comes, fails with a plain message instead of hanging", async () => {
    const html = new GatewayClient({ baseUrl: "http://x", token: "t", onEvent: () => {}, onState: () => {}, fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as typeof fetch });
    await expect(html.call("getHostSettings", {})).rejects.toMatchObject({ code: "NETWORK" });
    const hung = new GatewayClient({
      baseUrl: "http://x", token: "t", onEvent: () => {}, onState: () => {}, callTimeoutMs: 30,
      fetchImpl: ((_u: RequestInfo | URL, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as typeof fetch,
    });
    await expect(hung.call("getHostSettings", {})).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("streams events and reconnects after the connection drops", async () => {
    const { hub, events, states } = await setup();
    client!.start();
    await until(() => states.some((s) => s.kind === "connected") && hub.size === 1);
    hub.publish({ channel: "tray", payload: { trays: [] } });
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ channel: "tray", payload: { trays: [] } });
    server!.closeAllConnections();
    await until(() => states.filter((s) => s.kind === "connected").length === 2);
    expect(states.some((s) => s.kind === "reconnecting")).toBe(true);
  });

  it("does not run two loops when start() races a pending retry-wait stop()", async () => {
    vi.useFakeTimers();
    try {
      const fetchCalls: string[] = [];
      const fakeFetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        throw new Error("refused");
      }) as typeof fetch;

      client = new GatewayClient({
        baseUrl: "http://127.0.0.1:1",
        token: "tok",
        retryMs: 1000,
        onEvent: () => {},
        onState: () => {},
        fetchImpl: fakeFetch,
      });

      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.length).toBe(1); // first attempt made, now asleep in the retry wait

      // Race: stop() while asleep in `await wait(...)`, then start() again before the timer fires.
      client.stop();
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.length).toBe(2); // the new loop's immediate attempt

      await vi.advanceTimersByTimeAsync(1000); // fires the stale loop's pending wait too
      expect(fetchCalls.length).toBe(3); // only the surviving loop may retry; the stale one must not

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchCalls.length).toBe(4); // steady state: exactly one call per interval, not two
    } finally {
      vi.useRealTimers();
    }
  });
});
