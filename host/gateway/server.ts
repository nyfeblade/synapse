import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { LIMITS, type CommandName, type GatewayCommands } from "@synapse/shared";
import { GatewayError } from "./errors";
import type { SseHub } from "./sse-hub";
import { log } from "../util/log";

export type CommandHandlers = {
  [K in CommandName]?: (args: GatewayCommands[K]["args"]) => Promise<GatewayCommands[K]["result"]> | GatewayCommands[K]["result"];
};

export interface GatewayOptions {
  token: string;
  handlers: CommandHandlers;
  hub: SseHub;
  health: () => unknown;
  heartbeatMs?: number;
  /** Phase 3: authenticated raw routes (snapshot chunks, T21). Return true when handled. */
  raw?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean> | boolean;
  /** Phase 3: authenticated WebSocket upgrades (/vnc/<botId>, T23). */
  upgrade?: (req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;
  /** Phase 5: a larger body cap for commands that legitimately send more (e.g. previewTemplateImport's bytesBase64). */
  bodyLimits?: Partial<Record<CommandName, number>>;
  /** HTTP `/events` clients only — not internal hub.subscribe() callers. */
  onSseClients?: (n: number) => void;
}

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new GatewayError("BODY_TOO_LARGE", `Request body exceeds ${Math.round(limit / 1048576)} MB`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createGateway(opts: GatewayOptions): http.Server {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const heartbeatMs = opts.heartbeatMs ?? LIMITS.sseHeartbeatMs;
  let sseClients = 0;

  const server = http.createServer(async (req, res) => {
    if (req.headers.origin !== undefined) {
      return send(res, 403, { ok: false, error: { code: "FORBIDDEN_ORIGIN", message: "Browser requests are not allowed" } });
    }
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return send(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } });
    }
    const url = new URL(req.url ?? "/", "http://gateway");
    if (opts.raw) {
      try {
        if (await opts.raw(req, res, url)) return;
      } catch (e) {
        log.error("gateway raw route failed", { path: url.pathname, error: String(e) });
        if (!res.headersSent) return send(res, 500, { ok: false, error: { code: "INTERNAL", message: "Internal error" } });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, opts.health());

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      const unsubscribe = opts.hub.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const hb = setInterval(() => res.write(": hb\n\n"), heartbeatMs);
      sseClients++;
      opts.onSseClients?.(sseClients);
      req.on("close", () => {
        clearInterval(hb);
        unsubscribe();
        sseClients--;
        opts.onSseClients?.(sseClients);
      });
      return;
    }

    const m = /^\/api\/([A-Za-z][A-Za-z0-9]*)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const cmd = m[1] as CommandName;
      const handler = opts.handlers[cmd] as ((a: unknown) => unknown) | undefined;
      if (!handler) return send(res, 404, { ok: false, error: { code: "UNKNOWN_COMMAND", message: `Unknown command ${cmd}` } });
      try {
        const raw = await readBody(req, opts.bodyLimits?.[cmd] ?? MAX_BODY);
        const args = raw.trim() === "" ? {} : JSON.parse(raw);
        const result = await handler(args);
        return send(res, 200, { ok: true, result: result ?? {} });
      } catch (e) {
        if (e instanceof GatewayError) return send(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
        if (e instanceof SyntaxError) return send(res, 400, { ok: false, error: { code: "BAD_JSON", message: e.message } });
        log.error("gateway command failed", { cmd, error: String(e) });
        return send(res, 500, { ok: false, error: { code: "INTERNAL", message: "Internal error" } });
      }
    }
    send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
  });

  server.on("upgrade", (req, socket, head) => {
    const reject = (code: string) => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (req.headers.origin !== undefined) return reject("403 Forbidden");
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reject("401 Unauthorized");
    if (!opts.upgrade) return reject("404 Not Found");
    opts.upgrade(req, socket, head, new URL(req.url ?? "/", "http://gateway"));
  });

  return server;
}
