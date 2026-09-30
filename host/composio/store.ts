import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface ComposioAppRecord {
  accountId: string;
  authConfigId: string;
  state: "waiting" | "connected" | "failed";
  since: number;
  error?: string;
}

export interface ComposioData {
  /** The user's own Composio project API key. Sealed here; never returned to the UI, a Bot, a log or a transcript. */
  apiKey?: string;
  /** Composio's user id for this install's accounts: random, never a name or an email. */
  userId?: string;
  disclosureAccepted?: boolean;
  apps?: Record<string, ComposioAppRecord>;
  /** Per-Bot grants: toolkit → Bot ids allowed to use it (default: none). */
  grants?: Record<string, string[]>;
}

interface Sealed { v: 1; iv: string; tag: string; ct: string }
const isSealed = (x: unknown): x is Sealed => typeof x === "object" && x !== null && (x as Sealed).v === 1 && typeof (x as Sealed).ct === "string";

/**
 * hostPrivate/composio/account.json (0600), sealed with the vault's HKDF subkey "bots/composio/v1" (AES-256-GCM) —
 * the same secret store as the Google account and the MCP header vault. Never the macOS Keychain.
 */
export class ComposioStore {
  constructor(private file: string, private key: Uint8Array) {}

  read(): ComposioData {
    const raw = readJson<unknown>(this.file, {});
    if (!isSealed(raw)) return {};
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(raw.iv, "base64"));
      d.setAuthTag(Buffer.from(raw.tag, "base64"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as ComposioData;
    } catch {
      return {}; // another key (a reset vault): treat as not set up
    }
  }

  write(patch: Partial<ComposioData>): ComposioData {
    const next: ComposioData = { ...this.read(), ...patch };
    for (const k of Object.keys(next) as (keyof ComposioData)[]) if (next[k] === undefined) delete next[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(next), "utf8"), c.final()]);
    writeJsonAtomic(this.file, { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }, 0o600);
    return next;
  }
}
