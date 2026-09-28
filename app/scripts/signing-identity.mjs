#!/usr/bin/env node
// Bug 99: a STABLE local code-signing identity, so macOS permissions (Microphone, Speech
// Recognition) and keychain "Always Allow" answers survive a rebuild.
//
// An ad-hoc signature's designated requirement is a bare cdhash — a new code identity every build,
// so TCC and the keychain forget every grant on every install. Signed with one self-signed
// certificate the requirement becomes `identifier "com.nyfeblade.synapse" and certificate leaf =
// H"<cert hash>"`, identical for every build made on this Mac.
//
//   node scripts/signing-identity.mjs ensure [--new-identity]   print the hash; create "Synapse Local Signing" only with --new-identity
//   node scripts/signing-identity.mjs show     print the identity's hash, or nothing (exit 1) if absent
//
// It touches exactly ONE keychain item set: the certificate + private key it creates in the login
// keychain, named "Synapse Local Signing". It never modifies, trusts or deletes anything else. No
// trust setting is needed — codesign signs with an untrusted self-signed identity, and the
// designated requirement pins the certificate's own hash rather than a trust chain.
// See docs/release.md → "Local signing identity".
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IDENTITY_NAME = "Synapse Local Signing";
const LOGIN_KEYCHAIN = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
// macOS's own LibreSSL writes PKCS#12 files `security import` reads without a -legacy switch.
const OPENSSL = "/usr/bin/openssl";

/**
 * The SHA-1 of the code-signing identity called `name` in `security find-identity -p codesigning`
 * output, or null. Valid-or-not both count (a self-signed certificate is listed as untrusted and
 * still signs); the "Valid identities only" section repeats entries, so the first match wins.
 */
export function parseIdentityHash(findIdentityOutput, name = IDENTITY_NAME) {
  for (const line of String(findIdentityOutput).split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"/.exec(line);
    if (m && m[2] === name) return m[1].toUpperCase();
  }
  return null;
}

/** The identity's hash, or null when this Mac has none (CI, a fresh machine). Never throws. */
export function findIdentity(name = IDENTITY_NAME) {
  const r = spawnSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
  return r.status === 0 ? parseIdentityHash(r.stdout, name) : null;
}

/** Create the identity if it is missing; return its hash. Non-interactive. */
export function ensureIdentity(name = IDENTITY_NAME) {
  const existing = findIdentity(name);
  if (existing) return existing;
  if (!fs.existsSync(LOGIN_KEYCHAIN)) throw new Error(`signing-identity: no login keychain at ${LOGIN_KEYCHAIN}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-signing-"));
  fs.chmodSync(tmp, 0o700);
  const key = path.join(tmp, "key.pem");
  const cert = path.join(tmp, "cert.pem");
  const p12 = path.join(tmp, "identity.p12");
  // A one-time password for the temporary .p12 only; the file is deleted below.
  const pass = crypto.randomBytes(18).toString("base64url");
  try {
    execFileSync(OPENSSL, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-keyout", key, "-out", cert, "-subj", `/CN=${name}`,
      "-addext", "basicConstraints=critical,CA:false",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=critical,codeSigning",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    execFileSync(OPENSSL, ["pkcs12", "-export", "-inkey", key, "-in", cert, "-name", name, "-out", p12, "-passout", `pass:${pass}`], { stdio: ["ignore", "ignore", "pipe"] });
    // -T /usr/bin/codesign: the private key's ACL lets codesign use it without asking.
    execFileSync("security", ["import", p12, "-k", LOGIN_KEYCHAIN, "-f", "pkcs12", "-P", pass, "-T", "/usr/bin/codesign"], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const made = findIdentity(name);
  if (!made) throw new Error(`signing-identity: imported "${name}" but codesign cannot see it as an identity`);
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? "show";
  // Portable install: a second Mac that ran `ensure` used to mint its OWN certificate silently — a new code
  // identity, so every build from it would be refused as an update and lose every permission. Creating one
  // is now a deliberate act.
  if (cmd === "ensure" && !process.argv.includes("--new-identity") && !findIdentity()) {
    console.error(`signing-identity: this Mac has no "${IDENTITY_NAME}". Import the one your builds are signed with, or pass --new-identity to create a new one (installed copies will not accept its builds as updates).`);
    process.exit(1);
  }
  if (cmd === "ensure") console.log(ensureIdentity());
  else if (cmd === "show") {
    const h = findIdentity();
    if (!h) process.exit(1);
    console.log(h);
  } else {
    console.error("usage: signing-identity.mjs ensure|show");
    process.exit(2);
  }
}
