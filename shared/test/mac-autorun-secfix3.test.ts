import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { macAutoRunEligible, macRootAcceptable, type MacAutoRunContext } from "../src";

// Final secfix round 3, rulings 2 and 3. The review's proof scripts (t.ts, t2.ts, t3.ts) are replayed here against a
// real temp tree: <home>/P is the auto-run root, <home>/P/a/lnk → <home>/outside, <home>/P/-x → <home>/outside/key,
// and <home>/secret2 sits next to the root.
let home: string;
let P: string;
const rp = (x: string) => fs.realpathSync.native(x);
beforeAll(() => {
  home = rp(fs.mkdtempSync(path.join(os.tmpdir(), "sf3home-")));
  P = path.join(home, "P");
  fs.mkdirSync(path.join(P, "a"), { recursive: true });
  fs.mkdirSync(path.join(P, "b", "lnk"), { recursive: true });
  fs.mkdirSync(path.join(home, "outside"));
  fs.writeFileSync(path.join(home, "outside", "key"), "KEY");
  fs.writeFileSync(path.join(home, "secret2"), "SECRET2");
  fs.symlinkSync(path.join(home, "outside"), path.join(P, "a", "lnk"));
  fs.symlinkSync(path.join(home, "outside", "key"), path.join(P, "-x"));
  fs.writeFileSync(path.join(P, "x"), "x");
});
const cP = (): MacAutoRunContext => ({ home, root: P, roots: [P], realpath: rp });
const cH = (): MacAutoRunContext => ({ home, root: home, roots: [home], realpath: rp });
const run = (command: string, cwd?: string) => ({ op: "run-command", command, ...(cwd !== undefined ? { cwd } : {}) });

describe("secfix3 ruling 3: the t.ts probes", () => {
  it("recursive modes, find, grep -f, tail -f and a home or /Users root never auto-run", () => {
    const cases: [string, ReturnType<typeof run> | { op: string; path: string }, MacAutoRunContext][] = [
      ["home root grep -r", run("grep -r PRIVATE .", home), cH()],
      ["home root find", run("find . -name id_rsa", home), cH()],
      ["grep -r -S", run("grep -r -S SECRET a", P), cP()],
      ["grep -rS", run("grep -rS SECRET a", P), cP()],
      ["grep -R", run("grep -R SECRET a", P), cP()],
      ["grep -O", run("grep -O SECRET a", P), cP()],
      ["diff -r", run("diff -r a b", P), cP()],
      ["ls -RL", run("ls -RL a", P), cP()],
      ["ls -R", run("ls -R a", P), cP()],
      ["ls -L", run("ls -L a", P), cP()],
      ["grep -fx", run("grep -fx a", P), cP()],
      ["grep -f x", run("grep -f x a", P), cP()],
      ["grep -r . (dot files in root)", run("grep -r x .", P), cP()],
      ["users root", run("grep -r x alex", "/Users"), { home, root: home, roots: ["/Users"], realpath: rp }],
      ["tail -f", run("tail -f x", P), cP()],
      ["find -newer", run("find a -newer a", P), cP()],
      ["find -name", run("find . -name x", P), cP()],
      ["cat -- -x (a symlink named -x)", run("cat -- -x", P), cP()],
      ["head x -x (a flag-looking word after the first operand is a path)", run("head x -x", P), cP()],
      ["grep foo -r . (a permuted recursive flag)", run("grep foo -r .", P), cP()],
      ["cat -v x (not on cat's flag list)", run("cat -v x", P), cP()],
      ["head -c5 -fNAME", run("head -fNAME x", P), cP()],
    ];
    for (const [n, r, c] of cases) expect(macAutoRunEligible(r, c), n).toBe(false);
  });

  it("the per-program flag allowlist still lets ordinary reads auto-run", () => {
    for (const c of [
      "cat -n x", "cat -b x", "head -n 1 x", "head -n1 x", "tail -c 20 x", "ls -l -a -h -1 -t -S a", "ls -la a", "wc -l -w -c x",
      "grep -i -n -c -l -v -w -E -F foo x", "grep -e foo x", "grep -in foo x", "diff -u x x", "diff -q x x", "shasum x", "md5 x", "echo hi", "pwd", "date",
      "cat x -n",
    ]) expect(macAutoRunEligible(run(c, P), cP()), c).toBe(true);
  });
});

describe("secfix3 ruling 3: the t3.ts probes (a `..` segment is refused everywhere)", () => {
  it("in an argument, a file op's path and the cwd", () => {
    expect(macAutoRunEligible(run("cat a/lnk/../secret2", P), cP())).toBe(false);
    expect(macAutoRunEligible({ op: "read-file", path: "a/lnk/../secret2" }, cP())).toBe(false);
    expect(macAutoRunEligible(run("cat secret2", `${P}/a/lnk/..`), cP())).toBe(false);
    expect(macAutoRunEligible(run("cat ../P/x", P), cP())).toBe(false);
  });
});

describe("secfix3 ruling 2: the t2.ts probes (a root must be a strict subfolder of ~, or of /Volumes/<name>)", () => {
  it("~, its ancestors and the system folders are never roots", () => {
    for (const real of [home, path.dirname(home), "/Users", "/private", "/Applications", "/Volumes", "/opt", "/private/var", "/var", "/"]) {
      expect(macAutoRunEligible({ op: "list-directory", path: real }, { home, root: real, roots: [real], userData: null, realpath: rp }), real).toBe(false);
      expect(macRootAcceptable(real, { home }), real).toBe(false);
    }
  });

  it("macRootAcceptable: strict subfolders of ~ outside Library and dot-dirs, or /Volumes/<name>/<sub>", () => {
    const ok = [`${home}/Projects`, `${home}/Documents/work`, "/Volumes/Data/work", "/Volumes/Data/a/b"];
    const no = [
      home, `${home}/Library`, `${home}/Library/Mail`, `${home}/library/x`, `${home}/.ssh`, `${home}/.config/x`, `${home}/a/.git`, `${home}/a/.hidden/b`,
      "/Volumes/Data", "/Volumes", "/Users", "/Applications/x", "/opt/x", "/private/tmp/x", "/tmp/x", "/", `${home}/Projects/../..`, "relative/x",
      `${home}/Library/Application Support/Synapse/x`,
    ];
    for (const r of ok) expect(macRootAcceptable(r, { home }), r).toBe(true);
    for (const r of no) expect(macRootAcceptable(r, { home }), r).toBe(false);
    // a root that contains the app's data (only possible when userData sits outside ~/Library) is refused
    expect(macRootAcceptable(`${home}/Apps`, { home, userData: `${home}/Apps/Bots` })).toBe(false);
  });
});
