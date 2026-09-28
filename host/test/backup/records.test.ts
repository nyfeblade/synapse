import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { END_RECORD, encodeRecord, readRecords, safeRecordPath } from "../../backup/records";

async function collect(chunks: Buffer[]) {
  const out: { p: string; data: string; m?: number }[] = [];
  for await (const r of readRecords(Readable.from(chunks))) out.push({ p: r.meta.p, data: r.data.toString("utf8"), m: r.meta.m });
  return out;
}

describe("backup record stream", () => {
  it("round-trips files, split at every byte boundary", async () => {
    const whole = Buffer.concat([encodeRecord("data/a.json", Buffer.from("{\"x\":1}"), 0o640), encodeRecord("private/b.db", Buffer.from("")), END_RECORD]);
    for (let cut = 1; cut < whole.length; cut += 3) {
      expect(await collect([whole.subarray(0, cut), whole.subarray(cut)])).toEqual([
        { p: "data/a.json", data: "{\"x\":1}", m: 0o640 }, { p: "private/b.db", data: "", m: undefined },
      ]);
    }
  });

  it("rejects paths that could leave the restore folder", () => {
    for (const bad of ["../x", "/etc/passwd", "data/../../x", "data//x", "", "data/./x", "a\\b", "data/x\u0000"]) expect(safeRecordPath(bad), bad).toBe(false);
    expect(safeRecordPath("data/agents/3f2a/store.db")).toBe(true);
  });

  it("throws on a traversal path, a truncated stream and a missing end marker", async () => {
    expect(() => encodeRecord("../evil", Buffer.from("x"))).toThrow(/unsafe/);
    const head = Buffer.from(JSON.stringify({ p: "../evil", n: 1 }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    await expect(collect([Buffer.concat([len, head, Buffer.from("x")]), END_RECORD])).rejects.toThrow(/path/);
    const r = encodeRecord("data/a", Buffer.from("hello"));
    await expect(collect([r.subarray(0, r.length - 2)])).rejects.toThrow(/truncated/);
    await expect(collect([r])).rejects.toThrow(/truncated/);
  });
});
