import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface GoogleClient { clientId: string; clientSecret: string }
export interface GoogleTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export interface GoogleAccount { client?: GoogleClient; tokens?: GoogleTokens; email?: string; needsReconnect?: boolean }

interface Sealed { v: 1; iv: string; tag: string; ct: string }
const isSealed = (x: unknown): x is Sealed => typeof x === "object" && x !== null && (x as Sealed).v === 1 && typeof (x as Sealed).ct === "string";

/**
 * The app-level Google account: the user's OAuth client and the refresh/access tokens, in host-private storage
 * (hostPrivate/google/account.json, 0600) sealed with the ORIG-12 vault key (AES-256-GCM), the same pattern as
 * host/mcp/oauth.ts. No Bot process can read it, and nothing here is ever returned to a Bot or the UI.
 */
export class GoogleStore {
  /** Final secfix item 6: `key` is the HKDF subkey "bots/google/v1"; `legacyKey` (the raw vault key) still opens a
   *  file sealed before the subkey, and the next write re-seals it with the subkey. */
  constructor(private file: string, private key: Uint8Array, private legacyKey?: Uint8Array) {}

  read(): GoogleAccount {
    const raw = readJson<unknown>(this.file, {});
    if (!isSealed(raw)) return {};
    for (const k of this.legacyKey ? [this.key, this.legacyKey] : [this.key]) {
      try {
        const d = createDecipheriv("aes-256-gcm", k, Buffer.from(raw.iv, "base64"));
        d.setAuthTag(Buffer.from(raw.tag, "base64"));
        return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as GoogleAccount;
      } catch { /* try the next key */ }
    }
    return {}; // another key (a reset vault): treat as not configured
  }

  write(patch: Partial<GoogleAccount>): GoogleAccount {
    const next = { ...this.read(), ...patch };
    for (const k of Object.keys(next) as (keyof GoogleAccount)[]) if (next[k] === undefined) delete next[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(next), "utf8"), c.final()]);
    writeJsonAtomic(this.file, { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }, 0o600);
    return next;
  }
}
