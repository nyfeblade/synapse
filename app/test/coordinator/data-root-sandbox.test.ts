/**
 * Bug 288: the command sandbox walled only the profile folder (…/Synapse/profiles/<p>), so renaming a folder above it
 * carried the key file out from under the deny (`mv …/Synapse/profiles …/px && cat …/px/default/keys/seal.key`), and
 * the rest of the shared data root (the voice engines the main process runs unsandboxed, backups, other profiles) was
 * writable. Now the whole data root, under both names, is read- and write-denied, and the folders above it can't be
 * renamed, in every mode (No limits included).
 * Live under sandbox-exec with the generated profile, in a temp home with stand-in files only; never the real
 * ~/Library, the real data folder or the keychain.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR5, evaluateFixedRules } from "@synapse/shared";
import { ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";

const ENGINES = ["qwen", "f5", "whisper/bin", "kokoro", "voices", "backups", "releases"];
let home: string;
let appSupport: string;
let root: string;
let userData: string;
const standIns: Record<string, string> = {};
function plant(rel: string, text: string): void {
  const f = path.join(appSupport, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, text, { mode: 0o600 });
  standIns[rel] = text;
}
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "drs-home-")));
  appSupport = path.join(home, "Library", "Application Support");
  root = path.join(appSupport, "Synapse");
  userData = path.join(root, "profiles", "default");
  plant("Synapse/profiles/default/keys/seal.key", "STAND-IN-SEAL-KEY");
  plant("Synapse/profiles/default/mac-anthropic-api-key.bin", "STAND-IN-API-KEY-COPY");
  plant("Synapse/profiles/other/keys/seal.key", "STAND-IN-OTHER-PROFILE-KEY");
  plant("Bots/profiles/default/keys/seal.key", "STAND-IN-OLD-NAME-KEY");
  for (const e of ENGINES) fs.mkdirSync(path.join(root, e), { recursive: true });
  fs.writeFileSync(path.join(home, "control.txt"), "CONTROL-READABLE");
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
function sandboxed(opts: object, script: string): string {
  const profile = ownDataSandboxProfile(userData, home, opts);
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8", timeout: 20_000 });
  return `${r.stdout}${r.stderr}`;
}
const leaked = (text: string): string[] => Object.values(standIns).filter((s) => text.includes(s));

const MODES = [{}, { handoffLite: true }, { noLimits: true }];
/** Each attack renames something above the key file, reads through the new name, then (tries to) put it back. */
const RENAMES: Array<[string, (a: string) => string]> = [
  ["the profiles folder", (a) => `mv ${q(`${a}/Synapse/profiles`)} ${q(`${a}/Synapse/px`)}; cat ${q(`${a}/Synapse/px/default/keys/seal.key`)} ${q(`${a}/Synapse/px/default/mac-anthropic-api-key.bin`)}`],
  ["the data root", (a) => `mv ${q(`${a}/Synapse`)} ${q(`${a}/Zx`)}; cat ${q(`${a}/Zx/profiles/default/keys/seal.key`)}`],
  ["the data root, other case", (a) => `mv ${q(`${a}/synapse`)} ${q(`${a}/Zy`)}; cat ${q(`${a}/Zy/profiles/default/keys/seal.key`)}`],
  ["the old-name root", (a) => `mv ${q(`${a}/Bots`)} ${q(`${a}/Zb`)}; cat ${q(`${a}/Zb/profiles/default/keys/seal.key`)}`],
  ["Application Support", (a) => `mv ${q(a)} ${q(`${a}-x`)}; cat ${q(`${a}-x/Synapse/profiles/default/keys/seal.key`)}`],
  ["~/Library", (a) => { const lib = path.dirname(a); return `mv ${q(lib)} ${q(`${lib}-x`)}; cat ${q(`${lib}-x/Application Support/Synapse/profiles/default/keys/seal.key`)}`; }],
  ["the profile, to outside", (a) => `mv ${q(`${a}/Synapse/profiles/default`)} ${q(`${path.dirname(path.dirname(a))}/pd`)}; cat ${q(`${path.dirname(path.dirname(a))}/pd/keys/seal.key`)}`],
];

describe.runIf(process.platform === "darwin")("live: nothing above the key file can be renamed from inside the sandbox", () => {
  describe.each(MODES)("mode %j", (opts) => {
    it.each(RENAMES)("renaming %s is refused and nothing is read", (_label, attack) => {
      const text = sandboxed(opts, `${attack(appSupport)}; cat ${q(path.join(home, "control.txt"))}; echo END`);
      expect(text).toContain("CONTROL-READABLE");
      expect(text).toContain("END");
      expect(leaked(text)).toEqual([]);
      for (const rel of Object.keys(standIns)) expect(fs.readFileSync(path.join(appSupport, rel), "utf8")).toBe(standIns[rel]);
    });

    it("another profile's key, the old-name folder and a hard link are unreadable", () => {
      const link = path.join(home, "hl");
      const text = sandboxed(opts, [
        `cat ${q(path.join(root, "profiles/other/keys/seal.key"))}`,
        `cat ${q(path.join(appSupport, "Bots/profiles/default/keys/seal.key"))}`,
        `ln ${q(path.join(userData, "keys/seal.key"))} ${q(link)}; cat ${q(link)}`,
        `cp -c ${q(path.join(userData, "keys/seal.key"))} ${q(`${link}2`)}; cat ${q(`${link}2`)}`,
        `ls ${q(root)}`,
        "echo END",
      ].join("; "));
      expect(text).toContain("END");
      expect(leaked(text)).toEqual([]);
      expect(text).not.toMatch(/\bprofiles\b[\s\S]*\bqwen\b/); // the root can't even be listed
    });

    it("everything else under ~/Library still works: mkdir -p, a new app folder, a cache", () => {
      const text = sandboxed(opts, `mkdir -p ${q(path.join(home, "Library/Caches/pip/x"))} && mkdir -p ${q(path.join(appSupport, "OtherApp/sub"))} && echo ok > ${q(path.join(appSupport, "OtherApp/sub/f"))} && echo MADE`);
      expect(text).toContain("MADE");
    });

    it("nothing can be planted in the shared engine folders, backups or releases", () => {
      const text = sandboxed(opts, [...ENGINES.map((e) => `echo PLANTED > ${q(path.join(root, e, "planted"))}`), `mkdir ${q(path.join(root, "profiles", "x"))}`, "echo END"].join("; "));
      expect(text).toContain("END");
      for (const e of ENGINES) expect(fs.existsSync(path.join(root, e, "planted"))).toBe(false);
      expect(fs.existsSync(path.join(root, "profiles", "x"))).toBe(false);
    });
  });
});

describe("the static wall names the data root, not only the profile", () => {
  const ctx = () => ({ home, projectDirs: [], userData, realpath: (p: string) => fs.realpathSync.native(p) });
  const verdict = (command: string) => evaluateFixedRules({ side: "mac", kind: "command", command, cwd: home }, ctx()).verdict;
  it.each([
    "mv ~/Library/Application\\ Support/Synapse/profiles ~/px",
    "mv ~/Library/Application\\ Support/Synapse ~/Zx",
    "mv \"$HOME/Library/Application Support/Bots\" /tmp/b",
    "ls ~/Library/Application\\ Support/Synapse/whisper/bin",
  ])("%s is NEVER", (c) => { expect(verdict(c)).toBe("never"); });
  it("a look-alike folder is not", () => { expect(verdict("ls ~/Library/Application\\ Support/SynapseSync")).not.toBe("never"); });
});

describe("an exempt tool's card says what running outside the sandbox gives it", () => {
  it("names the app's own keys", () => {
    expect(STR5.macOutsideSandbox("swift")).toMatch(/^swift runs outside this Mac's command sandbox/);
    expect(STR5.macOutsideSandbox("swift")).toMatch(/can read anything you can, Synapse's own keys included/);
  });
});
