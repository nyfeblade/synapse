import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { API_KEY_RE, maskApiKey, STR_AUTH } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { subkey, vaultKeySync } from "../secrets/crypto";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { requireAuthProxy, setAuthProxy, setAuthSource } from "./auth-env";
import { AuthProxy } from "./proxy";

interface Sealed { v: 1; iv: string; tag: string; ct: string }
/** `mode` is only in files written before synapse-public ("subscription" | "api-key"); it is ignored and dropped on the next save. */
interface OnDisk { key?: Sealed; savedAt?: number }

/**
 * The Anthropic API key (hostPrivate/anthropic-auth/auth.json, 0600): the only way Bots reach Claude. The key is
 * sealed with an HKDF subkey of the box vault key (hostPrivate/vault.key, a file: no keychain anywhere on this path;
 * AES-256-GCM, the pattern of the Google and MCP stores); only the save time is in the clear. The opened key lives in this object's memory and leaves it only
 * as ANTHROPIC_API_KEY in a Claude process's spawn env (auth-env.ts) and as the test request's x-api-key.
 */
export class AuthStore {
  private state: OnDisk;
  private key_: string | null = null;
  private gen = 0;

  constructor(private o: { dir: string; key: Uint8Array; now?: () => number; onChange?: () => void }) {
    // Migration (synapse-public): a file from before, in either old mode, keeps its API key if it has one; the old
    // "subscription" mode is ignored, so an install without a key asks for one. A key that no longer opens: no key.
    const raw = readJson<Partial<OnDisk>>(this.file, {});
    this.state = { ...(raw.key ? { key: raw.key } : {}), ...(raw.savedAt ? { savedAt: raw.savedAt } : {}) };
    this.key_ = raw.key ? this.open(raw.key) : null;
  }

  private get file(): string { return path.join(this.o.dir, "auth.json"); }

  apiKey(): string | null { return this.key_; }
  masked(): { masked: string; savedAt: number } | null { return this.key_ ? { masked: maskApiKey(this.key_), savedAt: this.state.savedAt ?? 0 } : null; }
  generation(): number { return this.gen; }

  /** In the Bot spawn key: a new key respawns a warm Bot on its next turn. */
  spawnKeyPart(): string {
    return `auth:api-key:${this.key_ ? createHash("sha256").update(this.key_).digest("hex").slice(0, 12) : "none"}`;
  }

  setApiKey(value: string): void {
    const k = value.trim();
    if (!API_KEY_RE.test(k)) throw new GatewayError("BAD_API_KEY", STR_AUTH.badKeyFormat);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.o.key, iv);
    const ct = Buffer.concat([c.update(k, "utf8"), c.final()]);
    this.state = { ...this.state, key: { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }, savedAt: (this.o.now ?? Date.now)() };
    this.key_ = k;
    this.save();
  }

  clearApiKey(): void {
    const { key: _k, savedAt: _s, ...rest } = this.state;
    this.state = rest;
    this.key_ = null;
    this.save();
  }

  private open(s: Sealed): string | null {
    try {
      const d = createDecipheriv("aes-256-gcm", this.o.key, Buffer.from(s.iv, "base64"));
      d.setAuthTag(Buffer.from(s.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
    } catch {
      return null; // another vault key (a reset box, a backup from elsewhere): no key
    }
  }

  private save(): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, this.state, 0o600);
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
