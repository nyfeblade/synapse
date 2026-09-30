import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cleanKeyLabel, isKeyId } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";

/**
 * One provider's saved keys (0.1.7, several keys per provider). Each key is sealed exactly as a single key was before:
 * AES-256-GCM under the provider's HKDF subkey of the box vault key, a fresh IV per key; only the id, the label, the
 * save time and an optional monthly cap are in the clear. Opened keys live in this object's memory only.
 *
 * The first key added is the default; `setDefault` moves it. Removing the default makes the next oldest the default.
 */
export interface Sealed { v: 1; iv: string; tag: string; ct: string }
export interface RingEntry { id: string; label: string; key: Sealed; savedAt: number; capUsd?: number }
export interface RingDisk { entries: RingEntry[]; defaultId: string | null }
export interface RingKey { id: string; label: string; savedAt: number; isDefault: boolean; capUsd: number | null }

export const MAX_KEYS_PER_PROVIDER = 12;

export function seal(subkey: Uint8Array, value: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", subkey, iv);
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function unseal(subkey: Uint8Array, s: Sealed): string | null {
  try {
    const d = createDecipheriv("aes-256-gcm", subkey, Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null; // another vault key (a reset box, a backup from elsewhere), or another provider's entry: no key
  }
}

const newId = (taken: Set<string>): string => {
  for (;;) {
    const id = `k${randomBytes(5).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
};

export class KeyRing {
  private entries: RingEntry[] = [];
  private open = new Map<string, string>();
  private defaultId_: string | null = null;

  /** `disk`: what was saved. Entries that no longer open (another vault key) are dropped. */
  constructor(private subkey: Uint8Array, disk?: Partial<RingDisk> | null) {
    for (const e of Array.isArray(disk?.entries) ? disk.entries : []) {
      if (!e || !isKeyId(e.id) || this.open.has(e.id) || !e.key) continue;
      const k = unseal(subkey, e.key);
      if (!k) continue;
      this.entries.push({ id: e.id, label: cleanKeyLabel(e.label) || "Key", key: e.key, savedAt: Number(e.savedAt) || 0, ...(typeof e.capUsd === "number" && e.capUsd > 0 ? { capUsd: e.capUsd } : {}) });
      this.open.set(e.id, k);
    }
    const want = disk?.defaultId ?? null;
    this.defaultId_ = want && this.open.has(want) ? want : this.entries[0]?.id ?? null;
  }

  toDisk(): RingDisk { return { entries: this.entries.map((e) => ({ ...e })), defaultId: this.defaultId_ }; }
  get size(): number { return this.entries.length; }
  defaultId(): string | null { return this.defaultId_; }
  has(id?: string | null): boolean { return id ? this.open.has(id) : this.defaultId_ !== null; }
  /** The opened key: `id`'s, or the default's. */
  key(id?: string | null): string | null { const k = id ?? this.defaultId_; return k ? this.open.get(k) ?? null : null; }
  /** The key a call uses: the wanted one while it exists, else the default. */
  resolve(want?: string | null): string | null { return want && this.open.has(want) ? want : this.defaultId_; }
  entry(id: string): RingKey | null {
    const e = this.entries.find((x) => x.id === id);
    return e ? { id: e.id, label: e.label, savedAt: e.savedAt, isDefault: e.id === this.defaultId_, capUsd: e.capUsd ?? null } : null;
  }
  /** Default first, then in the order added. */
  list(): RingKey[] {
    const all = this.entries.map((e) => this.entry(e.id)!);
    return [...all.filter((k) => k.isDefault), ...all.filter((k) => !k.isDefault)];
  }
  /** A short digest of one key (never the key). */
  fingerprint(id?: string | null): string {
    const k = this.key(id);
    return k ? createHash("sha256").update(k).digest("hex").slice(0, 12) : "none";
  }

  /** Adds a key; the first one is the default. Returns its id. The same key twice is refused. */
  add(value: string, label: string, now: number, id?: string): string {
    if ([...this.open.values()].includes(value)) throw new GatewayError("DUPLICATE_KEY", "That key is already saved.");
    if (this.entries.length >= MAX_KEYS_PER_PROVIDER) throw new GatewayError("TOO_MANY_KEYS", "That's as many keys as a provider can have.");
    const taken = new Set(this.open.keys());
    const kid = id && isKeyId(id) && !taken.has(id) ? id : newId(taken);
    this.entries.push({ id: kid, label: cleanKeyLabel(label) || "Key", key: seal(this.subkey, value), savedAt: now });
    this.open.set(kid, value);
    if (!this.defaultId_) this.defaultId_ = kid;
    return kid;
  }

  /** Replaces the default key's value, keeping its id and label (the single-key Save of before); with none, adds one. */
  replaceDefault(value: string, label: string, now: number, id?: string): string {
    const d = this.defaultId_;
    if (!d) return this.add(value, label, now, id);
    const e = this.entries.find((x) => x.id === d)!;
    e.key = seal(this.subkey, value);
    e.savedAt = now;
    this.open.set(d, value);
    return d;
  }

  rename(id: string, label: string): void {
    const e = this.need(id);
    const l = cleanKeyLabel(label);
    if (!l) throw new GatewayError("BAD_ARGS", "A key needs a label.");
    e.label = l;
  }

  setDefault(id: string): void { this.need(id); this.defaultId_ = id; }

  setCap(id: string, capUsd: number | null): void {
    const e = this.need(id);
    if (capUsd === null || capUsd === 0) delete e.capUsd;
    else if (typeof capUsd === "number" && Number.isFinite(capUsd) && capUsd > 0 && capUsd <= 1_000_000) e.capUsd = Math.round(capUsd * 100) / 100;
    else throw new GatewayError("BAD_ARGS", "A cap is a dollar amount.");
  }

  /** Removes a key. The default moves to the oldest key left (or none). */
  remove(id: string): void {
    this.need(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.open.delete(id);
    if (this.defaultId_ === id) this.defaultId_ = this.entries[0]?.id ?? null;
  }

  private need(id: string): RingEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new GatewayError("NO_KEY", "That key isn't saved.", 404);
    return e;
  }
}
