/**
 * Bug 285: the app's data folder is …/Synapse; an install from before the rename had it in …/Bots, and a move that
 * couldn't happen (or a clash) leaves data there. Every wall around the app's own data (the command sandbox's deny, the
 * static NEVER rule, the file tools' protected paths, the hand-off check) covers the folder under BOTH names, whichever
 * one this launch uses. Temp dirs and stand-in files only; never the real ~/Library or the keychain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDataDirs, evaluateFixedRules, macHandoffHighRisk } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";

let home: string;
let synapse: string;
let bots: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "drw-home-")));
  synapse = path.join(home, "Library", "Application Support", "Synapse", "profiles", "default");
  bots = path.join(home, "Library", "Application Support", "Bots", "profiles", "default");
  for (const d of [synapse, bots]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d, "computers.json"), "STAND-IN", { mode: 0o600 });
  }
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("appDataDirs", () => {
  it("is the data folder under both names, in the profiles layout or not; anything else is itself", () => {
    expect(appDataDirs(synapse)).toEqual([synapse, bots]);
    expect(appDataDirs(bots)).toEqual([bots, synapse]);
    expect(appDataDirs("/Users/x/Library/Application Support/Synapse")).toEqual(["/Users/x/Library/Application Support/Synapse", "/Users/x/Library/Application Support/Bots"]);
    expect(appDataDirs("/tmp/userdata")).toEqual(["/tmp/userdata"]);
    expect(appDataDirs("/Users/x/Library/Application Support/BotsSync/p")).toEqual(["/Users/x/Library/Application Support/BotsSync/p"]);
    expect(appDataDirs(null)).toEqual([]);
  });
});

describe.each([["the new folder", () => synapse, () => bots], ["the old folder (a move that couldn't happen)", () => bots, () => synapse]])(
  "userData is %s: the other name is walled too", (_label, used, other) => {
    it.each([{}, { handoffLite: true }, { noLimits: true }])("the sandbox profile %j denies reading and writing both", (opts) => {
      const p = ownDataSandboxProfile(used(), home, opts);
      // Bug 288: the whole data root under each name (…/Synapse, …/Bots), which holds the profile.
      const rootOf = (d: string) => path.dirname(path.dirname(d));
      expect(p).toContain(`(subpath "${rootOf(used())}")`);
      expect(p).toContain(`(subpath "${rootOf(other())}")`);
      expect(p).toMatch(new RegExp(`\\(deny file-read\\* file-write\\* [^\\n]*\\(subpath "${rootOf(other()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
    });

    it("the static wall: a command naming it, a read, a write are NEVER; a look-alike is not", () => {
      const ctx = { home, projectDirs: [], userData: used(), realpath: (p: string) => fs.realpathSync.native(p) };
      const cmd = (command: string) => evaluateFixedRules({ side: "mac", kind: "command", command, cwd: home }, ctx).verdict;
      expect(cmd(`ls "${other()}"`)).toBe("never");
      expect(cmd(`cat "${path.join(other(), "computers.json")}"`)).toBe("never");
      // Bug 288: the whole data root is walled, so a look-alike is a sibling of the root, not of the profile.
      expect(cmd(`ls "${path.dirname(path.dirname(other()))}Sync"`)).not.toBe("never");
      expect(evaluateFixedRules({ side: "mac", kind: "read", path: path.join(other(), "computers.json") }, ctx).verdict).toBe("never");
      expect(evaluateFixedRules({ side: "mac", kind: "write", path: path.join(other(), "x.json") }, ctx).verdict).toBe("never");
    });

    it("the hand-off check: opening a file in it is high risk", () => {
      expect(macHandoffHighRisk(`open "${path.join(other(), "computers.json")}"`, { home, userData: used() })).toMatch(/app's own data/);
    });

    it("the file tools refuse it, in any case", async () => {
      const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => used(), fullAccess: () => true });
      const io = { output: () => {} };
      await expect(ex.run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: path.join(other(), "computers.json"), content: "x" }, io)).rejects.toThrow(/protected/);
      await expect(ex.run({ execId: "r", botId: "b", approvalId: null, op: "read-file", path: path.join(other(), "computers.json").toUpperCase().replace(home.toUpperCase(), home) }, io)).rejects.toThrow(/protected/);
      expect(fs.readFileSync(path.join(other(), "computers.json"), "utf8")).toBe("STAND-IN");
    });
  });

describe("live: a wrapped command can't read the old folder either", () => {
  // The path is built at runtime (python) so only the kernel-level sandbox deny can stop it, not the static wall.
  it.runIf(process.platform === "darwin")("python reading …/Bots/profiles/default/computers.json is denied; a control file is read", async () => {
    const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => synapse, fullAccess: () => true });
    const out: string[] = [];
    fs.writeFileSync(path.join(home, "control.txt"), "readable");
    const rel = JSON.stringify(path.relative(home, path.join(bots, "computers.json")).split("").reverse().join(""));
    fs.writeFileSync(path.join(home, "probe.py"), [
      "import os",
      `f = os.path.join(${JSON.stringify(home)}, ${rel}[::-1])`,
      "try: print('READ', open(f).read())",
      "except Exception as e: print('DENIED', type(e).__name__)",
      `print('CONTROL', open(os.path.join(${JSON.stringify(home)}, 'control.txt')).read())`,
    ].join("\n"));
    await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command: "python3 probe.py", cwd: home }, { output: (_s, c) => out.push(c) });
    const text = out.join("");
    expect(text).toContain("CONTROL readable");
    expect(text).toContain("DENIED");
    expect(text).not.toContain("STAND-IN");
  });
});
