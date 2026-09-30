import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { SCRIPT_READ_CAP, evaluateFixedRules } from "@synapse/shared";
import { readScriptCapped } from "../../src/coordinator/local-exec/script-read";

// Bug 431: the Mac gate reads the script a command runs, capped, regular files only, symlinks resolved.
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-script-read-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string | Buffer): string => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

describe("readScriptCapped (bug 431)", () => {
  it("reads a regular file", () => expect(readScriptCapped(put("a.sh", "orb list\n"))).toBe("orb list\n"));
  it("follows a symlink to the file it names", () => {
    const target = put("real.sh", "orbctl status\n");
    fs.symlinkSync(target, path.join(dir, "link.sh"));
    expect(readScriptCapped(path.join(dir, "link.sh"))).toBe("orbctl status\n");
  });
  it("reads a file at the cap, not one over it", () => {
    expect(readScriptCapped(put("at.sh", Buffer.alloc(SCRIPT_READ_CAP, 0x61)))?.length).toBe(SCRIPT_READ_CAP);
    expect(readScriptCapped(put("over.sh", Buffer.alloc(SCRIPT_READ_CAP + 1, 0x61)))).toBeNull();
  });
  it("won't read a directory, a FIFO (without blocking) or a missing file", () => {
    fs.mkdirSync(path.join(dir, "d.sh"));
    expect(readScriptCapped(path.join(dir, "d.sh"))).toBeNull();
    execFileSync("mkfifo", [path.join(dir, "pipe.sh")]);
    expect(readScriptCapped(path.join(dir, "pipe.sh"))).toBeNull();
    expect(readScriptCapped(path.join(dir, "nope.sh"))).toBeNull();
  });
  it("end to end: the Mac gate refuses a script that runs OrbStack, and leaves one about orbits", () => {
    put("bad.sh", "#!/bin/zsh\norb -m box -u root id\n");
    put("fine.sh", "#!/bin/zsh\necho orbit\n");
    const ctx = { home: os.homedir(), projectDirs: [dir], readScript: readScriptCapped };
    expect(evaluateFixedRules({ side: "mac", kind: "command", command: "bash bad.sh", cwd: dir }, ctx).rule).toBe("never.orbstack");
    expect(evaluateFixedRules({ side: "mac", kind: "command", command: "./fine.sh", cwd: dir }, ctx).verdict).not.toBe("never");
  });
});
