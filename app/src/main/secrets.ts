import fs from "node:fs";
import path from "node:path";
import { sealer } from "./sealing";

/**
 * Sealed copies of Mac-side secrets (§4.1 "Mac secrets"), secrets/<name>.bin, sealed with the profile's key file
 * (bug-log 279: the keychain is retired). Both calls go through the gate in sealing.ts: until the window is up
 * and the gate has opened (after the one-time keychain migration, if this profile needs it) they are no-ops.
 */
export function storeSecret(userData: string, name: string, value: string): void {
  const sealed = sealer.read((s) => s.encryptString(value), null);
  if (!sealed) return;
  const dir = path.join(userData, "secrets");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${name}.bin`), sealed, { mode: 0o600 });
}

/** Reads a secret written by storeSecret, or null if it's missing, can't be unsealed, or the gate isn't open. */
export function readSecret(userData: string, name: string): string | null {
  return sealer.read((s) => {
    try {
      return s.decryptString(fs.readFileSync(path.join(userData, "secrets", `${name}.bin`)));
    } catch {
      return null;
    }
  }, null);
}
