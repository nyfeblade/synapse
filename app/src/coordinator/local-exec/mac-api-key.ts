import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The Bots' claude on this Mac (a wrapped `claude` run in the
 * command sandbox) uses the same Anthropic API key as the Bots on their computer. The app keeps a copy here when the
 * user saves the key in Settings → Account (main/auth-key.ts; removed with it), stored like the other app secrets that
 * must not depend on the keychain: AES-256-GCM with an HKDF subkey of local-policy.key, 0600, in the app's data folder,
 * which the command sandbox read-denies. Never safeStorage, never the keychain. It never reaches a claude run: the
 * coordinator's key proxy (mac-key-proxy.ts) reads it per request and gives each run a token of its own.
 */
export const MAC_API_KEY_FILE = "mac-anthropic-api-key.bin";
const INFO = "bots/mac-anthropic-api-key/v1";

const subkey = (policyKey: Buffer): Buffer => Buffer.from(hkdfSync("sha256", policyKey, Buffer.alloc(0), INFO, 32));

export function saveMacApiKey(userData: string, policyKey: Buffer, key: string): void {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", subkey(policyKey), iv);
  const body = Buffer.concat([c.update(key, "utf8"), c.final()]);
  const blob = Buffer.concat([iv, c.getAuthTag(), body]);
  const file = path.join(userData, MAC_API_KEY_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, blob); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The API key for the Bots' claude on this Mac, or null (none saved, or it doesn't decrypt with this profile's key). */
export function loadMacApiKey(userData: string, policyKey: Buffer): string | null {
  let blob: Buffer;
  try { blob = fs.readFileSync(path.join(userData, MAC_API_KEY_FILE)); } catch { return null; }
  if (blob.length < 29) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", subkey(policyKey), blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}

export function clearMacApiKey(userData: string): void {
  try { fs.unlinkSync(path.join(userData, MAC_API_KEY_FILE)); } catch { /* none */ }
}
