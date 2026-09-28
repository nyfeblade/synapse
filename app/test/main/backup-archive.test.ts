import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveRecords, decryptArchive, keyId, newBackupKey, parseRecoveryCode, readArchiveHeader, recoveryCode, writeArchive } from "../../src/main/backup/archive";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "synbak-"));
async function* recs() {
  yield { p: "manifest.json", data: Buffer.from("{\"kind\":\"synapse-backup\"}") };
  yield { p: "mac/app-settings.json", data: Buffer.from("{\"theme\":\"dark\"}"), m: 0o600 };
}

describe("backup archive", () => {
  it("round-trips through AES-256-GCM; the file holds no plaintext", async () => {
    const d = tmp();
    const key = newBackupKey();
    const file = path.join(d, "a.synbak");
    await writeArchive(file, key, recs(), { createdAt: 42, appVersion: "0.1.0" });
    const raw = fs.readFileSync(file);
    expect(raw.subarray(0, 8).toString()).toBe("SYNBAK01");
    expect(raw.includes(Buffer.from("theme"))).toBe(false);
    expect(readArchiveHeader(file)).toMatchObject({ v: 1, keyId: keyId(key), createdAt: 42, appVersion: "0.1.0" });
    const plain = path.join(d, "p.gz");
    await decryptArchive(file, key, plain);
    const got: string[] = [];
    for await (const r of archiveRecords(plain)) got.push(`${r.meta.p}=${r.data.toString()}`);
    expect(got).toEqual(["manifest.json={\"kind\":\"synapse-backup\"}", "mac/app-settings.json={\"theme\":\"dark\"}"]);
  });

  it("refuses the wrong key and a tampered file, and leaves no plaintext behind", async () => {
    const d = tmp();
    const key = newBackupKey();
    const file = path.join(d, "a.synbak");
    await writeArchive(file, key, recs(), { createdAt: 1, appVersion: "0.1.0" });
    await expect(decryptArchive(file, newBackupKey(), path.join(d, "x.gz"))).rejects.toThrow(/recovery code|key/i);
    const raw = fs.readFileSync(file);
    raw[raw.length - 20] ^= 1;
    fs.writeFileSync(file, raw);
    await expect(decryptArchive(file, key, path.join(d, "y.gz"))).rejects.toThrow(/damaged/i);
    expect(fs.existsSync(path.join(d, "y.gz"))).toBe(false);
  });

  it("the recovery code is the key, grouped, and survives spaces, case and dashes", () => {
    const key = newBackupKey();
    const code = recoveryCode(key);
    expect(code).toMatch(/^SYN(-[A-Z2-7]{4}){13}$/);
    expect(parseRecoveryCode(code)!.equals(key)).toBe(true);
    expect(parseRecoveryCode(` ${code.toLowerCase().replace(/-/g, " ")} `)!.equals(key)).toBe(true);
    expect(parseRecoveryCode("SYN-AAAA")).toBeNull();
  });
});
