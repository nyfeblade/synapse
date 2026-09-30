import fs from "node:fs";
import path from "node:path";
import { maskProviderKey, PROVIDER_KEY_RE, providerLabel, STR_PROVIDER_UI, type ProviderId } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { subkey, vaultKeySync } from "../secrets/crypto";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { KeyRing, type RingDisk, type RingKey, type Sealed } from "./key-ring";

/**
 * ProviderKeyStore (spec §4; several keys per provider since 0.1.7): the model providers' API keys, in
 * hostPrivate/provider-auth/keys.json (0600). Each provider holds a ring of named keys (key-ring.ts), each sealed with
 * AES-256-GCM under the provider's own HKDF subkey of the box vault key, `bots/provider-key/<provider>/v1` (the
 * AuthStore pattern); only ids, labels, save times and caps are in the clear. An opened key lives in this object's
 * memory and leaves it only as the Authorization header the provider proxy (provider-proxy.ts) adds on its way out.
 *
 * Migration: a file from before (one key per provider, `{ keys: { openai: { key, savedAt } } }`) becomes each
 * provider's default key, labelled with the provider's name, and is written back in the new shape at once.
 */
type Provider = Exclude<ProviderId, "anthropic">;
interface LegacyDisk { keys?: Partial<Record<Provider, { key: Sealed; savedAt: number }>> }
interface OnDisk { v: 2; rings: Partial<Record<Provider, RingDisk>> }

export const PROVIDER_AUTH_DIR = "provider-auth";
/** The id a migrated single key (and a provider's first key) gets. */
export const MIGRATED_KEY_ID = "k1";

export class ProviderKeyStore {
  private rings = new Map<Provider, KeyRing>();
  private gen = 0;

  constructor(private o: { dir: string; vaultKey: Uint8Array; now?: () => number; onChange?: (p: Provider) => void }) {
    const raw = readJson<Partial<OnDisk> & LegacyDisk>(this.file, {});
    if (raw.v === 2 && raw.rings && typeof raw.rings === "object") {
      for (const [p, r] of Object.entries(raw.rings) as [Provider, RingDisk][]) this.rings.set(p, new KeyRing(this.subkey(p), r));
    } else if (raw.keys && typeof raw.keys === "object") {
      for (const [p, e] of Object.entries(raw.keys) as [Provider, { key: Sealed; savedAt: number }][]) {
        if (!e?.key) continue;
        const ring = new KeyRing(this.subkey(p), { entries: [{ id: MIGRATED_KEY_ID, label: providerLabel(p), key: e.key, savedAt: e.savedAt ?? 0 }], defaultId: MIGRATED_KEY_ID });
        if (ring.size) this.rings.set(p, ring);
      }
      this.write(); // silently, in the new shape
    }
  }

  private get file(): string { return path.join(this.o.dir, "keys.json"); }
  private subkey(p: Provider): Uint8Array { return subkey(this.o.vaultKey, `bots/provider-key/${p}/v1`); }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private ringOf(p: Provider): KeyRing {
    let r = this.rings.get(p);
    if (!r) { r = new KeyRing(this.subkey(p)); this.rings.set(p, r); }
    return r;
  }

  /** The opened key: `id`'s, or the provider's default. Read by the provider proxy's credential lookup only (app.ts). */
  key(p: Provider, id?: string | null): string | null { return this.rings.get(p)?.key(id) ?? null; }
  /** A key is saved (`id`: that one). */
  has(p: Provider, id?: string | null): boolean { return this.rings.get(p)?.has(id) ?? false; }
  /** The key a call uses: `want` while it's saved, else the default (null: no key). */
  resolve(p: Provider, want?: string | null): string | null { return this.rings.get(p)?.resolve(want) ?? null; }
  defaultId(p: Provider): string | null { return this.rings.get(p)?.defaultId() ?? null; }
  /** The keys, default first. */
  list(p: Provider): RingKey[] { return this.rings.get(p)?.list() ?? []; }
  entry(p: Provider, id: string): RingKey | null { return this.rings.get(p)?.entry(id) ?? null; }
  /** A key's mask (default: the default key's). */
  masked(p: Provider, id?: string | null): { masked: string; savedAt: number } | null {
    const r = this.rings.get(p);
    const kid = id ?? r?.defaultId() ?? null;
    const k = kid ? r?.key(kid) : null;
    return k && kid ? { masked: maskProviderKey(k), savedAt: r!.entry(kid)?.savedAt ?? 0 } : null;
  }
  generation(): number { return this.gen; }
  /** A short digest of a key (never the key). */
  fingerprint(p: Provider, id?: string | null): string { return this.rings.get(p)?.fingerprint(id) ?? "none"; }

  private check(value: string): string {
    const k = String(value ?? "").trim();
    if (!PROVIDER_KEY_RE.test(k)) throw new GatewayError("BAD_API_KEY", STR_PROVIDER_UI.badFormat);
    return k;
  }

  /** The single-key Save of before: replaces the default key (or adds the first). Returns its id. */
  set(p: Provider, value: string): string {
    const id = this.ringOf(p).replaceDefault(this.check(value), providerLabel(p), this.now(), MIGRATED_KEY_ID);
    this.save(p);
    return id;
  }
  /** Another key for the provider; the first one is the default. Returns its id. */
  add(p: Provider, value: string, label: string): string {
    const ring = this.ringOf(p);
    const id = ring.add(this.check(value), label || providerLabel(p), this.now(), ring.size ? undefined : MIGRATED_KEY_ID);
    this.save(p);
    return id;
  }
  rename(p: Provider, id: string, label: string): void { this.ringOf(p).rename(id, label); this.save(p); }
  setDefault(p: Provider, id: string): void { this.ringOf(p).setDefault(id); this.save(p); }
  setCap(p: Provider, id: string, capUsd: number | null): void { this.ringOf(p).setCap(id, capUsd); this.save(p); }
  remove(p: Provider, id: string): void { this.ringOf(p).remove(id); this.save(p); }
  /** The single-key Remove of before: the default key goes (the next oldest becomes the default). */
  clear(p: Provider): void {
    const d = this.rings.get(p)?.defaultId();
    if (d) this.rings.get(p)!.remove(d);
    this.save(p);
  }

  private write(): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const rings: OnDisk["rings"] = {};
    for (const [p, r] of this.rings) if (r.size) rings[p] = r.toDisk();
    writeJsonAtomic(this.file, { v: 2, rings } satisfies OnDisk, 0o600);
  }

  private save(p: Provider): void {
    this.write();
    this.gen++;
    this.o.onChange?.(p);
  }
}

export function providerKeyStoreFor(cfg: Pick<HostConfig, "hostPrivate">, o: { now?: () => number; onChange?: (p: Provider) => void } = {}): ProviderKeyStore {
  return new ProviderKeyStore({ dir: path.join(cfg.hostPrivate, PROVIDER_AUTH_DIR), vaultKey: vaultKeySync(cfg.hostPrivate), ...o });
}
