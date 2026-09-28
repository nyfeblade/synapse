import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createGateway } from "../../gateway/server";
import { SseHub } from "../../gateway/sse-hub";

async function start(opts: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const server = createGateway({ token: "t0k", hub: new SseHub(), handlers: {}, health: () => ({ ok: true }), ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}
function rawUpgrade(port: number, headers: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET /vnc/b HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`));
    let buf = "";
    s.on("data", (d) => { buf += d.toString(); });
    s.on("close", () => resolve(buf));
    setTimeout(() => { s.destroy(); resolve(buf); }, 500);
  });
}

describe("gateway hooks (Phase 3)", () => {
  it("serves raw routes only after auth", async () => {
    const g = await start({ raw: (_req, res, url) => { if (url.pathname !== "/snapshots/x") return false; res.end("chunk"); return true; } });
    const base = `http://127.0.0.1:${g.port}`;
    expect((await fetch(`${base}/snapshots/x`)).status).toBe(401);
    expect(await (await fetch(`${base}/snapshots/x`, { headers: { authorization: "Bearer t0k" } })).text()).toBe("chunk");
    g.server.close();
  });

  it("rejects upgrades with an Origin or without the token, and hands good ones to the hook", async () => {
    const seen: string[] = [];
    const g = await start({ upgrade: (_req, socket, _head, url) => { seen.push(url.pathname); socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n"); } });
    expect(await rawUpgrade(g.port, "Authorization: Bearer t0k\r\nOrigin: http://evil\r\n")).toMatch(/^HTTP\/1\.1 403/);
    expect(await rawUpgrade(g.port, "")).toMatch(/^HTTP\/1\.1 401/);
    expect(await rawUpgrade(g.port, "Authorization: Bearer t0k\r\n")).toMatch(/^HTTP\/1\.1 101/);
    expect(seen).toEqual(["/vnc/b"]);
    g.server.close();
  });
});
