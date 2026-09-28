import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileKeyStore, SEAL_KEY_DIR, SEAL_KEY_FILE, SEAL_PREFIX, isFileSealed } from "../../src/main/file-key-store";

/**
 * Keychain retired (2026-09-26): the app's sealing key is a random 32-byte file in its own data folder,
 * AES-256-GCM, never the macOS keychain. Temp dirs only; nothing here reaches the real keychain or ~/Library.
 */
const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bots-filekey-")); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const keyPath = (d: string) => path.join(d, SEAL_KEY_DIR, SEAL_KEY_FILE);
/** A store allowed to make its key (the app passes sealing.ts's guard; the default is to refuse). */
const keys = (d: string) => new FileKeyStore(d, { mayCreate: () => true });

describe("FileKeyStore: creating a key needs an explicit guard (re-review 5)", () => {
  it("with no guard it refuses to make a key, and makes nothing on disk", () => {
    const d = tmp();
    const s = new FileKeyStore(d);
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(s.problem()).toBe("missing");
    expect(() => s.encryptString("x")).toThrow();
    expect(fs.existsSync(path.join(d, SEAL_KEY_DIR))).toBe(false);
  });

  it("with no guard it still uses a key that is already there", () => {
    const d = tmp();
    const sealed = keys(d).encryptString("kept");
    expect(new FileKeyStore(d).decryptString(sealed)).toBe("kept");
    expect(new FileKeyStore(d).isEncryptionAvailable()).toBe(true);
  });
});

describe("FileKeyStore: seal and unseal", () => {
  it("round-trips, and the output carries the version prefix (never safeStorage's v10/v11)", () => {
    const s = keys(tmp());
    expect(s.isEncryptionAvailable()).toBe(true);
    const sealed = s.encryptString("ghp_round_trip");
    expect(sealed.subarray(0, SEAL_PREFIX.length).equals(SEAL_PREFIX)).toBe(true);
    expect(isFileSealed(sealed)).toBe(true);
    expect(isFileSealed(Buffer.from("v10whatever"))).toBe(false);
    expect(sealed.includes(Buffer.from("ghp_round_trip"))).toBe(false);
    expect(s.decryptString(sealed)).toBe("ghp_round_trip");
    expect(s.decryptString(s.encryptString(""))).toBe("");
  });

  it("uses a fresh IV every time", () => {
    const s = keys(tmp());
    expect(s.encryptString("same").equals(s.encryptString("same"))).toBe(false);
  });

  it("a second store over the same folder reads what the first sealed (the key persists)", () => {
    const d = tmp();
    const sealed = keys(d).encryptString("persist");
    expect(keys(d).decryptString(sealed)).toBe("persist");
  });

  it("detects tampering in any part, a missing prefix and a different key", () => {
    const d = tmp();
    const s = keys(d);
    const sealed = s.encryptString("do not tamper");
    for (let i = SEAL_PREFIX.length; i < sealed.length; i++) {
      const t = Buffer.from(sealed);
      t[i] = t[i]! ^ 0x01;
      expect(() => s.decryptString(t), `byte ${i}`).toThrow();
    }
    const badPrefix = Buffer.from(sealed);
    badPrefix[0] = badPrefix[0]! ^ 0x01;
    expect(() => s.decryptString(badPrefix)).toThrow();
    expect(() => s.decryptString(sealed.subarray(0, sealed.length - 1))).toThrow();
    expect(() => s.decryptString(Buffer.from("v10" + "x".repeat(40)))).toThrow();
    expect(() => new FileKeyStore(tmp()).decryptString(sealed)).toThrow();
  });
});

describe("FileKeyStore: the key file", () => {
  it("is 0600 in a 0700 folder, 32 bytes, and leaves no temp file behind", () => {
    const d = tmp();
    keys(d).encryptString("x");
    expect(fs.statSync(keyPath(d)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, SEAL_KEY_DIR)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(keyPath(d)).size).toBe(32);
    expect(fs.readdirSync(path.join(d, SEAL_KEY_DIR))).toEqual([SEAL_KEY_FILE]);
  });

  it("tightens an existing, too-open key folder to 0700", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, SEAL_KEY_DIR), { mode: 0o755 });
    fs.chmodSync(path.join(d, SEAL_KEY_DIR), 0o755);
    keys(d).encryptString("x");
    expect(fs.statSync(path.join(d, SEAL_KEY_DIR)).mode & 0o777).toBe(0o700);
  });

  it("never follows a symlinked key file: refuses it and leaves its target untouched", () => {
    const d = tmp();
    const elsewhere = path.join(tmp(), "target.key");
    fs.writeFileSync(elsewhere, Buffer.alloc(32, 7), { mode: 0o600 });
    fs.mkdirSync(path.join(d, SEAL_KEY_DIR), { mode: 0o700 });
    fs.symlinkSync(elsewhere, keyPath(d));
    const s = keys(d);
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(s.problem()).toBe("symlink");
    expect(() => s.encryptString("x")).toThrow();
    expect(fs.readFileSync(elsewhere).equals(Buffer.alloc(32, 7))).toBe(true);
    expect(fs.lstatSync(keyPath(d)).isSymbolicLink()).toBe(true);
  });

  it("never follows a symlinked key folder", () => {
    const d = tmp();
    const elsewhere = tmp();
    fs.symlinkSync(elsewhere, path.join(d, SEAL_KEY_DIR));
    const s = keys(d);
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a key readable by others, and never overwrites it", () => {
    const d = tmp();
    keys(d).encryptString("x");
    const before = fs.readFileSync(keyPath(d));
    fs.chmodSync(keyPath(d), 0o644);
    const s = keys(d);
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(s.problem()).toBe("permissions");
    expect(fs.readFileSync(keyPath(d)).equals(before)).toBe(true);
  });

  it("refuses a key of the wrong size", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, SEAL_KEY_DIR), { mode: 0o700 });
    fs.writeFileSync(keyPath(d), Buffer.alloc(8), { mode: 0o600 });
    expect(keys(d).isEncryptionAvailable()).toBe(false);
  });

  it("unsealing with no key file does not create one", () => {
    const d = tmp();
    expect(() => keys(d).decryptString(Buffer.concat([SEAL_PREFIX, Buffer.alloc(40)]))).toThrow();
    expect(fs.existsSync(keyPath(d))).toBe(false);
  });
});
