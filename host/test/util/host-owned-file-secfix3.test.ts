import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeHostOwnedFile } from "../../util/host-owned-file";

// Final secfix round 3, ruling 4: host output goes under /workspace/.host-out/{uploads,events,screens,teach}. /workspace
// itself is box-writable (2775), so box can rename .host-out away and put its own tree (with a symlink) in its place.
// writeHostOwnedFile must (1) require EVERY component below the root to be a real directory the host owns, and (2)
// after the open, verify the file it created is the one at the expected path (fstat dev/ino against the re-walked
// chain; /proc/self/fd on Linux) and remove it otherwise, so nothing lands outside.
const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hof3-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("secfix3 ruling 4: writeHostOwnedFile guards every component, not just the last", () => {
  it("refuses when an intermediate component (.host-out) is not owned by the host", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, ".host-out", "uploads"), { recursive: true });
    const realLstat = fs.lstatSync;
    const me = process.getuid!();
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realLstat(p, o as never) as fs.Stats;
      if (String(p) === path.join(ws, ".host-out")) return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.Stats, st, { uid: me + 1 });
      return st;
    }) as typeof fs.lstatSync);
    expect(writeHostOwnedFile(ws, path.join(ws, ".host-out", "uploads"), "a.txt", "hi", 0o640)).toBeNull();
    vi.restoreAllMocks();
    expect(fs.readdirSync(path.join(ws, ".host-out", "uploads"))).toEqual([]);
  });

  it("a parent swap between the checks and the open leaves nothing outside and returns null", () => {
    const ws = tmp();
    const outside = tmp();
    fs.mkdirSync(path.join(ws, ".host-out", "uploads"), { recursive: true });
    const target = path.join(ws, ".host-out", "uploads", "a.txt");
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === target) {
        // box: mv /workspace/.host-out aside, recreate it with uploads → a place box can't write itself
        fs.renameSync(path.join(ws, ".host-out"), path.join(ws, ".host-out.old"));
        fs.mkdirSync(path.join(ws, ".host-out"));
        fs.symlinkSync(outside, path.join(ws, ".host-out", "uploads"));
      }
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    expect(writeHostOwnedFile(ws, path.join(ws, ".host-out", "uploads"), "a.txt", "SECRET-CONTENT", 0o640)).toBeNull();
    vi.restoreAllMocks();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("heals a group/other-writable host-owned intermediate directory, and writes 0640 when asked", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, ".host-out", "screens"), { recursive: true });
    fs.chmodSync(path.join(ws, ".host-out"), 0o777);
    const file = writeHostOwnedFile(ws, path.join(ws, ".host-out", "screens", "b1"), "1.webp", Buffer.from([1]), 0o640);
    expect(file).toBe(path.join(ws, ".host-out", "screens", "b1", "1.webp"));
    expect(fs.statSync(path.join(ws, ".host-out")).mode & 0o022).toBe(0);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(ws, ".host-out", "screens", "b1")).mode & 0o027).toBe(0); // 0750: box reads via group only
  });

  it("refuses a name with a slash or a dot name", () => {
    const ws = tmp();
    for (const n of ["../x", "a/b", ".", ".."]) expect(writeHostOwnedFile(ws, path.join(ws, ".host-out", "events"), n, "x"), n).toBeNull();
  });
});
