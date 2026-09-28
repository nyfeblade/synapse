import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotSink } from "../../src/main/snapshot-sink";

describe("SnapshotSink (CMP-12 Mac side)", () => {
  it("pulls in 4 MiB chunks, verifies sha256, keeps the newest 5, and pushes back for a restore", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-"));
    const blobs = new Map<string, Buffer>();
    let n = 0;
    const puts: string[] = [];
    const sink = new SnapshotSink({
      dir,
      call: (async (cmd: string) => {
        if (cmd !== "snapshotBoxStoreNow") return {};
        const id = `snap-test${String(++n).padStart(4, "0")}`;
        const b = Buffer.alloc(5 * 1024 * 1024, n);
        blobs.set(id, b);
        return { snapshot: { id, createdAt: n, bytes: b.length, reason: "manual", parts: ["workspace", "home", "agent-data"], sha256: createHash("sha256").update(b).digest("hex") } };
      }) as never,
      http: {
        get: async (p) => { const u = new URL(p, "http://x"); const id = u.pathname.split("/").pop()!; const off = Number(u.searchParams.get("offset")); return blobs.get(id)!.subarray(off, off + Number(u.searchParams.get("length"))); },
        put: async (p, body) => { puts.push(`${p}:${body.length}`); },
      },
    });
    for (let i = 0; i < 7; i++) await sink.backupNow("manual");
    expect(sink.list().map((x) => x.id)).toEqual(["snap-test0007", "snap-test0006", "snap-test0005", "snap-test0004", "snap-test0003"]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tar.zst"))).toHaveLength(5);
    await sink.push("snap-test0007");
    expect(puts.map((p) => p.split("?")[0]).every((p) => p === "/snapshots/snap-test0007")).toBe(true);
    expect(puts.map((p) => Number(p.split(":").pop()))).toEqual([4 * 1024 * 1024, 1024 * 1024]);
  });
});
