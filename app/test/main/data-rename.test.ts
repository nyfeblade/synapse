/**
 * Bug 289: the public build is Synapse and has never shipped under another name, so a folder called
 * ~/Library/Application Support/Bots (or ~/Library/Logs/Bots) is never its own data: on a Mac that has it, it belongs
 * to a different build of the app. The public build never moves, merges or reads it (bug 285 moved it on the first
 * launch, which took the other build's whole data folder, keys and box pin included). Its data is always …/Synapse.
 * e2e and packaged runs point the app's data at a temp folder (SYNAPSE_APP_DATA), so a test never opens the real one.
 * Temp dirs only: stand-in profiles, never the real ~/Library or the keychain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_DATA_NAME, LEGACY_APP_DATA_NAME, resolveDataRoot } from "../../src/main/data-rename";
import * as dataRename from "../../src/main/data-rename";
import { configureProfile } from "../../src/main/profile";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
/** A stand-in ~/Library/Application Support. */
function appData(): string {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-rename-")));
  made.push(home);
  const d = path.join(home, "Library", "Application Support");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const oldRoot = (a: string) => path.join(a, LEGACY_APP_DATA_NAME);
const newRoot = (a: string) => path.join(a, APP_DATA_NAME);
const write = (f: string, s: string, mode = 0o600) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, s, { mode }); };
function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (x: string) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(d, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(d);
  return out;
}
/** Another build's data folder: a profile with its key file, vault, box pin and policy key, plus shared folders. */
function otherBuild(a: string): Record<string, string> {
  const p = path.join(oldRoot(a), "profiles", "default");
  write(path.join(p, "keys", "seal.key"), "OTHER-BUILD-SEAL-KEY");
  write(path.join(p, "secrets.vault.json"), "OTHER-BUILD-VAULT");
  write(path.join(p, "box-pin.json"), "OTHER-BUILD-BOX-PIN");
  write(path.join(p, "local-policy.key"), "OTHER-BUILD-POLICY-KEY");
  write(path.join(oldRoot(a), "backups", "b.tar"), "OTHER-BUILD-BACKUP");
  write(path.join(oldRoot(a), "qwen", "model.bin"), "weights", 0o644);
  return snapshot(oldRoot(a));
}

describe("a …/Bots folder is another build's: the public build never touches it", () => {
  it("with no …/Synapse yet: the data is …/Synapse, and …/Bots is untouched, byte for byte", () => {
    const a = appData();
    const before = otherBuild(a);
    const r = resolveDataRoot(a, "default");
    expect(r.root).toBe(newRoot(a));
    expect(r.state).toBe("current");
    expect(snapshot(oldRoot(a))).toEqual(before);
    expect(fs.existsSync(path.join(newRoot(a), "profiles", "default", "keys"))).toBe(false);
  });

  it("with both: nothing is merged either way", () => {
    const a = appData();
    const before = otherBuild(a);
    write(path.join(newRoot(a), "profiles", "default", "app-settings.json"), "{}");
    expect(resolveDataRoot(a, "default").root).toBe(newRoot(a));
    expect(snapshot(oldRoot(a))).toEqual(before);
    expect(Object.keys(snapshot(newRoot(a)))).toEqual([path.join("profiles", "default", "app-settings.json")]);
  });

  it("a live SingletonLock planted in …/Bots/profiles/<any> never switches the data to …/Bots", () => {
    const a = appData();
    otherBuild(a);
    fs.mkdirSync(path.join(oldRoot(a), "profiles", "x"), { recursive: true });
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(oldRoot(a), "profiles", "x", "SingletonLock"));
    expect(resolveDataRoot(a, "default").root).toBe(newRoot(a));
  });

  it("there is no move of the log folder any more", () => {
    expect((dataRename as Record<string, unknown>).moveLogsDir).toBeUndefined();
    const index = fs.readFileSync(path.join(__dirname, "../../src/main/index.ts"), "utf8");
    expect(index).not.toMatch(/moveLogsDir/);
  });
});

describe("configureProfile", () => {
  const fakeApp = (a: string, set: Record<string, string>) => ({
    getPath: () => a,
    setPath: (n: string, p: string) => { set[n] = p; },
    setName: (n: string) => { set.name = n; },
  });
  it("names the app Synapse and points userData at …/Synapse/profiles/<profile>, with …/Bots left alone", () => {
    const a = appData();
    const before = otherBuild(a);
    const set: Record<string, string> = {};
    const dir = configureProfile(fakeApp(a, set), {});
    expect(set.name).toBe("Synapse");
    expect(dir).toBe(path.join(newRoot(a), "profiles", "default"));
    expect(set.userData).toBe(dir);
    expect(snapshot(oldRoot(a))).toEqual(before);
  });

  it("SYNAPSE_APP_DATA (an absolute path) replaces the app-data folder: e2e and packaged runs never open the real one", () => {
    const real = appData();
    const tmp = appData();
    const set: Record<string, string> = {};
    const dir = configureProfile(fakeApp(real, set), { SYNAPSE_APP_DATA: tmp, APP_PROFILE: "e2e" });
    expect(set.appData).toBe(tmp);
    expect(dir).toBe(path.join(tmp, "Synapse", "profiles", "e2e"));
    expect(fs.readdirSync(real)).toEqual([]);
    const set2: Record<string, string> = {};
    expect(configureProfile(fakeApp(real, set2), { SYNAPSE_APP_DATA: "relative/dir" })).toBe(path.join(real, "Synapse", "profiles", "default"));
  });

  it.each(["playwright.config.ts", "packaged.config.ts"])("the e2e config %s points the app's data at a temp folder", (f) => {
    const cfg = fs.readFileSync(path.join(__dirname, "../../e2e", f), "utf8");
    expect(cfg).toMatch(/globalSetup/);
    const setup = fs.readFileSync(path.join(__dirname, "../../e2e/isolated-app-data.ts"), "utf8");
    expect(setup).toMatch(/SYNAPSE_APP_DATA/);
    expect(setup).toMatch(/mkdtemp/);
  });
});
