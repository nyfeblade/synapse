import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateSecretName } from "@synapse/shared";
import { readJsonStrict, writeFileAtomic } from "./atomic-file";

export interface Crypt { encrypt(s: string): Buffer; decrypt(b: Buffer): string }
interface Entry { botId: string; name: string; description: string; ciphertext: string; updatedAt: number; valueHash: string }
/**
 * Bug 57: `synced` is this profile's LEDGER: per Bot, the names this profile has put on the box (or
 * found there holding the same value). resync() may delete on the box ONLY a name in the ledger that
 * is no longer here, i.e. one the user removed on this Mac. It lives in the vault file on purpose, so
 * it shares the vault's fate: a new, reinstalled or wiped profile has no vault AND no ledger, and so
 * can never delete anything. `keptOnBox`: box-only names the user chose to leave there (the notice's
 * "Keep them on the box"). Names only, never a value or a hash of one.
 */
interface FileShape { version: 1; entries: Entry[]; synced?: Record<string, string[]>; keptOnBox?: Record<string, string[]> }

/** ORIG-12 §12.1: the Mac is the source of truth; values are sealed with the profile's key file (sealing.ts, bug 279) only. */
export class MacSecretVault {
  constructor(private file: string, private crypt: Crypt, private hashKey: () => Buffer, private now: () => number = Date.now) {}

  /**
   * Only ENOENT may read as "no secrets yet". A truncated, unparsable or unreadable vault throws:
   * every mutation here is a read-modify-write, and SecretSync.resync() turns "the Mac has nothing"
   * into `removes` for every name the box holds — so one bad read used to delete every secret on
   * both sides, with the Mac being the only copy of the values (ORIG-12 §12.1).
   */
  private read(): FileShape {
    return readJsonStrict<FileShape>(this.file, { version: 1, entries: [] }, (v) => !!v && typeof v === "object" && Array.isArray((v as FileShape).entries));
  }
  private write(s: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(s), 0o600);
  }

  hash(value: string): string {
    return createHmac("sha256", this.hashKey()).update(value).digest("hex");
  }

  /** Bug 56: a name stored under older rules is listed with the reason the Bot can't use it (the same
   *  validateSecretName the box's env applies), never as a plain saved secret. */
  list(botId: string): { name: string; description: string; updatedAt: number; unusable?: string }[] {
    return this.read().entries.filter((e) => e.botId === botId).map((e) => {
      const unusable = validateSecretName(e.name);
      return { name: e.name, description: e.description, updatedAt: e.updatedAt, ...(unusable ? { unusable } : {}) };
    });
  }

  entries(botId: string) {
    return this.read().entries.filter((e) => e.botId === botId).map((e) => ({ name: e.name, description: e.description, valueHash: e.valueHash }));
  }

  /** Bug 56 sibling: the box refuses a disallowed name, so storing it here first left a secret listed as saved
   *  that never reached the Bot. The write now applies the same rule the box and the list do. */
  upsert(botId: string, name: string, description: string, value: string): { valueHash: string } {
    const nameErr = validateSecretName(name);
    if (nameErr) throw new Error(nameErr);
    const s = this.read();
    const valueHash = this.hash(value);
    const e: Entry = { botId, name, description, ciphertext: this.crypt.encrypt(value).toString("base64"), updatedAt: this.now(), valueHash };
    s.entries = [...s.entries.filter((x) => !(x.botId === botId && x.name === name)), e];
    this.write(s);
    return { valueHash };
  }

  remove(botId: string, name: string): void {
    const s = this.read();
    s.entries = s.entries.filter((x) => !(x.botId === botId && x.name === name));
    this.write(s);
  }

  /** Bug 57: the names this profile has synced to the box for this Bot (see FileShape). */
  synced(botId: string): string[] {
    return this.read().synced?.[botId] ?? [];
  }

  setSynced(botId: string, names: string[]): void {
    const s = this.read();
    const next = [...new Set(names)].sort();
    if (JSON.stringify(s.synced?.[botId] ?? []) === JSON.stringify(next)) return;
    s.synced = { ...s.synced, [botId]: next };
    this.write(s);
  }

  markSynced(botId: string, add: string[], drop: string[] = []): void {
    this.setSynced(botId, [...this.synced(botId).filter((n) => !drop.includes(n)), ...add]);
  }

  keptOnBox(botId: string): string[] {
    return this.read().keptOnBox?.[botId] ?? [];
  }

  keepOnBox(botId: string, names: string[]): void {
    const s = this.read();
    s.keptOnBox = { ...s.keptOnBox, [botId]: [...new Set([...(s.keptOnBox?.[botId] ?? []), ...names])].sort() };
    this.write(s);
  }

  value(botId: string, name: string): string {
    const e = this.read().entries.find((x) => x.botId === botId && x.name === name);
    if (!e) throw new Error(`No secret ${name}`);
    return this.crypt.decrypt(Buffer.from(e.ciphertext, "base64"));
  }
}
