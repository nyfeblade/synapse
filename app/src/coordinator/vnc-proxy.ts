import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

/**
 * ARCH-01 VNC proxy. The renderer's noVNC can't send Authorization and always sends Origin, both of which the gateway
 * refuses. So it talks to this loopback server with a per-session ticket, and the proxy dials the gateway with Bearer and no Origin.
 */
export class VncProxy {
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private ticket: string;

  /**
   * `prove`: the gateway's host is proven before the token goes to it (the live stream's proof, else a /hello
   * challenge: GatewayClient.provenForUse). Not proven: the viewer gets a 502 and nothing is dialled.
   */
  constructor(private o: { upstream(): { baseUrl: string; token: string } | null; ticket?: string; prove?(): Promise<boolean> }) {
    this.ticket = o.ticket ?? randomBytes(24).toString("base64url");
  }

  async start(): Promise<{ port: number; ticket: string }> {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://proxy");
      const m = /^\/vnc\/([^/]+)$/.exec(url.pathname);
      const t = Buffer.from(url.searchParams.get("t") ?? "");
      const want = Buffer.from(this.ticket);
      const up = this.o.upstream();
      if (!m || !up || t.length !== want.length || !timingSafeEqual(t, want)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      void this.dial(req, socket, head, up, m[1]!);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    this.server = server;
    return { port: (server.address() as AddressInfo).port, ticket: this.ticket };
  }

  private async dial(req: http.IncomingMessage, socket: Duplex, head: Buffer, up: { baseUrl: string; token: string }, botId: string): Promise<void> {
    if (this.o.prove && !(await this.o.prove().catch(() => false))) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = `${up.baseUrl.replace(/^http/, "ws")}/vnc/${botId}`;
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${up.token}` }, perMessageDeflate: false });
    // Only covers a failure before the handshake completes; removed once `open` fires so a later error
    // can never land here and write raw HTTP onto a socket that's already been upgraded (see the `on("error", end)` below).
    const onPreOpenError = () => { socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); socket.destroy(); };
    upstream.once("error", onPreOpenError);
    upstream.once("open", () => {
      upstream.removeListener("error", onPreOpenError);
      this.wss.handleUpgrade(req, socket, head, (client) => {
        upstream.on("message", (d) => client.send(d as Buffer, { binary: true }));
        client.on("message", (d) => upstream.send(d as Buffer, { binary: true }));
        const end = () => { client.close(); upstream.close(); };
        client.on("close", end);
        client.on("error", end);
        upstream.on("close", end);
        upstream.on("error", end);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}
