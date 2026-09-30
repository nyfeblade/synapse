import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface GoogleClient { clientId: string; clientSecret: string }
/** refreshExpiresAt: Google said the refresh token expires (refresh_token_expires_in), as it does for a Testing app. */
export interface GoogleTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string; refreshExpiresAt?: number }
/** 4.3b: one connected Google account (its own tokens), sealed with the rest. */
export interface GoogleAccountRecord { id: string; email?: string; tokens: GoogleTokens; needsReconnect?: boolean }
/**
 * publishing: what the user ticked for "Publishing status: In production" in the guided sheet, when they did.
 * 4.3b: `accounts` (oldest first) and `grants` (account id → Bot ids). A grant list that is missing belongs to an
 * account from before per-account grants; the module fills it in once, from the Bots' Google switches.
 * `tokens`/`email`/`needsReconnect` are the pre-4.3b single account: read() folds them into `accounts`.
 */
export interface GoogleAccount {
  client?: GoogleClient; publishing?: "testing" | "production";
  accounts?: GoogleAccountRecord[]; grants?: Record<string, string[]>;
  tokens?: GoogleTokens; email?: string; needsReconnect?: boolean;
}
/** The id the pre-4.3b single account keeps. */
export const LEGACY_ACCOUNT_ID = "g-primary";

/** Folds the pre-4.3b single account into `accounts` (no grant list: the module fills that in). */
function normalize(a: GoogleAccount): GoogleAccount {
  if (!a.tokens || a.accounts?.length) {
    const { tokens: _t, email: _e, needsReconnect: _n, ...rest } = a;
    return rest;
  }
  const { tokens, email, needsReconnect, ...rest } = a;
  return { ...rest, accounts: [{ id: LEGACY_ACCOUNT_ID, tokens, ...(email ? { email } : {}), ...(needsReconnect ? { needsReconnect } : {}) }] };
}

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
        return normalize(JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as GoogleAccount);
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
