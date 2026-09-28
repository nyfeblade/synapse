import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITSC, STRC, type SecretStatusEntry } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { aeadOpen, aeadSeal, loadOrCreateBoxKeyPair, loadOrCreateVaultKey, openSealed, type BoxKeyPair } from "./crypto";
import { validateSecretName } from "./secret-names";

export { RESERVED_NAMES, RESERVED_PREFIXES, validateSecretName } from "./secret-names";

export interface SecretUpsert { name: string; description: string; sealed: string; valueHash: string }
interface CacheEntry { nonce: string; ct: string; updatedAt: number; valueHash: string; description: string }
type Cache = Record<string, CacheEntry>;
const bad = (msg: string) => new GatewayError("BAD_SECRET", msg, 400);

/** ORIG-12: host-side secret cache. Values exist in clear only in memory and in the CLI child's env. */
export class SecretVault {
  private plain = new Map<string, Map<string, string>>(); // botId → name → value (decrypted cache)
  private listeners = new Set<(botId: string) => void>();
  // Bumped on every apply() so version() also changes when a remove empties the cache back to
  // the same (empty) shape it started in — content alone can't distinguish those two states.
  private revisions = new Map<string, number>();

  private constructor(private dir: string, private kp: BoxKeyPair, private key: Uint8Array, private now: () => number) {}

  static async open(o: { hostPrivate: string; now?: () => number }): Promise<SecretVault> {
    const kp = await loadOrCreateBoxKeyPair(o.hostPrivate);
    const key = await loadOrCreateVaultKey(o.hostPrivate);
    const dir = path.join(o.hostPrivate, "secrets");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const v = new SecretVault(dir, kp, key, o.now ?? Date.now);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) await v.warm(f.slice(0, -5));
    return v;
  }

  get publicKey(): string { return this.kp.publicKey; }

  private file(botId: string): string { return path.join(this.dir, `${botId}.json`); }
  private cache(botId: string): Cache { return readJson<Cache>(this.file(botId), {}); }

  /** Decrypt this Bot's cache into memory; entries that no longer decrypt stay "needs sync". */
  async warm(botId: string): Promise<void> {
    const m = new Map<string, string>();
    for (const [name, e] of Object.entries(this.cache(botId))) {
      try { m.set(name, await aeadOpen(this.key, e.nonce, e.ct)); } catch { /* needs sync */ }
    }
    this.plain.set(botId, m);
  }

  open(sealed: string): Promise<string> {
    return openSealed(sealed, this.kp);
  }

  async apply(botId: string, upserts: SecretUpsert[], removes: string[]): Promise<SecretStatusEntry[]> {
    const cache = this.cache(botId);
    const plain = new Map(this.plain.get(botId) ?? []);
    for (const name of removes) { delete cache[name]; plain.delete(name); }
    for (const u of upserts) {
      const nameErr = validateSecretName(u.name);
      if (nameErr) throw bad(nameErr);
      if (u.description.length > LIMITSC.secretDescriptionMax) throw bad("The description can be at most 400 characters.");
      const value = await this.open(u.sealed).catch(() => { throw bad("The secret could not be opened; the app will re-send it."); });
      if (value.length < LIMITSC.secretMinChars) throw bad(STRC.secretTooShort);
      if (value.length > LIMITSC.secretValueMax) throw bad("A secret value can be at most 32,768 characters.");
      plain.set(u.name, value);
      cache[u.name] = { ...(await aeadSeal(this.key, value)), updatedAt: this.now(), valueHash: u.valueHash, description: u.description };
    }
    if (Object.keys(cache).length > LIMITSC.secretsPerBot) throw bad("A Bot can have at most 100 secrets.");
    if ([...plain.values()].reduce((n, v) => n + v.length, 0) > LIMITSC.secretsTotalMax) throw bad("A Bot's secrets can total at most 98,304 characters.");
    writeJsonAtomic(this.file(botId), cache, 0o600);
    this.plain.set(botId, plain);
    this.revisions.set(botId, (this.revisions.get(botId) ?? 0) + 1);
    for (const l of this.listeners) l(botId);
    return this.status(botId);
  }

  async status(botId: string): Promise<SecretStatusEntry[]> {
    const plain = this.plain.get(botId) ?? new Map();
    return Object.entries(this.cache(botId)).map(([name, e]) => {
      const unusable = validateSecretName(name);
      return { name, description: e.description, updatedAt: e.updatedAt, valueHash: e.valueHash, needsSync: !plain.has(name), ...(unusable ? { unusable } : {}) };
    });
  }

  /** I4: names are re-validated here too; a name stored under older rules is left out and logged by name only.
   *  Bug 56: status() reports the same name as `unusable` with the reason, so the list never shows it as saved. */
  env(botId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of this.plain.get(botId) ?? []) {
      if (validateSecretName(name)) log.warn("secret left out of the env: its name is no longer allowed", { botId, name });
      else out[name] = value;
    }
    return out;
  }

  values(botId: string): { name: string; value: string }[] {
    return [...(this.plain.get(botId) ?? new Map<string, string>())].map(([name, value]) => ({ name, value }));
  }

  descriptions(botId: string): { name: string; description: string }[] {
    return Object.entries(this.cache(botId)).map(([name, e]) => ({ name, description: e.description }));
  }

  version(botId: string): string {
    const c = this.cache(botId);
    const shape = Object.keys(c).sort().map((n) => `${n}:${c[n]!.valueHash}:${c[n]!.updatedAt}`).join("|");
    const rev = this.revisions.get(botId) ?? 0;
    return createHash("sha256").update(`${rev}:${shape}`).digest("hex").slice(0, 16);
  }

  onChange(cb: (botId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** I6: forget the Bot's secrets; the revision bump changes version() and listeners (the scanner cache) are told. */
  removeBot(botId: string): void {
    fs.rmSync(this.file(botId), { force: true });
    this.plain.delete(botId);
    this.revisions.set(botId, (this.revisions.get(botId) ?? 0) + 1);
    for (const l of this.listeners) l(botId);
  }
}
