import http from "node:http";
import { APP_NAME } from "@synapse/shared";

const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>${APP_NAME}</title><body style="font:15px -apple-system,system-ui;padding:48px;color:#141414"><p>${msg}</p></body>`;

/** PLG-04: the OAuth redirect lands on the Mac; forward code + state into the box host (completeMcpOAuth). */
/** P5 review minor: ports are tried in order (the first is the usual one); a busy port falls back to the next. */
export async function startOAuthLoopback(o: { port?: number; ports?: number[]; host?: string; complete(a: { state: string; code?: string; error?: string }): Promise<unknown> }): Promise<{ port: number; close(): void }> {
  const ports = o.ports?.length ? o.ports : [o.port ?? 0];
  let last: unknown = null;
  for (const port of ports) {
    try { return await listenOnce({ ...o, port }); } catch (e) { last = e; if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e; }
  }
  throw last ?? new Error("No OAuth loopback port is free.");
}

function listenOnce(o: { port: number; host?: string; complete(a: { state: string; code?: string; error?: string }): Promise<unknown> }): Promise<{ port: number; close(): void }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/mcp/oauth/callback") {
      res.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    try {
      await o.complete({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(`You can close this tab and return to ${APP_NAME}.`));
    } catch (e) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page(`Sign-in didn't finish: ${String((e as Error).message ?? e).replace(/[<>&]/g, "")}`));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
}
