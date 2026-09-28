import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITSC, type SnapshotInfo, type SnapshotReason } from "@synapse/shared";
import { writeJsonAtomic } from "./atomic-file";
import type { Call } from "./gateway-call";

/** CMP-12: the Mac keeps the last 5 snapshots; the box keeps only its newest. */
export class SnapshotSink {
  constructor(private o: { dir: string; call: Call; http: { get(p: string): Promise<Buffer>; put(p: string, body: Buffer): Promise<void> }; keep?: number }) {
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.sweep(); // a previous run may have been killed mid-pull
  }

  /** Every `<id>.json` in the folder, with `info` null for one we can't read. */
  private index(): { file: string; info: SnapshotInfo | null }[] {
    return fs.readdirSync(this.o.dir).filter((f) => f.endsWith(".json")).map((f) => {
      const file = path.join(this.o.dir, f);
      try {
        const info = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotInfo;
        const ok = !!info && typeof info.id === "string" && typeof info.createdAt === "number" && typeof info.bytes === "number" && typeof info.sha256 === "string";
        return { file, info: ok ? info : null };
      } catch {
        return { file, info: null };
      }
    });
  }

  /**
   * One unreadable `<id>.json` used to make list() — and so latest(), pull() and push() — throw for
   * good. The scheduled backup is `void sink.backupNow("scheduled").catch(() => {})`, so that
   * failure was swallowed on every tick and Reset only discovered it at sink.latest(). A damaged
   * index entry is now simply not a snapshot.
   */
  list(): SnapshotInfo[] {
    return this.index().flatMap((e) => (e.info ? [e.info] : [])).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drops index files we can't read and tarballs/.part files no index entry can ever name again. */
  private sweep(): void {
    try {
      const live = new Set<string>();
      for (const e of this.index()) {
        if (e.info) live.add(e.info.id);
        else fs.rmSync(e.file, { force: true });
      }
      for (const f of fs.readdirSync(this.o.dir)) {
        const m = /^(.+)\.tar\.zst(\.part)?$/.exec(f);
        if (m && !live.has(m[1]!)) fs.rmSync(path.join(this.o.dir, f), { force: true });
      }
    } catch {
      /* best effort: never fail a backup because the folder couldn't be tidied */
    }
  }

  latest(): SnapshotInfo | null {
    return this.list()[0] ?? null;
  }

  async backupNow(reason: SnapshotReason): Promise<SnapshotInfo> {
    const { snapshot } = await this.o.call("snapshotBoxStoreNow", { reason });
    await this.pull(snapshot);
    return snapshot;
  }

  async pull(info: SnapshotInfo): Promise<string> {
    const out = path.join(this.o.dir, `${info.id}.tar.zst`);
    const part = `${out}.part`;
    fs.writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
    const hash = createHash("sha256");
    for (let off = 0; off < info.bytes; off += LIMITSC.snapshotChunkBytes) {
      const chunk = await this.o.http.get(`/snapshots/${info.id}?offset=${off}&length=${LIMITSC.snapshotChunkBytes}`);
      fs.appendFileSync(part, chunk);
      hash.update(chunk);
    }
    if (hash.digest("hex") !== info.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error("The snapshot didn't arrive intact; try again.");
    }
    fsyncFile(part);
    fs.renameSync(part, out);
    // tmp + fsync + rename: a crash here leaves either no index entry (the tarball is swept) or a
    // complete one — never the half-written file that used to break every later list().
    writeJsonAtomic(path.join(this.o.dir, `${info.id}.json`), info, 0o600);
    for (const old of this.list().slice(this.o.keep ?? LIMITSC.snapshotKeep)) {
      fs.rmSync(path.join(this.o.dir, `${old.id}.tar.zst`), { force: true });
      fs.rmSync(path.join(this.o.dir, `${old.id}.json`), { force: true });
    }
    this.sweep();
    return out;
  }

  async push(id: string): Promise<void> {
    const info = this.list().find((x) => x.id === id);
    if (!info) throw new Error(`No local snapshot ${id}`);
    const fd = fs.openSync(path.join(this.o.dir, `${id}.tar.zst`), "r");
    try {
      for (let off = 0; off < info.bytes; off += LIMITSC.snapshotChunkBytes) {
        const buf = Buffer.alloc(Math.min(LIMITSC.snapshotChunkBytes, info.bytes - off));
        fs.readSync(fd, buf, 0, buf.length, off);
        await this.o.http.put(`/snapshots/${id}?offset=${off}&total=${info.bytes}&sha256=${info.sha256}`, buf);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Best-effort durability for a file we just finished writing by appending. */
function fsyncFile(file: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r+");
    fs.fsyncSync(fd);
  } catch {
    /* the rename below is still the atomic step; fsync is the extra durability */
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}
