import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { maskProviderKey, PROVIDER_KEY_RE, STR_PROVIDER_UI, type ProviderId } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { subkey, vaultKeySync } from "../secrets/crypto";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

/**
 * ProviderKeyStore (spec §4): the model providers' API keys, in hostPrivate/provider-auth/keys.json (0600). Each key is
 * sealed with AES-256-GCM under its own HKDF subkey of the box vault key, `bots/provider-key/<provider>/v1` (the
 * AuthStore pattern); only the save time is in the clear. An opened key lives in this object's memory and leaves it
 * only as the Authorization header the provider proxy (provider-proxy.ts) adds on its way out. Only masked views leave.
 */
type Provider = Exclude<ProviderId, "anthropic">;
interface Sealed { v: 1; iv: string; tag: string; ct: string }
interface OnDisk { keys: Partial<Record<Provider, { key: Sealed; savedAt: number }>> }

export const PROVIDER_AUTH_DIR = "provider-auth";

export class ProviderKeyStore {
  private state: OnDisk;
  private open_ = new Map<Provider, string>();
  private gen = 0;

  constructor(private o: { dir: string; vaultKey: Uint8Array; now?: () => number; onChange?: (p: Provider) => void }) {
    const raw = readJson<Partial<OnDisk>>(this.file, {});
    this.state = { keys: raw.keys && typeof raw.keys === "object" ? raw.keys : {} };
    for (const [p, e] of Object.entries(this.state.keys) as [Provider, { key: Sealed }][]) {
      const k = e?.key ? this.unseal(p, e.key) : null;
      if (k) this.open_.set(p, k);
    }
  }

  private get file(): string { return path.join(this.o.dir, "keys.json"); }
  private subkey(p: Provider): Uint8Array { return subkey(this.o.vaultKey, `bots/provider-key/${p}/v1`); }

  /** The opened key. Read by the provider proxy's credential lookup only (app.ts wiring). */
  key(p: Provider): string | null { return this.open_.get(p) ?? null; }
  has(p: Provider): boolean { return this.open_.has(p); }
  masked(p: Provider): { masked: string; savedAt: number } | null {
    const k = this.open_.get(p);
    return k ? { masked: maskProviderKey(k), savedAt: this.state.keys[p]?.savedAt ?? 0 } : null;
  }
  generation(): number { return this.gen; }
  /** A short digest of every saved key, for spawn keys (never the key). */
  fingerprint(p: Provider): string {
    const k = this.open_.get(p);
    return k ? createHash("sha256").update(k).digest("hex").slice(0, 12) : "none";
  }

  set(p: Provider, value: string): void {
    const k = String(value ?? "").trim();
    if (!PROVIDER_KEY_RE.test(k)) throw new GatewayError("BAD_API_KEY", STR_PROVIDER_UI.badFormat);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.subkey(p), iv);
    const ct = Buffer.concat([c.update(k, "utf8"), c.final()]);
    this.state.keys[p] = { key: { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }, savedAt: (this.o.now ?? Date.now)() };
    this.open_.set(p, k);
    this.save(p);
  }

  clear(p: Provider): void {
    delete this.state.keys[p];
    this.open_.delete(p);
    this.save(p);
  }

  private unseal(p: Provider, s: Sealed): string | null {
    try {
      const d = createDecipheriv("aes-256-gcm", this.subkey(p), Buffer.from(s.iv, "base64"));
      d.setAuthTag(Buffer.from(s.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
    } catch {
      return null; // another vault key (a reset box, a backup from elsewhere): no key
    }
  }

  private save(p: Provider): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, this.state, 0o600);
    this.gen++;
    this.o.onChange?.(p);
  }
}

export function providerKeyStoreFor(cfg: Pick<HostConfig, "hostPrivate">, o: { now?: () => number; onChange?: (p: Provider) => void } = {}): ProviderKeyStore {
  return new ProviderKeyStore({ dir: path.join(cfg.hostPrivate, PROVIDER_AUTH_DIR), vaultKey: vaultKeySync(cfg.hostPrivate), ...o });
}
