import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SnapshotSink } from "../../src/main/snapshot-sink";

function makeSink(dir: string) {
  const blobs = new Map<string, Buffer>();
  let n = 0;
  return new SnapshotSink({
    dir,
    call: (async (cmd: string) => {
      if (cmd !== "snapshotBoxStoreNow") return {};
      const id = `snap-test${String(++n).padStart(4, "0")}`;
      const b = Buffer.alloc(1024, n);
      blobs.set(id, b);
      return { snapshot: { id, createdAt: n, bytes: b.length, reason: "scheduled", parts: ["workspace", "home"], sha256: createHash("sha256").update(b).digest("hex") } };
    }) as never,
    http: {
      get: async (p) => {
        const u = new URL(p, "http://x");
        const id = u.pathname.split("/").pop()!;
        const off = Number(u.searchParams.get("offset"));
        return blobs.get(id)!.subarray(off, off + Number(u.searchParams.get("length")));
      },
      put: async () => {},
    },
  });
}

// CMP-12: the scheduled backup is `void sink.backupNow("scheduled").catch(() => {})`, so anything
// list() throws is swallowed forever. One half-written ${id}.json (a force-quit or power loss
// during pull()) used to make list()/latest()/pull()/push() all throw — every backup and the Reset
// recovery path dead, with no user-visible signal.
describe("SnapshotSink survives a damaged index file", () => {
  it("skips a truncated index entry instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-corrupt-"));
    const sink = makeSink(dir);
    await sink.backupNow("scheduled");
    fs.writeFileSync(path.join(dir, "snap-broken.json"), '{"id":"snap-broken","createdAt"');
    expect(sink.list().map((x) => x.id)).toEqual(["snap-test0001"]);
    expect(sink.latest()!.id).toBe("snap-test0001");
    await expect(sink.backupNow("scheduled")).resolves.toMatchObject({ id: "snap-test0002" });
    await expect(sink.push("snap-test0002")).resolves.toBeUndefined();
  });

  it("skips a zero-length index entry left by a crash mid-write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-corrupt-"));
    fs.writeFileSync(path.join(dir, "snap-zero.json"), "");
    const sink = makeSink(dir);
    for (let i = 0; i < 3; i++) await sink.backupNow("scheduled");
    expect(sink.list().map((x) => x.id)).toEqual(["snap-test0003", "snap-test0002", "snap-test0001"]);
    expect(sink.latest()!.id).toBe("snap-test0003");
  });

  it("writes the index atomically (tmp + fsync + rename) so it is never half-written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-atomic-"));
    const realRename = fs.renameSync;
    const realFsync = fs.fsyncSync;
    const renames: string[] = [];
    let fsyncs = 0;
    const rs = vi.spyOn(fs, "renameSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => { renames.push(String(b)); return realRename(a, b); }) as typeof fs.renameSync);
    const fq = vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => { fsyncs++; return realFsync(fd); }) as typeof fs.fsyncSync);
    try {
      await makeSink(dir).backupNow("scheduled");
    } finally {
      rs.mockRestore();
      fq.mockRestore();
    }
    expect(renames.some((r) => r.endsWith("snap-test0001.json"))).toBe(true);
    expect(fsyncs).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("sweeps an orphaned tarball and .part that no index entry can ever see", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-orphan-"));
    fs.writeFileSync(path.join(dir, "snap-orphan.tar.zst"), Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, "snap-dead.tar.zst.part"), Buffer.alloc(16));
    const sink = makeSink(dir);
    await sink.backupNow("scheduled");
    expect(fs.readdirSync(dir).sort()).toEqual(["snap-test0001.json", "snap-test0001.tar.zst"]);
  });
});
