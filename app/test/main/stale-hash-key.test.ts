// keychain-retirement follow-up: the migration can leave secrets.hashkey.bin sealed by an older build's
// keychain item (unreadable). With no saved secrets depending on it, it is archived and replaced, so
// adding a secret works; with saved secrets it is left alone and the app keeps saying so.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEAL_PREFIX } from "../../src/main/file-key-store";
import { KEYCHAIN_ARCHIVE_DIR, retireStaleHashKey } from "../../src/main/sealing";

const dirs: string[] = [];
function profile(hashKey: Buffer | null, vaultEntries: number | null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "stale-hash-"));
  dirs.push(d);
  if (hashKey) fs.writeFileSync(path.join(d, "secrets.hashkey.bin"), hashKey, { mode: 0o600 });
  if (vaultEntries !== null) fs.writeFileSync(path.join(d, "secrets.vault.json"), JSON.stringify({ version: 1, entries: Array.from({ length: vaultEntries }, (_, i) => ({ botId: "b", name: `N${i}` })) }));
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("a stale keychain-sealed hash key", () => {
  it("is archived and removed when no saved secret depends on it", () => {
    const legacy = Buffer.from("v10-legacy-keychain-sealed");
    for (const vault of [null, 0]) {
      const d = profile(legacy, vault);
      expect(retireStaleHashKey(d)).toBe(true);
      expect(fs.existsSync(path.join(d, "secrets.hashkey.bin"))).toBe(false);
      expect(fs.readFileSync(path.join(d, KEYCHAIN_ARCHIVE_DIR, "secrets.hashkey.bin")).equals(legacy)).toBe(true);
    }
  });

  it("is left alone when saved secrets depend on it", () => {
    const d = profile(Buffer.from("v10-legacy"), 2);
    expect(retireStaleHashKey(d)).toBe(false);
    expect(fs.existsSync(path.join(d, "secrets.hashkey.bin"))).toBe(true);
  });

  it("never touches a hash key sealed with the key file, or a missing one", () => {
    const d = profile(Buffer.concat([SEAL_PREFIX, Buffer.from("x".repeat(40))]), null);
    expect(retireStaleHashKey(d)).toBe(false);
    expect(fs.existsSync(path.join(d, "secrets.hashkey.bin"))).toBe(true);
    expect(retireStaleHashKey(profile(null, null))).toBe(false);
  });
});
