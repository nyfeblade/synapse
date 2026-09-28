import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { LIMITSC, type SnapshotInfo, type SnapshotReason } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import type { Exec } from "./x-exec";

export interface SnapshotControl {
  create(id: string, parts: SnapshotInfo["parts"]): Promise<string>;
  restore(id: string, parts: SnapshotInfo["parts"]): Promise<void>;
  remove(id: string): Promise<void>;
}

export class SudoSnapshotControl implements SnapshotControl {
  constructor(private exec: Exec, private helper = "/usr/local/libexec/bot-snapshot") {}
  private async run(args: string[]): Promise<string> {
    const r = await this.exec("sudo", ["-n", this.helper, ...args], { timeoutMs: 60 * 60_000 });
    if (r.code !== 0) throw new Error(`bot-snapshot ${args[0]}: ${r.stderr.trim()}`);
    return r.stdout.toString("utf8").trim();
  }
  create(id: string, parts: SnapshotInfo["parts"]) { return this.run(["create", id, parts.join(",")]); }
  async restore(id: string, parts: SnapshotInfo["parts"]) { await this.run(["restore", id, parts.join(",")]); }
  async remove(id: string) { await this.run(["delete", id]); }
}

const ALL: SnapshotInfo["parts"] = ["workspace", "home", "agent-data"];
const ID = /^snap-[0-9a-z]{6,40}$/;

/** CMP-12: snapshots are made on the box, pulled by the Mac, and only the newest stays on the box. */
export class SnapshotService {
  private running: Promise<SnapshotInfo> | null = null;
  private now: () => number;
  private uploads = new Map<string, { total: number; sha256: string; received: number }>();

  constructor(private o: { dir: string; control: SnapshotControl; now?(): number; beforeRestore?(): Promise<void>; afterRestore?(): void }) {
    this.now = o.now ?? Date.now;
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }

  private indexFile(): string { return path.join(this.o.dir, "index.json"); }
  list(): SnapshotInfo[] { return readJson<SnapshotInfo[]>(this.indexFile(), []).sort((a, b) => b.createdAt - a.createdAt); }
  private setList(l: SnapshotInfo[]): void { writeJsonAtomic(this.indexFile(), l); }
  private file(id: string): string { return path.join(this.o.dir, `${id}.tar.zst`); }

  status(): { latest: SnapshotInfo | null; running: boolean } {
    return { latest: this.list()[0] ?? null, running: this.running !== null };
  }

  create(reason: SnapshotReason, parts: SnapshotInfo["parts"] = ALL): Promise<SnapshotInfo> {
    this.running ??= (async () => {
      try {
        const id = `snap-${this.now().toString(36)}${randomBytes(3).toString("hex")}`;
        // bot-snapshot prints the sha256, then (bug #66) "trees <tree> ..." -- the manifest of what is inside.
        const [sha256 = "", ...rest] = (await this.o.control.create(id, parts)).split("\n").map((l) => l.trim());
        const treesLine = rest.find((l) => l.startsWith("trees "));
        const trees = treesLine ? treesLine.slice(6).split(/\s+/).filter(Boolean) : undefined;
        const info: SnapshotInfo = { id, createdAt: this.now(), bytes: fs.statSync(this.file(id)).size, reason, parts, sha256, ...(trees ? { trees } : {}) };
        for (const old of this.list()) await this.o.control.remove(old.id).catch(() => {});
        this.setList([info]);
        return info;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async restore(id: string, parts: SnapshotInfo["parts"]): Promise<void> {
    if (!this.list().some((x) => x.id === id)) throw new Error(`Unknown snapshot ${id}`);
    await this.o.beforeRestore?.();
    await this.o.control.restore(id, parts);
    this.o.afterRestore?.();
  }

  async remove(id: string): Promise<void> {
    await this.o.control.remove(id);
    this.setList(this.list().filter((x) => x.id !== id));
  }

  /** GET /snapshots/<id>?offset&length (download) and PUT /snapshots/<id>?offset&total&sha256 (upload). Auth is done by the gateway (T3). */
  async raw(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/snapshots\/([^/]+)$/.exec(url.pathname);
    if (!m || !ID.test(m[1]!)) return false;
    const id = m[1]!;
    try {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isInteger(offset) || offset < 0) { res.writeHead(400); res.end(); return true; }
      if (req.method === "GET") {
        const lenParam = Number(url.searchParams.get("length") ?? LIMITSC.snapshotChunkBytes);
        if (!Number.isInteger(lenParam) || lenParam < 0) { res.writeHead(400); res.end(); return true; }
        const len = Math.min(lenParam, LIMITSC.snapshotChunkBytes);
        let fd: number;
        try {
          fd = fs.openSync(this.file(id), "r");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") { res.writeHead(404); res.end(); return true; }
          throw e;
        }
        try {
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, offset);
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(buf.subarray(0, n));
        } finally {
          fs.closeSync(fd);
        }
        return true;
      }
      if (req.method === "PUT") {
        const total = Number(url.searchParams.get("total"));
        if (!Number.isInteger(total) || total < 0) { res.writeHead(400); res.end(); return true; }
        const sha256 = String(url.searchParams.get("sha256"));
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        if (body.length > LIMITSC.snapshotChunkBytes) { res.writeHead(413); res.end(); return true; }
        const part = `${this.file(id)}.part`;
        if (offset === 0) { fs.writeFileSync(part, Buffer.alloc(0), { mode: 0o600 }); this.uploads.set(id, { total, sha256, received: 0 }); }
        const u = this.uploads.get(id);
        if (!u || offset !== u.received) { res.writeHead(409); res.end(); return true; }
        fs.appendFileSync(part, body);
        u.received += body.length;
        if (u.received >= u.total) {
          const got = createHash("sha256").update(fs.readFileSync(part)).digest("hex");
          this.uploads.delete(id);
          if (got !== u.sha256) { fs.rmSync(part, { force: true }); res.writeHead(422); res.end(); return true; }
          fs.renameSync(part, this.file(id));
          this.setList([...this.list().filter((x) => x.id !== id), { id, createdAt: this.now(), bytes: u.total, reason: "manual", parts: ALL, sha256: got }]);
        }
        res.writeHead(200);
        res.end();
        return true;
      }
      return false;
    } catch (e) {
      log.error("snapshot raw() request failed", { path: url.pathname, method: req.method, error: String(e) });
      if (!res.headersSent) { res.writeHead(500); res.end(); }
      return true;
    }
  }
}
