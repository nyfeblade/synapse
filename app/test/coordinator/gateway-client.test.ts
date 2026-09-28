import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SseEvent } from "@synapse/shared";
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
