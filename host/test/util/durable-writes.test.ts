import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsyncOnWrite, setFsyncOnWrite, writeJsonAtomic } from "../../util/atomic-json";
import { writeTextAtomic } from "../../util/atomic-text";

/**
 * Why there is a switch at all.
 *
 * fsync is not CPU work the machine can timeshare: it is a barrier the storage device has to
 * honour, and every vitest worker on the box queues on the same device. Measured here: ~9.0 ms per
 * atomic write with fsync against ~1.4 ms without, and it gets worse the more workers run. The
 * host's cap and history tests do hundreds to thousands of durable writes each —
 * routines/routine-store's "20 max, ≤1,000 lines" test alone issues 2,040 fsyncs, 77.5% of its
 * 17 s — so a rotating set of them blew the 20 s budget whenever the machine was busy and passed
 * in isolation. The suite turns fsync off; what a test measures is then the code, not the disk.
 *
 * Nothing else about the write changes: the temp file and the rename — the part that makes a
 * reader see either the old file or the new one, never a half-written one — always happen. These
 * tests pin both halves, so turning fsync off in the suite costs no coverage of the crash-safety
 * property it exists for.
 */
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "durable-"));
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; vi.restoreAllMocks(); });

const withFsync = (on: boolean) => { const was = setFsyncOnWrite(on); restore = () => { setFsyncOnWrite(was); }; };

describe("durable writes: fsync is a switch, the atomic rename never is", () => {
  it("fsyncs the temp file before renaming it when durability is on", () => {
    withFsync(true);
    const d = tmpdir();
    const file = path.join(d, "x.json");
    const order: string[] = [];
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { order.push("fsync"); });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { order.push("rename"); fs.copyFileSync(from as string, to as string); });
    writeJsonAtomic(file, { a: 1 });
    expect(order).toEqual(["fsync", "rename"]);
  });

  it("skips only the fsync when durability is off, and still writes through a temp file and a rename", () => {
    withFsync(false);
    const d = tmpdir();
    const file = path.join(d, "x.json");
    const fsync = vi.spyOn(fs, "fsyncSync");
    const renamed: [string, string][] = [];
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { renamed.push([String(from), String(to)]); realRename(from as string, to as string); });
    writeJsonAtomic(file, { a: 1 });
    expect(fsync).not.toHaveBeenCalled();
    expect(renamed).toHaveLength(1);
    expect(renamed[0]![0]).not.toBe(file); // it came from a temp file, not a write in place
    expect(renamed[0]![1]).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
  });

  it("holds for writeTextAtomic too, so both helpers share one durability story", () => {
    const d = tmpdir();
    withFsync(true);
    const fsync = vi.spyOn(fs, "fsyncSync");
    writeTextAtomic(path.join(d, "a.txt"), "hello");
    expect(fsync).toHaveBeenCalledTimes(1);
    setFsyncOnWrite(false);
    writeTextAtomic(path.join(d, "b.txt"), "hello");
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(d, "b.txt"), "utf8")).toBe("hello");
  });

  it("defaults to durable, and only SYNAPSE_ATOMIC_FSYNC=off turns it off — production never opts out by accident", () => {
    // The suite itself runs with it off (host/vitest.config.ts), which is the whole point.
    expect(process.env.SYNAPSE_ATOMIC_FSYNC).toBe("off");
    expect(fsyncOnWrite()).toBe(false);
    withFsync(true);
    expect(fsyncOnWrite()).toBe(true);
  });
});
