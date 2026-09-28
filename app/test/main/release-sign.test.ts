import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../scripts/release-sign.mjs");
const realPubFile = path.resolve(__dirname, "../../src/main/native/update-public-key.ts");

/** A sandbox: a key path and a copy of update-public-key.ts, both in a temp dir. Never the real key. */
function sandbox(pinned: "real" | "none" = "none") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const pubFile = path.join(d, "update-public-key.ts");
  fs.writeFileSync(pubFile, pinned === "real" ? fs.readFileSync(realPubFile, "utf8") : "export const UPDATE_PUBLIC_KEY: string | null = null;\n");
  const keyFile = path.join(d, "Synapse-release", "update-signing.key");
  const env = { ...process.env, SYNAPSE_UPDATE_KEY: keyFile, SYNAPSE_UPDATE_PUBKEY_FILE: pubFile };
  const run = (...a: string[]) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8", env });
  const zip = path.join(d, "Synapse-0.3.0-arm64.zip");
  fs.writeFileSync(zip, "zip");
  return { d, pubFile, keyFile, run, zip };
}

describe("release-sign.mjs: the update-signing key lives in a file outside the repo", () => {
  it("defaults to ~/Library/Application Support/Synapse-release/update-signing.key", async () => {
    const m = (await import(script)) as { DEFAULT_KEY_PATH: string };
    expect(m.DEFAULT_KEY_PATH).toBe(path.join(os.homedir(), "Library", "Application Support", "Synapse-release", "update-signing.key"));
    expect(path.relative(path.resolve(__dirname, "../../.."), m.DEFAULT_KEY_PATH).startsWith("..")).toBe(true);
  });

  it("signs and verifies with a throwaway in-memory keypair", () => {
    const r = sandbox().run("selftest");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("selftest ok");
  });

  it("keygen writes the private key with mode 0600 (folder 0700), pins the public key, and never prints the private key", () => {
    const b = sandbox();
    const r = b.run("keygen");
    expect(r.status, r.stderr).toBe(0);
    expect((fs.statSync(b.keyFile).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.dirname(b.keyFile)).mode & 0o777).toString(8)).toBe("700");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/PRIVATE KEY/);
    const priv = crypto.createPrivateKey(fs.readFileSync(b.keyFile, "utf8"));
    expect(priv.asymmetricKeyType).toBe("ed25519");
    const pinned = /`([^`]+)`/.exec(fs.readFileSync(b.pubFile, "utf8"))![1]!;
    expect(crypto.createPublicKey(priv).export({ type: "spki", format: "pem" }).toString().trim()).toBe(pinned.trim());
    expect(fs.readFileSync(b.pubFile, "utf8")).not.toMatch(/PRIVATE KEY/);
  });

  it("keygen refuses to replace an existing key", () => {
    const b = sandbox();
    expect(b.run("keygen").status).toBe(0);
    const before = fs.readFileSync(b.keyFile, "utf8");
    const r = b.run("keygen");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(fs.readFileSync(b.keyFile, "utf8")).toBe(before);
  });

  it("sign writes <zip>.sig that verifies; a tampered zip then fails verify", () => {
    const b = sandbox();
    b.run("keygen");
    const r = b.run("sign", b.zip);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(`${b.zip}.sig`, "utf8").trim()).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(b.run("verify", b.zip).status).toBe(0);
    fs.writeFileSync(b.zip, "tampered");
    const v = b.run("verify", b.zip);
    expect(v.status).toBe(1);
    expect(v.stderr).toMatch(/does NOT verify/);
  });

  it("refuses to sign with a key file other users can read", () => {
    const b = sandbox();
    b.run("keygen");
    fs.chmodSync(b.keyFile, 0o644);
    const r = b.run("sign", b.zip);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/chmod 600/);
    expect(fs.existsSync(`${b.zip}.sig`)).toBe(false);
  });

  it("with no key file, sign refuses and says how to make one", () => {
    const b = sandbox("real");
    const r = b.run("sign", b.zip);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/keygen/);
  });

  it("check: a key that doesn't match the embedded public key is refused (the app would reject every release)", () => {
    const b = sandbox();
    b.run("keygen");
    expect(b.run("check").status).toBe(0);
    fs.writeFileSync(b.pubFile, fs.readFileSync(realPubFile, "utf8"));
    const r = b.run("check");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/doesn't match/);
  });

  it("final secfix 11: signs \"name|version|sha256\" (what the updater verifies), version taken from the zip name", async () => {
    const m = (await import(script)) as { releaseMessage(zip: string, version: string, sha: string): Buffer; versionOf(zip: string): string | null; signBytes(b: Buffer, pem: string): string };
    const sha = "ab".repeat(32);
    expect(m.releaseMessage("/x/dist-release/Synapse-0.3.0-arm64.zip", "0.3.0", sha).toString("utf8")).toBe(`Synapse-0.3.0-arm64.zip|0.3.0|${sha}`);
    expect(m.versionOf("/x/Synapse-1.12.3-arm64.zip")).toBe("1.12.3");
    expect(m.versionOf("/x/evil.zip")).toBeNull();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const sig = m.signBytes(m.releaseMessage("Synapse-0.3.0-arm64.zip", "0.3.0", sha), privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    expect(crypto.verify(null, Buffer.from(`Synapse-0.3.0-arm64.zip|0.3.0|${sha}`), publicKey, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("the private key is never in the repo, and .gitignore covers it", () => {
    const gi = fs.readFileSync(path.resolve(__dirname, "../../../.gitignore"), "utf8");
    expect(gi).toMatch(/^update-signing\.key$/m);
    expect(gi).toMatch(/^\*\.key$/m);
  });
});
