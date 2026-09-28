import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createVncUpgrade } from "../../computer/vnc-bridge";

describe("VNC bridge (/vnc/<botId>)", () => {
  it("starts the Bot's display and splices WebSocket frames to x11vnc's unix socket both ways", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-"));
    const got: string[] = [];
    const vnc = net.createServer((s) => { s.write("RFB 003.008\n"); s.on("data", (d) => got.push(d.toString())); });
    await new Promise<void>((r) => vnc.listen(path.join(dir, "4.sock"), () => r()));
    const ensured: string[] = [];
    const upgrade = createVncUpgrade({ displays: { indexFor: (b) => (b === "bot-a" ? 4 : null), ensure: async (b) => { ensured.push(b); return {} as never; } }, transport: { kind: "unix", dir } });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a`);
    const banner = await new Promise<string>((res) => ws.on("message", (d) => res(d.toString())));
    expect(banner).toBe("RFB 003.008\n");
    ws.send(Buffer.from("RFB 003.008\n"));
    await new Promise((r) => setTimeout(r, 50));
    expect(got.join("")).toBe("RFB 003.008\n");
    expect(ensured).toEqual(["bot-a"]);
    ws.close();
    const bad = new WebSocket(`ws://127.0.0.1:${port}/vnc/nobody`);
    const err = await new Promise<string>((res) => bad.on("unexpected-response", (_r, resp) => res(String(resp.statusCode))));
    expect(err).toBe("404");
    server.close();
    vnc.close();
  });

  it("fires onOpen when the socket connects and onClose exactly once when it closes (controller ruling 1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-"));
    const vnc = net.createServer((s) => { s.write("RFB 003.008\n"); });
    await new Promise<void>((r) => vnc.listen(path.join(dir, "5.sock"), () => r()));
    const opened: string[] = [];
    const closed: string[] = [];
    const upgrade = createVncUpgrade({
      displays: { indexFor: (b) => (b === "bot-a" ? 5 : null), ensure: async () => ({} as never) }, transport: { kind: "unix", dir },
      onOpen: (b) => opened.push(b), onClose: (b) => closed.push(b),
    });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-a`);
    await new Promise<void>((res) => ws.on("message", () => res()));
    expect(opened).toEqual(["bot-a"]);
    expect(closed).toEqual([]);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toEqual(["bot-a"]);
    server.close();
    vnc.close();
  });

  it("registers an error listener on the server-side ws so a client protocol violation doesn't crash the host", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-"));
    const vnc = net.createServer((s) => { s.write("RFB 003.008\n"); });
    await new Promise<void>((r) => vnc.listen(path.join(dir, "6.sock"), () => r()));
    const upgrade = createVncUpgrade({ displays: { indexFor: (b) => (b === "bot-c" ? 6 : null), ensure: async () => ({} as never) }, transport: { kind: "unix", dir } });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const original = WebSocketServer.prototype.handleUpgrade;
    let captured: WebSocket | undefined;
    const spy = vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function (this: WebSocketServer, req, socket, head, cb) {
      return original.call(this, req, socket, head, (ws, req2) => { captured = ws as unknown as WebSocket; cb(ws, req2); });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-c`);
    await new Promise<void>((res) => ws.on("message", () => res()));
    spy.mockRestore();

    expect(captured).toBeDefined();
    expect(captured!.listenerCount("error")).toBeGreaterThan(0);
    // If no listener were registered, this would crash the process (Node's default EventEmitter behavior for 'error').
    expect(() => {
      captured!.emit("error", new Error("boom1"));
      captured!.emit("error", new Error("boom2"));
    }).not.toThrow();

    ws.close();
    server.close();
    vnc.close();
  });
});

describe("VNC bridge waits for a just-started screen's x11vnc (T29 box finding)", () => {
  it("dials again until the socket appears, then bridges", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-"));
    const upgrade = createVncUpgrade({
      displays: { indexFor: () => 7, ensure: async () => ({} as never) }, transport: { kind: "unix", dir }, retry: { totalMs: 5_000, stepMs: 20 },
    });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vnc/bot-late`);
    const banner = new Promise<string>((res, rej) => { ws.on("message", (d) => res(d.toString())); ws.on("close", () => rej(new Error("closed before the banner"))); });
    // x11vnc comes up 200 ms after the display started.
    const vnc = net.createServer((s) => s.write("RFB 003.008\n"));
    setTimeout(() => vnc.listen(path.join(dir, "7.sock")), 200);
    expect(await banner).toBe("RFB 003.008\n");
    ws.close();
    server.close();
    vnc.close();
  });
});
