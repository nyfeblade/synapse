import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { DisplayManager } from "./displays";

export type VncTransport = { kind: "unix"; dir: string } | { kind: "tcp"; host: string; base: number };

/** Reads the spike's choice (box/desktop.env → /etc/bots/desktop.env). */
export function readVncTransport(envFile = "/etc/bots/desktop.env"): VncTransport {
  const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  return /^VNC_TRANSPORT=tcp$/m.test(text) ? { kind: "tcp", host: "127.0.0.1", base: 5900 } : { kind: "unix", dir: "/run/bothost-vnc" };
}

/** Gateway upgrade route /vnc/<botId> (auth and Origin are checked by the gateway, T3). Bytes pass through untouched. */
export function createVncUpgrade(o: {
  displays: Pick<DisplayManager, "indexFor" | "ensure">;
  transport: VncTransport;
  connect?(t: { path: string } | { host: string; port: number }): net.Socket;
  /** T29 box finding: a screen that was just started has no x11vnc socket for a moment; keep dialing. */
  retry?: { totalMs: number; stepMs: number };
  /** Controller ruling 1: lets the caller track open preview/computer-view sockets per Bot, so a Bot with
   *  one open is never reclaimed as idle. onOpen fires once the socket is live; onClose fires exactly once. */
  onOpen?(botId: string): void;
  onClose?(botId: string): void;
}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const dial = o.connect ?? ((t: { path: string } | { host: string; port: number }) => ("path" in t ? net.connect(t.path) : net.connect(t.port, t.host)));
  return (req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): void => {
    const m = /^\/vnc\/([^/]+)$/.exec(url.pathname);
    const idx = m ? o.displays.indexFor(decodeURIComponent(m[1]!)) : null;
    if (!m || idx === null) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const botId = decodeURIComponent(m[1]!);
    void o.displays.ensure(botId).then(
      () => wss.handleUpgrade(req, socket, head, (ws) => {
        o.onOpen?.(botId);
        const target = o.transport.kind === "unix" ? { path: path.join(o.transport.dir, `${idx}.sock`) } : { host: o.transport.host, port: o.transport.base + idx };
        const retry = o.retry ?? { totalMs: 15_000, stepMs: 250 };
        const until = Date.now() + retry.totalMs;
        const early: Buffer[] = [];
        let up: net.Socket | null = null;
        let closed = false;
        const end = () => { if (closed) return; closed = true; up?.destroy(); ws.close(); o.onClose?.(botId); };
        ws.on("message", (d) => (up ? up.write(d as Buffer) : early.push(d as Buffer)));
        ws.on("close", end);
        ws.on("error", end);
        const attempt = () => {
          if (closed) return;
          const s = dial(target);
          s.once("connect", () => {
            up = s;
            for (const b of early.splice(0)) s.write(b);
            s.on("data", (d) => ws.send(d, { binary: true }));
            s.on("close", end);
            s.on("error", end);
          });
          s.once("error", (e: NodeJS.ErrnoException) => {
            if (up === s) return;
            s.destroy();
            if ((e.code === "ENOENT" || e.code === "ECONNREFUSED") && Date.now() < until) setTimeout(attempt, retry.stepMs);
            else end();
          });
        };
        attempt();
      }),
      () => {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
      },
    );
  };
}
