import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { VncProxy } from "../../src/coordinator/vnc-proxy";

const { capturedUpstreams } = vi.hoisted(() => ({ capturedUpstreams: [] as unknown[] }));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  class CapturingWebSocket extends actual.WebSocket {
    constructor(...args: ConstructorParameters<typeof actual.WebSocket>) {
      super(...args);
      capturedUpstreams.push(this);
    }
  }
  return { ...actual, default: CapturingWebSocket, WebSocket: CapturingWebSocket };
});

describe("VncProxy (ARCH-01)", () => {
  it("accepts only the ticket, dials the gateway with Bearer and no Origin, and relays binary frames", async () => {
    const seen: { auth?: string; origin?: string; url?: string }[] = [];
    const up = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    up.on("upgrade", (req, socket, head) => {
      seen.push({ auth: req.headers.authorization, origin: req.headers.origin, url: req.url });
      wss.handleUpgrade(req, socket, head, (ws) => { ws.send(Buffer.from("RFB 003.008\n")); ws.on("message", (m) => ws.send(Buffer.concat([Buffer.from("echo:"), m as Buffer]))); });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const baseUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
    const proxy = new VncProxy({ upstream: () => ({ baseUrl, token: "t0k" }), ticket: "tick-1" });
    const { port } = await proxy.start();

    const ok = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a?t=tick-1`, { origin: "file://" });
    const first = await new Promise<Buffer>((res) => ok.once("message", (d) => res(d as Buffer)));
    expect(first.toString()).toBe("RFB 003.008\n");
    ok.send(Buffer.from("hi"));
    expect((await new Promise<Buffer>((res) => ok.once("message", (d) => res(d as Buffer)))).toString()).toBe("echo:hi");
    expect(seen[0]).toEqual({ auth: "Bearer t0k", origin: undefined, url: "/vnc/bot-a" });

    const bad = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a?t=wrong`);
    expect(await new Promise<number>((res) => bad.on("unexpected-response", (_r, resp) => res(resp.statusCode ?? 0)))).toBe(403);
    ok.close();
    await proxy.close();
    up.close();
  });

  // Final review: the proxy dialled the gateway with the token even when the host wasn't proven (no stream, or the
  // connect got no answer). It now asks the connection to prove the host first, and dials nothing when it can't.
  it("dials the gateway only once the host is proven; an unproven host gets no token", async () => {
    const seen: string[] = [];
    const up = http.createServer();
    up.on("upgrade", (req, socket) => { seen.push(String(req.headers.authorization)); socket.destroy(); });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const baseUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
    let proofs = 0;
    const proxy = new VncProxy({ upstream: () => ({ baseUrl, token: "t0k" }), ticket: "tick-3", prove: async () => { proofs++; return false; } });
    const { port } = await proxy.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a?t=tick-3`);
    expect(await new Promise<number>((res) => ws.on("unexpected-response", (_r, resp) => res(resp.statusCode ?? 0)))).toBe(502);
    expect(proofs).toBe(1);
    expect(seen).toEqual([]);
    await proxy.close();
    up.close();
  });

  it("registers client.on('error') and keeps handling upstream errors after open (not just the first one)", async () => {
    capturedUpstreams.length = 0;
    const up = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    up.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => { ws.send(Buffer.from("RFB 003.008\n")); });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const upPort = (up.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${upPort}`;
    const proxy = new VncProxy({ upstream: () => ({ baseUrl, token: "t0k" }), ticket: "tick-2" });
    const { port } = await proxy.start();

    const original = WebSocketServer.prototype.handleUpgrade;
    let capturedClient: WebSocket | undefined;
    const spy = vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function (this: WebSocketServer, req, socket, head, cb) {
      return original.call(this, req, socket, head, (ws, req2) => { capturedClient = ws as unknown as WebSocket; cb(ws, req2); });
    });

    const ok = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a?t=tick-2`, { origin: "file://" });
    await new Promise<void>((res) => ok.once("message", () => res()));
    spy.mockRestore();

    expect(capturedClient).toBeDefined();
    expect(capturedClient!.listenerCount("error")).toBeGreaterThan(0);

    const upstreamInstance = capturedUpstreams.find((w) => (w as WebSocket).url?.includes(`127.0.0.1:${upPort}`)) as WebSocket | undefined;
    expect(upstreamInstance).toBeDefined();
    // Two errors after open must both be handled (not just the first) and must never crash the process.
    expect(() => {
      upstreamInstance!.emit("error", new Error("boom1"));
      upstreamInstance!.emit("error", new Error("boom2"));
    }).not.toThrow();

    ok.close();
    await proxy.close();
    up.close();
  });
});
