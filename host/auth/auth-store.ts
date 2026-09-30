import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { API_KEY_RE, maskApiKey, STR_AUTH } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { subkey, vaultKeySync } from "../secrets/crypto";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { requireAuthProxy, setAuthProxy, setAuthSource } from "./auth-env";
import { AuthProxy } from "./proxy";
import { KeyRing, type RingDisk, type RingKey, type Sealed } from "./key-ring";

/** `mode` is only in files written before synapse-public ("subscription" | "api-key"); it is ignored and dropped on the next save. */
interface LegacyDisk { key?: Sealed; savedAt?: number }
/** 0.1.7: several Anthropic keys (key-ring.ts). */
interface OnDisk extends RingDisk { v: 2 }
/** The id a migrated single key (and the first key) gets. */
export const ANTHROPIC_FIRST_KEY_ID = "k1";

/**
 * The Anthropic API keys (hostPrivate/anthropic-auth/auth.json, 0600): the only way Bots reach Claude. Since 0.1.7 a
 * ring of named keys (key-ring.ts), the first one the default; a Bot may pay with another (BotProfile.modelKeys), which
 * the key proxy picks per call. Each key is sealed with an HKDF subkey of the box vault key (hostPrivate/vault.key, a
 * file: no keychain anywhere on this path; AES-256-GCM, the pattern of the Google and MCP stores); only ids, labels and
 * save times are in the clear. Opened keys live in this object's memory and leave it only as the x-api-key the auth
 * proxy adds (auth-env.ts, proxy.ts) and as the test request's x-api-key.
 *
 * Migration: a file from before (`{ key, savedAt }`) becomes the default key, labelled "Anthropic", written back at once.
 */
export class AuthStore {
  private ring: KeyRing;
  private gen = 0;

  constructor(private o: { dir: string; key: Uint8Array; now?: () => number; onChange?: () => void }) {
    // Migration (synapse-public): a file from before, in either old mode, keeps its API key if it has one; the old
    // "subscription" mode is ignored, so an install without a key asks for one. A key that no longer opens: no key.
    const raw = readJson<Partial<OnDisk> & LegacyDisk>(this.file, {});
    if (raw.v === 2) this.ring = new KeyRing(o.key, raw);
    else {
      this.ring = new KeyRing(o.key, raw.key ? { entries: [{ id: ANTHROPIC_FIRST_KEY_ID, label: "Anthropic", key: raw.key, savedAt: raw.savedAt ?? 0 }], defaultId: ANTHROPIC_FIRST_KEY_ID } : null);
      if (raw.key) this.write(); // silently, in the new shape
    }
  }

  private get file(): string { return path.join(this.o.dir, "auth.json"); }
  private now(): number { return (this.o.now ?? Date.now)(); }

  /** The default key. */
  apiKey(): string | null { return this.ring.key(); }
  /** `id`'s key, or the default. Read by the key proxy's credential lookup only (app.ts). */
  key(id?: string | null): string | null { return this.ring.key(id); }
  has(id?: string | null): boolean { return this.ring.has(id); }
  /** The key a call uses: `want` while it's saved, else the default. */
  resolve(want?: string | null): string | null { return this.ring.resolve(want); }
  defaultId(): string | null { return this.ring.defaultId(); }
  list(): RingKey[] { return this.ring.list(); }
  entry(id: string): RingKey | null { return this.ring.entry(id); }
  masked(id?: string | null): { masked: string; savedAt: number } | null {
    const kid = id ?? this.ring.defaultId();
    const k = kid ? this.ring.key(kid) : null;
    return k && kid ? { masked: maskApiKey(k), savedAt: this.ring.entry(kid)?.savedAt ?? 0 } : null;
  }
  generation(): number { return this.gen; }

  /** In the Bot spawn key: a new default key respawns a warm Bot on its next turn. */
  spawnKeyPart(): string {
    const k = this.ring.key();
    return `auth:api-key:${k ? createHash("sha256").update(k).digest("hex").slice(0, 12) : "none"}`;
  }

  private check(value: string): string {
    const k = String(value ?? "").trim();
    if (!API_KEY_RE.test(k)) throw new GatewayError("BAD_API_KEY", STR_AUTH.badKeyFormat);
    return k;
  }

  /** Replaces the default key (or saves the first). */
  setApiKey(value: string): void {
    this.ring.replaceDefault(this.check(value), "Anthropic", this.now(), ANTHROPIC_FIRST_KEY_ID);
    this.save();
  }
  /** Another key; the first one is the default. Returns its id. */
  add(value: string, label: string): string {
    const id = this.ring.add(this.check(value), label || "Anthropic", this.now(), this.ring.size ? undefined : ANTHROPIC_FIRST_KEY_ID);
    this.save();
    return id;
  }
  rename(id: string, label: string): void { this.ring.rename(id, label); this.save(); }
  setDefault(id: string): void { this.ring.setDefault(id); this.save(); }
  setCap(id: string, capUsd: number | null): void { this.ring.setCap(id, capUsd); this.save(); }
  remove(id: string): void { this.ring.remove(id); this.save(); }

  /** The default key goes (the next oldest becomes the default). */
  clearApiKey(): void {
    const d = this.ring.defaultId();
    if (d) this.ring.remove(d);
    this.save();
  }

  private write(): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, { v: 2, ...this.ring.toDisk() } satisfies OnDisk, 0o600);
  }

  private save(): void {
    this.write();
    this.gen++;
    this.o.onChange?.();
  }
}

export const AUTH_DIR = "anthropic-auth";

export function authStoreFor(cfg: HostConfig, o: { now?: () => number; onChange?: () => void } = {}): AuthStore {
  return new AuthStore({ dir: path.join(cfg.hostPrivate, AUTH_DIR), key: subkey(vaultKeySync(cfg.hostPrivate), "bots/anthropic-api-key/v1"), ...o });
}

/** The Claude login token the old subscription sign-in left on the box, in the host's own private dir (before synapse-public). */
export const LEGACY_CLAUDE_TOKEN_FILE = "claude-oauth-token";
/** The token file and the temp files an interrupted atomic write of it could leave (review round 2, S5). */
export const LEGACY_CLAUDE_TOKEN_RE = /^claude-oauth-token(?:\.tmp|\..+\.tmp)?$/;

/**
 * Migration (synapse-public): the box's old Claude login token goes at boot, so nothing can pick it up by accident. Only
 * the file in the host's own private dir: nothing outside the app's data is ever touched (a custom CLAUDE_TOKEN_FILE
 * path is no longer read, and is left alone). The API key (if one was saved) stays; with none, Bots wait for one.
 */
export function retireClaudeLogin(cfg: Pick<HostConfig, "hostPrivate">, _env: Record<string, string | undefined> = process.env): boolean {
  let names: string[];
  try { names = fs.readdirSync(cfg.hostPrivate); } catch { return false; }
  let removed = false;
  for (const n of names.filter((x) => LEGACY_CLAUDE_TOKEN_RE.test(x))) {
    const f = path.join(cfg.hostPrivate, n);
    try {
      if (!fs.lstatSync(f).isFile()) continue; // never follow a link out of the app's data
      fs.rmSync(f);
      removed = true;
    } catch { /* gone meanwhile */ }
  }
  return removed;
}

/**
 * Evals and the conformance CLI (their own processes on the box): every model call uses the box's saved API key,
 * through a key proxy of their own, as the host's calls do: an ephemeral loopback port for this process only
 * (unref'd, so it never keeps the process alive), a per-spawn token in each Claude process, never the key. The proxy
 * is required: if it can't start, calls are refused (fail closed). With no key saved, calls fail (AuthMissingError).
 */
export async function useSavedAuth(cfg: HostConfig): Promise<{ store: AuthStore; stop(): Promise<void> }> {
  const store = authStoreFor(cfg);
  setAuthSource(store);
  requireAuthProxy(true);
  const p = new AuthProxy({ upstream: cfg.authProxy.upstream, port: 0, credential: () => store.apiKey(), unref: true });
  try {
    await p.start();
    setAuthProxy(p);
  } catch (e) {
    console.error(`auth proxy could not start; calls are refused (${(e as Error).message})`);
  }
  return { store, stop: async () => { setAuthProxy(null); requireAuthProxy(false); setAuthSource(null); await p.stop(); } };
}
