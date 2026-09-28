import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostOutDir, type HostOutKind } from "../../util/host-out";
import { writeHostOwnedFile } from "../../util/host-owned-file";

// Final secfix round 3, ruling 4 (box): /workspace/.host-out/{uploads,events,screens,teach} are bothost:bots 2750 all
// the way down; a file the host writes there is bothost:bots 0640; box reads it (via the bots group) and can't write
// there. Runs as bothost with RUN_BOX=1 (box/run-box-tests.sh). box's side is exercised through bot-git-as-box, the one
// sudo helper that runs an arbitrary (git) command as box.
const asBoxGit = (...args: string[]) => execFileSync("sudo", ["-n", "/usr/local/libexec/bot-git-as-box", "/workspace", "--", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const stat = (p: string) => execFileSync("stat", ["-c", "%U:%G:%a", p], { encoding: "utf8" }).trim();
const made: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of made.splice(0)) fs.rmSync(f, { recursive: true, force: true }); });

describe.runIf(process.env.RUN_BOX === "1")("secfix3 ruling 4: host-owned output on the box", () => {
  it.each(["uploads", "events", "screens", "teach"] as HostOutKind[])("%s: every component bothost:bots 2750, the file 0640, box reads but can't write", (kind) => {
    expect(stat("/workspace/.host-out")).toBe("bothost:bots:2750");
    const dir = hostOutDir("/workspace", kind);
    expect(stat(dir)).toBe("bothost:bots:2750");
    const name = `secfix3-box-${process.pid}.txt`;
    const file = writeHostOwnedFile("/workspace", dir, name, `probe ${kind}\n`, 0o640);
    expect(file).toBe(path.join(dir, name));
    made.push(file!);
    expect(stat(file!)).toBe("bothost:bots:640");
    // box can read it: git hash-object reads the file as box
    expect(asBoxGit("hash-object", file!).trim()).toMatch(/^[0-9a-f]{40}$/);
    // box can't create anything there
    expect(() => asBoxGit("init", "-q", path.join(dir, `boxprobe-${process.pid}`))).toThrow();
    expect(fs.existsSync(path.join(dir, `boxprobe-${process.pid}`))).toBe(false);
  });

  it("refuses a box-owned component, and a parent swap at open time leaves nothing outside (/proc/self/fd check)", () => {
    const root = fs.mkdtempSync("/workspace/.secfix3-box-");
    made.push(root);
    fs.chmodSync(root, 0o2775);
    // a box-owned directory in the chain (git init as box creates it)
    asBoxGit("init", "-q", path.join(root, "boxdir"));
    expect(writeHostOwnedFile(root, path.join(root, "boxdir", "x"), "a.txt", "hi", 0o640)).toBeNull();
    // the swap: after the checks, .host-out is renamed away and replaced by a tree whose uploads is a link
    const outside = fs.mkdtempSync("/tmp/secfix3-outside-");
    made.push(outside);
    const target = path.join(root, ".host-out", "uploads", "a.txt");
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === target) {
        fs.renameSync(path.join(root, ".host-out"), path.join(root, ".host-out.old"));
        fs.mkdirSync(path.join(root, ".host-out"));
        fs.symlinkSync(outside, path.join(root, ".host-out", "uploads"));
      }
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    expect(writeHostOwnedFile(root, path.join(root, ".host-out", "uploads"), "a.txt", "SECRET", 0o640)).toBeNull();
    vi.restoreAllMocks();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
