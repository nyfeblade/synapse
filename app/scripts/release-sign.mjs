#!/usr/bin/env node
// Release updates: the update-signing step. The Ed25519 PRIVATE key lives in ONE file outside the repo,
//   ~/Library/Application Support/Synapse-release/update-signing.key   (mode 0600, folder 0700)
// and the app embeds the PUBLIC key (src/main/native/update-public-key.ts). Back the key file up: if it is lost,
// no installed Synapse will accept another update and everyone has to reinstall by hand. See docs/release.md.
//
//   node scripts/release-sign.mjs keygen          create the keypair once (refuses if the key file exists); pin the public key
//   node scripts/release-sign.mjs sign <zip>      write <zip>.sig (base64 over "name|version|sha256") and <zip>.sha256, then verify
//   node scripts/release-sign.mjs verify <zip>    check <zip>.sig against the embedded public key
//   node scripts/release-sign.mjs check           the key file exists, is 0600, and matches the embedded public key
//   node scripts/release-sign.mjs selftest        sign/verify round trip with a throwaway in-memory keypair
//
// SYNAPSE_UPDATE_KEY and SYNAPSE_UPDATE_PUBKEY_FILE override the two paths (the tests use temp copies).
// Nothing here ever prints the private key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_KEY_PATH = path.join(os.homedir(), "Library", "Application Support", "Synapse-release", "update-signing.key");
const keyPath = () => process.env.SYNAPSE_UPDATE_KEY || DEFAULT_KEY_PATH;
const pubFile = () => process.env.SYNAPSE_UPDATE_PUBKEY_FILE || path.join(here, "src", "main", "native", "update-public-key.ts");

/** Final secfix item 11: what a release signature covers — the asset name, the version and the zip's sha256. */
export function releaseMessage(zip, version, sha256) {
  return Buffer.from(`${path.basename(zip)}|${version}|${sha256}`, "utf8");
}

/** The version in a release zip's name (Synapse-<version>-<arch>.zip); null if it isn't one. */
export function versionOf(zip) {
  const m = /^[^/]+-(\d+\.\d+\.\d+)-[\w]+\.zip$/.exec(path.basename(zip));
  return m ? m[1] : null;
}

export function signBytes(bytes, privateKeyPem) {
  return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyBytes(bytes, sigB64, publicKeyPem) {
  const sig = Buffer.from(String(sigB64).trim(), "base64");
  try { return sig.length === 64 && crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), sig); } catch { return false; }
}

export function pinnedPublicKey(file = pubFile()) {
  const m = /UPDATE_PUBLIC_KEY: string \| null = (null|`([^`]*)`)/.exec(fs.readFileSync(file, "utf8"));
  return m && m[1] !== "null" ? m[2] : null;
}

/** The private key (PEM), refusing a missing key or one other users can read. */
export function readPrivateKey(file = keyPath()) {
  let st;
  try { st = fs.statSync(file); } catch { throw new Error(`No update-signing key at ${file}. Run \`node app/scripts/release-sign.mjs keygen\` once (or restore the key file from your backup).`); }
  if (st.mode & 0o077) throw new Error(`The update-signing key ${file} is readable by other users. Run: chmod 600 "${file}"`);
  const pem = fs.readFileSync(file, "utf8");
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} isn't an Ed25519 key.`);
  return pem;
}

/** The key file's public half equals the key the app embeds (otherwise every installed app would refuse the release). */
export function assertKeyMatchesPinned(o = {}) {
  const pinned = pinnedPublicKey(o.pubFile);
  if (!pinned) throw new Error("Updates not configured: the app embeds no update public key. Run `release-sign.mjs keygen` first.");
  const derived = crypto.createPublicKey(readPrivateKey(o.keyFile)).export({ format: "pem", type: "spki" }).toString();
  if (derived.trim() !== pinned.trim()) throw new Error("The update-signing key doesn't match the public key the app embeds (src/main/native/update-public-key.ts). Restore the right key file; releases signed with this one would be refused by every installed Synapse.");
}

/** Signs <zip>: writes <zip>.sig and <zip>.sha256, verifies against the embedded key, returns the signature. */
export function signZip(zip, o = {}) {
  const pub = pinnedPublicKey(o.pubFile);
  if (!pub) throw new Error("Updates not configured: run `release-sign.mjs keygen` first.");
  const version = versionOf(zip);
  if (!version) throw new Error("The zip must be named <App>-<x.y.z>-<arch>.zip.");
  const priv = readPrivateKey(o.keyFile);
  const bytes = fs.readFileSync(zip);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const msg = releaseMessage(zip, version, sha);
  const sig = signBytes(msg, priv);
  if (!verifyBytes(msg, sig, pub)) throw new Error("The signature does NOT verify against the embedded public key (the key file and update-public-key.ts disagree).");
  fs.writeFileSync(`${zip}.sig`, `${sig}\n`);
  fs.writeFileSync(`${zip}.sha256`, `${sha}  ${path.basename(zip)}\n`);
  return sig;
}

function writePinnedKey(pem) {
  const file = pubFile();
  const src = fs.readFileSync(file, "utf8").replace(/UPDATE_PUBLIC_KEY: string \| null = (null|`[^`]*`);/, `UPDATE_PUBLIC_KEY: string | null = \`${pem.trim()}\n\`;`);
  fs.writeFileSync(file, src);
}

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === "selftest") {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const bytes = crypto.randomBytes(1024);
    const sig = signBytes(bytes, privateKey.export({ format: "pem", type: "pkcs8" }));
    const pub = publicKey.export({ format: "pem", type: "spki" });
    if (!verifyBytes(bytes, sig, pub) || verifyBytes(Buffer.concat([bytes, Buffer.from("x")]), sig, pub)) throw new Error("selftest failed");
    console.log("selftest ok");
    return;
  }
  if (cmd === "keygen") {
    const file = keyPath();
    if (fs.existsSync(file)) throw new Error(`An update-signing key already exists at ${file}. It is never replaced: apps that embed its public key would refuse every release signed with a new one.`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    // flag "wx": never overwrite, even in a race; mode 0600 from the first byte.
    fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    fs.chmodSync(file, 0o600);
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    writePinnedKey(pem);
    console.log(`Wrote the update-signing key to ${file} (mode 0600). BACK IT UP (e.g. a password manager); if it is lost, every installed Synapse needs a manual reinstall.\nEmbedded public key (${path.relative(process.cwd(), pubFile()) || pubFile()}):\n${pem}`);
    return;
  }
  if (cmd === "check") {
    assertKeyMatchesPinned();
    console.log(`The update-signing key at ${keyPath()} matches the embedded public key.`);
    return;
  }
  if (cmd === "sign") {
    if (!arg) throw new Error("usage: release-sign.mjs sign <zip>");
    signZip(arg);
    console.log(`Signed and verified ${path.basename(arg)}`);
    return;
  }
  if (cmd === "verify") {
    if (!arg) throw new Error("usage: release-sign.mjs verify <zip>");
    const pub = pinnedPublicKey();
    if (!pub) throw new Error("Updates not configured: run `release-sign.mjs keygen` first.");
    const version = versionOf(arg);
    if (!version) throw new Error("The zip must be named <App>-<x.y.z>-<arch>.zip.");
    const sha = crypto.createHash("sha256").update(fs.readFileSync(arg)).digest("hex");
    if (!verifyBytes(releaseMessage(arg, version, sha), fs.readFileSync(`${arg}.sig`, "utf8"), pub)) throw new Error("The signature does NOT verify against the embedded public key.");
    console.log(`Verified ${path.basename(arg)}`);
    return;
  }
  throw new Error("usage: release-sign.mjs keygen | sign <zip> | verify <zip> | check | selftest");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
