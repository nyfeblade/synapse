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

/** 4.3b: one account of an app (an app can have several: two Gmails, two Slacks). */
export interface ComposioAccountRecord extends ComposioAppRecord {
  /** What the card and the Bot call it: the Gmail address when Composio could tell, else "Slack", "Slack 2", or the owner's rename. */
  label?: string;
  /** A reconnect (Fix): the account this new one takes over once it connects. */
  replaces?: string;
}

export interface ComposioData {
  /** The user's own Composio project API key. Sealed here; never returned to the UI, a Bot, a log or a transcript. */
  apiKey?: string;
  /** Composio's user id for this install's accounts: random, never a name or an email. */
  userId?: string;
  disclosureAccepted?: boolean;
  /** 4.3b: toolkit → its accounts, oldest first. */
  accounts?: Record<string, ComposioAccountRecord[]>;
  /** 4.3b: per-Bot grants per account: Composio account id → Bot ids (default: none). */
  accountGrants?: Record<string, string[]>;
  /** Before 4.3b: one account per app and a grant per app. read() folds them into accounts/accountGrants. */
  apps?: Record<string, ComposioAppRecord>;
  grants?: Record<string, string[]>;
}

/** Folds the pre-4.3b one-account-per-app records into accounts and per-account grants (silently). */
function normalize(d: ComposioData): ComposioData {
  const { apps, grants, ...rest } = d;
  if (!apps || rest.accounts) return rest;
  const accounts: Record<string, ComposioAccountRecord[]> = {};
  const accountGrants: Record<string, string[]> = { ...(rest.accountGrants ?? {}) };
  for (const [tk, rec] of Object.entries(apps)) {
    accounts[tk] = [rec];
    if (grants?.[tk]?.length) accountGrants[rec.accountId] = [...grants[tk]!];
  }
  return { ...rest, accounts, accountGrants };
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
      return normalize(JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as ComposioData);
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
