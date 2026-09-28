import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHostOwnedFile } from "../../util/host-owned-file";

// Shared by host/triggers/webhook-server.ts (oversized webhook bodies) and host/computer/capture.ts
// (screenshots): both write into a workspace subtree a Bot's own process could swap for a symlink.
// "Minor ruling" (unchanged behavior, moved out of webhook-server.ts): the content is written with
// O_EXCL|O_NOFOLLOW into a directory the host created and owns, reached through real directories
// only (no symlink anywhere from `root` down). Anything else -> not saved (null).
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "host-owned-file-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("writeHostOwnedFile", () => {
  it("creates missing directories one level at a time and writes the file, default mode 0600", () => {
    const root = tmp();
    const dir = path.join(root, "a", "b");
    const file = writeHostOwnedFile(root, dir, "x.txt", "hello");
    expect(file).toBe(path.join(dir, "x.txt"));
    expect(fs.readFileSync(file!, "utf8")).toBe("hello");
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });

  it("accepts Buffer content and a custom mode", () => {
    const root = tmp();
    const dir = path.join(root, "shots");
    const buf = Buffer.from([1, 2, 3, 4]);
    const file = writeHostOwnedFile(root, dir, "1.webp", buf, 0o644);
    expect(fs.readFileSync(file!)).toEqual(buf);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o644);
  });

  it("refuses (returns null) when the target dir is a symlink planted by a Bot, and never follows it", () => {
    const root = tmp();
    const elsewhere = tmp();
    fs.symlinkSync(elsewhere, path.join(root, "shots"));
    const file = writeHostOwnedFile(root, path.join(root, "shots"), "x.txt", "hi");
    expect(file).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses when an intermediate path component is a symlink", () => {
    const root = tmp();
    const elsewhere = tmp();
    fs.symlinkSync(elsewhere, path.join(root, "mid"));
    const file = writeHostOwnedFile(root, path.join(root, "mid", "leaf"), "x.txt", "hi");
    expect(file).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("never overwrites a planted file at the target name (O_EXCL)", () => {
    const root = tmp();
    const dir = path.join(root, "d");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.txt"), "keep");
    const file = writeHostOwnedFile(root, dir, "x.txt", "attacker");
    expect(file).toBeNull();
    expect(fs.readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("keep");
  });

  it("self-heals a group/other-writable target directory (only the host writes here)", () => {
    const root = tmp();
    const dir = path.join(root, "d");
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    writeHostOwnedFile(root, dir, "x.txt", "hi");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });
});
