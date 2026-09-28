import { hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type sodiumType from "libsodium-wrappers";
import { writeJsonAtomic } from "../util/atomic-json";

// libsodium-wrappers@0.7.16's ESM build (dist/modules-esm/libsodium-wrappers.mjs) has a broken
// relative import ("./libsodium.mjs") that isn't shipped in its own package — only in the
// `libsodium` package's dist. Its CJS build (used via the package.json "require" export
// condition) is fine: it does `require("libsodium")`, a normal package-name resolution. Load it
// through createRequire so we get the working CJS build under our ESM host code.
const sodium: typeof sodiumType = createRequire(import.meta.url)("libsodium-wrappers");

const B64 = () => sodium.base64_variants.ORIGINAL;
async function na(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export interface BoxKeyPair { publicKey: string; privateKey: string }

/** ORIG-12 §12.2: X25519 key pair generated at first boot; the Mac pins the public key (TOFU). */
export async function loadOrCreateBoxKeyPair(hostPrivate: string): Promise<BoxKeyPair> {
  const s = await na();
  const file = path.join(hostPrivate, "box-keypair.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as BoxKeyPair;
  const kp = s.crypto_box_keypair();
  const out = { publicKey: s.to_base64(kp.publicKey, B64()), privateKey: s.to_base64(kp.privateKey, B64()) };
  fs.mkdirSync(hostPrivate, { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, out, 0o600);
  return out;
}

export async function sealTo(publicKeyB64: string, value: string): Promise<string> {
  const s = await na();
  return s.to_base64(s.crypto_box_seal(s.from_string(value), s.from_base64(publicKeyB64, B64())), B64());
}

export async function openSealed(sealedB64: string, kp: BoxKeyPair): Promise<string> {
  const s = await na();
  return s.to_string(s.crypto_box_seal_open(s.from_base64(sealedB64, B64()), s.from_base64(kp.publicKey, B64()), s.from_base64(kp.privateKey, B64())));
}

/** ORIG-12 §12.1: 32 random bytes, 0400, never snapshotted. */
export async function loadOrCreateVaultKey(hostPrivate: string): Promise<Uint8Array> {
  const s = await na();
  const file = path.join(hostPrivate, "vault.key");
  if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  const key = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  fs.mkdirSync(hostPrivate, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key, { mode: 0o400 });
  return key;
}

/** The same vault.key (32 random bytes, 0400), read or created synchronously for host-side stores that
 *  can't await libsodium (connector OAuth credentials, Phase 5). */
export function vaultKeySync(hostPrivate: string): Uint8Array {
  const file = path.join(hostPrivate, "vault.key");
  if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  const key = new Uint8Array(randomBytes(32));
  fs.mkdirSync(hostPrivate, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, key, { mode: 0o400, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return new Uint8Array(fs.readFileSync(file)); // created meanwhile
    throw e;
  }
  return key;
}

export async function aeadSeal(key: Uint8Array, plaintext: string): Promise<{ nonce: string; ct: string }> {
  const s = await na();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(s.from_string(plaintext), null, null, nonce, key);
  return { nonce: s.to_base64(nonce, B64()), ct: s.to_base64(ct, B64()) };
}

export async function aeadOpen(key: Uint8Array, nonce: string, ct: string): Promise<string> {
  const s = await na();
  return s.to_string(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, s.from_base64(ct, B64()), null, s.from_base64(nonce, B64()), key));
}

/** P5 review minor: one HKDF-SHA256 subkey per cipher/use of the vault key (OAuth sealing, command-MCP env, …). */
export function subkey(root: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", root, Buffer.alloc(0), label, 32));
}
