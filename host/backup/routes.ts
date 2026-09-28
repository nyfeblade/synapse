import type http from "node:http";
import type { HostConfig } from "../config";
import { log } from "../util/log";
import { snapshotHostState, stageRestore } from "./host-backup";

/**
 * Authenticated raw gateway routes (the gateway checks the bearer token before any raw route runs):
 *   GET /backup/snapshot   one consistent gzip snapshot of the host's state (host-backup.ts)
 *   PUT /backup/restore    stage a snapshot (header x-backup-sha256); applied on the next host start
 */
export function createBackupRaw(o: { cfg: HostConfig; bots(): { id: string; name: string }[]; hostVersion: string; now(): number }) {
  let running = false;
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/backup/snapshot" && url.pathname !== "/backup/restore") return false;
    if (running) { res.writeHead(409); res.end(); return true; }
    running = true;
    try {
      if (url.pathname === "/backup/snapshot" && req.method === "GET") {
        const stream = await snapshotHostState(o.cfg, o);
        res.writeHead(200, { "content-type": "application/gzip" });
        await new Promise<void>((resolve, reject) => { stream.on("error", reject); res.on("close", resolve); stream.pipe(res); });
        return true;
      }
      if (url.pathname === "/backup/restore" && req.method === "PUT") {
        try {
          await stageRestore(o.cfg, req, String(req.headers["x-backup-sha256"] ?? ""), o.now);
        } catch (e) {
          res.writeHead(/checksum/.test((e as Error).message) ? 422 : 400);
          res.end();
          return true;
        }
        res.writeHead(200);
        res.end();
        return true;
      }
      res.writeHead(405);
      res.end();
      return true;
    } catch (e) {
      log.error("backup route failed", { path: url.pathname, error: (e as Error).message });
      if (!res.headersSent) res.writeHead(500);
      res.end();
      return true;
    } finally {
      running = false;
    }
  };
}
