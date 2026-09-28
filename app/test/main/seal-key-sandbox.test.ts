/**
 * Bug 279 on the public build: the key file that seals the app's secrets (`<userData>/keys/seal.key`) and the
 * byte-for-byte archive of the old keychain-sealed files (`<userData>/keychain-sealed-backup/`) live in the app's own
 * data folder, which the Mac command sandbox read- and write-denies in every mode (No limits included).
 * Temp dirs only: stand-in files, never the real profile or the keychain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { SEAL_KEY_DIR, SEAL_KEY_FILE } from "../../src/main/file-key-store";
import { KEYCHAIN_ARCHIVE_DIR } from "../../src/main/sealing";

let home: string;
let userData: string;
let keyFile: string;
let archived: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sks-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse", "profiles", "default");
  keyFile = path.join(userData, SEAL_KEY_DIR, SEAL_KEY_FILE);
  archived = path.join(userData, KEYCHAIN_ARCHIVE_DIR, "secrets.vault.json");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(archived), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, "STAND-IN-SEAL-KEY", { mode: 0o600 });
  fs.writeFileSync(archived, "STAND-IN-ARCHIVE", { mode: 0o600 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the seal key and the keychain archive are in the sandbox's denied data folder", () => {
  it.each([{}, { handoffLite: true }, { noLimits: true }])("profile %j denies the data folder", (opts) => {
    const p = ownDataSandboxProfile(userData, home, opts);
    // Bug 288: the whole data root (…/Synapse), not only the profile in it.
    expect(p).toContain(`(deny file-read* file-write* (subpath "${path.dirname(path.dirname(userData))}")`);
    expect(keyFile.startsWith(userData + path.sep)).toBe(true);
    expect(archived.startsWith(userData + path.sep)).toBe(true);
  });

  // The static wall refuses a command that names the data folder, so the path is built at runtime (python) to reach
  // the kernel-level sandbox deny underneath it.
  it.runIf(process.platform === "darwin")("live: a wrapped command can't read either, even with the path hidden from the static wall", async () => {
    const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
    const out: string[] = [];
    // The script sits in the work folder; it only builds the data-folder paths when it runs.
    const script = path.join(home, "probe.py");
    fs.writeFileSync(path.join(home, "control.txt"), "readable");
    const rel = (f: string) => JSON.stringify(path.relative(home, f).split("").reverse().join(""));
    fs.writeFileSync(script, [
      "import os",
      `for r in [${rel(keyFile)}, ${rel(archived)}]:`,
      `  f = os.path.join(${JSON.stringify(home)}, r[::-1])`,
      "  try: print('READ', open(f, 'rb').read())",
      "  except Exception as e: print('DENIED', type(e).__name__)",
      "print('CONTROL', open(os.path.join(" + JSON.stringify(home) + ", 'control.txt')).read())",
      "print('done')",
    ].join("\n"));
    await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command: "python3 probe.py", cwd: home }, { output: (_s, c) => out.push(c) });
    const text = out.join("");
    expect(text).toContain("CONTROL readable"); // the same read works outside the data folder
    expect(text).toContain("done");
    expect(text.match(/DENIED PermissionError/g)?.length).toBe(2);
    expect(text).not.toContain("STAND-IN-SEAL-KEY");
    expect(text).not.toContain("STAND-IN-ARCHIVE");
  });
});
