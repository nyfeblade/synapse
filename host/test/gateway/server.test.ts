import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "../../gateway/errors";
import { createGateway } from "../../gateway/server";
import { SseHub } from "../../gateway/sse-hub";

const TOKEN = "t0k3n";
let server: http.Server | null = null;

async function start(heartbeatMs = 15_000) {
  const hub = new SseHub();
  server = createGateway({
    token: TOKEN,
    hub,
    heartbeatMs,
    health: () => ({ ok: true, hostVersion: "test" }),
    handlers: {
      getHostSettings: () => ({
        autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "UTC", userTimeZoneOverride: null,
        pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false,
      }),
      deleteAgent: () => { throw new GatewayError("NOT_FOUND", "No such Bot", 404); },
      getPhase5Settings: () => ({ memoryMode: "standard" }) as never,
    },
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { hub, base };
}
const auth = { authorization: `Bearer ${TOKEN}` };

afterEach(async () => { await new Promise((r) => server?.close(r)); server = null; });

describe("gateway", () => {
  it("rejects missing or wrong tokens with 401", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects any request with an Origin header with 403 (ARCH-02)", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`, { headers: { ...auth, origin: "http://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("serves /health and POST /api/<cmd>", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/health`, { headers: auth })).json()).toEqual({ ok: true, hostVersion: "test" });
    const r = await fetch(`${base}/api/getHostSettings`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    expect(await r.json()).toMatchObject({ ok: true, result: { autoReviewEnabled: true } });
  });

  it("routes command names that contain digits (getPhase5Settings)", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/getPhase5Settings`, { method: "POST", headers: auth, body: "{}" });
    expect(await r.json()).toEqual({ ok: true, result: { memoryMode: "standard" } });
  });

  it("maps GatewayError to its status and unknown commands to 404", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/deleteAgent`, { method: "POST", headers: auth, body: JSON.stringify({ id: "x" }) });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "No such Bot" } });
    const u = await fetch(`${base}/api/noSuchThing`, { method: "POST", headers: auth, body: "{}" });
    expect(u.status).toBe(404);
    expect(((await u.json()) as { error: { code: string } }).error.code).toBe("UNKNOWN_COMMAND");
  });

  it("responds 500 instead of crashing when a raw route handler throws (T21 fix round 1)", async () => {
    const hub = new SseHub();
    server = createGateway({
      token: TOKEN,
      hub,
      health: () => ({ ok: true }),
      handlers: {},
      raw: async (_req, _res, url) => {
        if (url.pathname.startsWith("/snapshots/")) throw new Error("boom: e.g. ENOENT on a stale snapshot id");
        return false;
      },
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/snapshots/snap-whatever?offset=0`, { headers: auth });
    expect(r.status).toBe(500);
    // The server process itself must still be up to answer a normal request afterwards.
    const health = await fetch(`${base}/health`, { headers: auth });
    expect(health.status).toBe(200);
  });

  it("streams published events and heartbeats over SSE", async () => {
    const { base, hub } = await start(30);
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { headers: auth, signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    hub.publish({ channel: "tray", payload: { trays: [] } });
    const deadline = Date.now() + 2000;
    while (!(buf.includes('"channel":"tray"') && buf.includes(": hb")) && Date.now() < deadline) {
      const { value } = await reader.read();
      buf += dec.decode(value);
    }
    ac.abort();
    expect(buf).toContain('data: {"channel":"tray","payload":{"trays":[]}}');
    expect(buf).toContain(": hb");
  });
});
