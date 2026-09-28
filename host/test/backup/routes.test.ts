import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBackupRaw } from "../../backup/routes";
import { tmpConfig } from "../helpers";

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function serve(cfg: ReturnType<typeof tmpConfig>) {
  const raw = createBackupRaw({ cfg, bots: () => [], hostVersion: "0.1.0", now: () => 1 });
  server = http.createServer((req, res) => void raw(req, res, new URL(req.url!, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("backup gateway routes", () => {
  it("GET /backup/snapshot streams a gzip snapshot; PUT /backup/restore stages it", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.dataRoot, { recursive: true });
    fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), "{}");
    const base = await serve(cfg);
    const snap = Buffer.from(await (await fetch(`${base}/backup/snapshot`)).arrayBuffer());
    expect(snap.subarray(0, 2).toString("hex")).toBe("1f8b");
    const sha = createHash("sha256").update(snap).digest("hex");
    expect((await fetch(`${base}/backup/restore`, { method: "PUT", headers: { "x-backup-sha256": "0".repeat(64) }, body: snap })).status).toBe(422);
    expect((await fetch(`${base}/backup/restore`, { method: "PUT", headers: { "x-backup-sha256": sha }, body: snap })).status).toBe(200);
    expect(fs.existsSync(path.join(cfg.hostPrivate, "restore-pending.json"))).toBe(true);
    expect((await fetch(`${base}/backup/other`)).status).toBe(404);
  });
});
