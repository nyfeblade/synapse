import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORB_CANDIDATES, isExecutableFile, orbCandidates, resolveOrb } from "../../src/main/orb-path";

const repo = path.resolve(__dirname, "../../..");
const boxDir = path.join(repo, "box");

// Controller ruling (2026-09-19): /usr/local/bin/orb can be a symlink into a mounted OrbStack
// installer DMG, which breaks on eject. The app bundle's own CLI comes first, then /usr/local/bin, then PATH.
describe("resolveOrb", () => {
  it("prefers OrbStack.app's bundled CLI (either Applications folder), then /usr/local/bin, Homebrew, ~/.orbstack, then PATH", () => {
    expect(orbCandidates("/Users/x")).toEqual([
      "/Applications/OrbStack.app/Contents/MacOS/bin/orb", "/Users/x/Applications/OrbStack.app/Contents/MacOS/bin/orb",
      "/usr/local/bin/orb", "/opt/homebrew/bin/orb", "/Users/x/.orbstack/bin/orb",
    ]);
    expect(ORB_CANDIDATES).toEqual(orbCandidates(os.homedir()));
    expect(resolveOrb(() => true)).toBe("/Applications/OrbStack.app/Contents/MacOS/bin/orb");
    expect(resolveOrb((p) => p === "/usr/local/bin/orb")).toBe("/usr/local/bin/orb");
    expect(resolveOrb((p) => p === path.join(os.homedir(), ".orbstack/bin/orb"))).toBe(path.join(os.homedir(), ".orbstack/bin/orb"));
    expect(resolveOrb(() => false)).toBe("orb");
  });

  it("treats a dangling symlink (ejected DMG) as missing", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "orbp-"));
    const link = path.join(d, "orb");
    fs.symlinkSync(path.join(d, "Volumes-OrbStack-gone", "orb"), link);
    expect(isExecutableFile(link)).toBe(false);
    const real = path.join(d, "real-orb");
    fs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    expect(isExecutableFile(real)).toBe(true);
  });

  it("box/orb.sh (sourced by every box script the app runs) lists the same candidates in the same order", () => {
    const sh = fs.readFileSync(path.join(boxDir, "orb.sh"), "utf8");
    const loop = /for _orb in ([^;]+);/.exec(sh);
    expect(loop?.[1]?.trim().split(/\s+/).map((w) => w.replace("$HOME", "/Users/x"))).toEqual(orbCandidates("/Users/x"));
  });

  it("box/orb.sh honours an ORB the app passes in and wraps `orb` for subshells", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "orbsh-"));
    const fake = path.join(d, "fake-orb");
    fs.writeFileSync(fake, "#!/bin/sh\necho \"fake $*\"\n", { mode: 0o755 });
    const r = spawnSync("bash", ["-c", `source "${boxDir}/orb.sh"; orb list; bash -c 'orb -m "$BOX_MACHINE" true'`], { encoding: "utf8", env: { ...process.env, ORB: fake } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("fake list\nfake -m box true\n");
  });

  it("every box script that calls orb resolves it through box/orb.sh", () => {
    for (const f of fs.readdirSync(boxDir).filter((n) => n.endsWith(".sh") && n !== "orb.sh")) {
      const src = fs.readFileSync(path.join(boxDir, f), "utf8");
      const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      if (!/(^|[\s|;(&`$"'])orb\s+(-m|list|start|restart|delete|create)\b/.test(code)) continue;
      expect(code, f).toMatch(/source "\$(ROOT|HERE)\/orb\.sh"|source "\$\(dirname "\$0"\)\/orb\.sh"/);
    }
  });
});
