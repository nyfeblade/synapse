import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Bug-log 279: secrets are sealed with the profile's key file, not the keychain. safeStorage is mocked so the tests
// can prove it is NEVER reached: not before the gate opens, and not after, on a retired (or fresh) profile.
const touches: string[] = [];
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => { touches.push("isEncryptionAvailable"); return true; },
    encryptString: (s: string) => { touches.push("encryptString"); return Buffer.from(s, "utf8"); },
    decryptString: (b: Buffer) => { touches.push("decryptString"); return b.toString("utf8"); },
  },
}));

import { FileKeyStore, isFileSealed } from "../../src/main/file-key-store";
import { openSealing, prepareSealing, sealer } from "../../src/main/sealing";
import { readSecret, storeSecret } from "../../src/main/secrets";

const made: string[] = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bots-secrets-")); made.push(d); return d; };
afterAll(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// The packaged app once hung on the main thread inside its very first safeStorage call, which ran before
// `win.loadFile()`. These run before the gate is opened, so they prove nothing is sealed or read yet.
describe("secrets before the gate opens (the shipped hang)", () => {
  it("reads nothing and writes nothing", () => {
    const d = dir();
    expect(sealer.state().status).toBe("pending");
    storeSecret(d, "updateToken", "ghp_never_written");
    expect(readSecret(d, "updateToken")).toBeNull();
    expect(fs.existsSync(path.join(d, "secrets"))).toBe(false);
    expect(touches).toEqual([]);
  });
});

describe("secrets on the profile's key file", () => {
  const profile = dir();
  beforeAll(async () => {
    const mode = prepareSealing(profile, { appendSwitch: () => {} });
    const { openLegacyKeychain } = await import("../../src/main/keychain");
    await openSealing({ gate: sealer, mode, profileDir: profile, files: new FileKeyStore(profile), legacy: () => openLegacyKeychain({ exe: "/nonexistent/never-run", env: {}, exec: ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, "SYNAPSE_KEYCHAIN_PROBE_RESULT {\"verdict\":\"blocked\"}\n")) as never }), log: () => {} });
  });

  it("returns null for a name that was never stored", () => {
    expect(readSecret(profile, "never")).toBeNull();
  });

  it("round-trips a value written by storeSecret, sealed by the key file, 0600", () => {
    storeSecret(profile, "updateToken", "ghp_abc123");
    expect(readSecret(profile, "updateToken")).toBe("ghp_abc123");
    const f = path.join(profile, "secrets", "updateToken.bin");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(isFileSealed(fs.readFileSync(f))).toBe(true);
  });

  it("a value it can't unseal reads as missing, not as a crash", () => {
    fs.writeFileSync(path.join(profile, "secrets", "old.bin"), Buffer.from("v10-keychain-sealed"), { mode: 0o600 });
    expect(readSecret(profile, "old")).toBeNull();
  });

  it("never touched safeStorage (the keychain) at all", () => {
    expect(touches).toEqual([]);
  });
});
