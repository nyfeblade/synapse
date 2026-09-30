import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OFFERED_PROVIDERS, isLocalProvider, type ProviderId } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { PROVIDER_AUTH_DIR } from "./provider-keys";

/**
 * Any-key setup (Wave 2): which providers are set up well enough to finish first-run setup without an Anthropic key.
 *
 * A provider counts once it is consented and
 * - with a key: that exact saved key worked (Test key answered OK, or a real call with it succeeded), or
 * - on this Mac: it answered a Test.
 * A key that worked is remembered by the time it was saved, so replacing it asks for a working key again; removing it,
 * or a 401 from the provider, forgets it.
 *
 * The account's provider (the one setup chose) is kept too: host-level helpers run on it and new Bots get its main
 * model. Kept beside the consent in hostPrivate/provider-auth (0600), not in the host settings.
 */
type P = Exclude<ProviderId, "anthropic">;
interface OnDisk { working: Partial<Record<P, number>>; account: P | null }
/** The order a working provider is picked in when setup didn't record one (the account helper's order). */
const ORDER: readonly P[] = ["openai", "gemini", "openrouter", "mistral", "deepseek", "ollama", "lmstudio"];
/** A candidate key's Test answered this recently: saving that same key counts as a working key. */
const CANDIDATE_TTL_MS = 10 * 60_000;

export interface ProviderSetupDeps {
  dir: string;
  consented(p: P): boolean;
  /** The saved key's savedAt, or null for none. */
  keySavedAt(p: P): number | null;
  now?: () => number;
}

export class ProviderSetupStore {
  private state: OnDisk;
  private candidates = new Map<P, { hash: string; at: number }>();
  constructor(private d: ProviderSetupDeps) {
    const raw = readJson<Partial<OnDisk>>(this.file, {});
    const working = raw.working && typeof raw.working === "object" ? raw.working : {};
    const account = typeof raw.account === "string" && (OFFERED_PROVIDERS as readonly string[]).includes(raw.account) ? raw.account : null;
    this.state = { working, account };
  }
  private get file(): string { return path.join(this.d.dir, "setup.json"); }
  private now(): number { return (this.d.now ?? Date.now)(); }

  /** The provider is consented and its saved key (or, on this Mac, the app) worked. */
  working(p: P): boolean {
    if (!this.d.consented(p)) return false;
    const at = this.state.working[p];
    if (at === undefined) return false;
    if (isLocalProvider(p)) return true;
    const saved = this.d.keySavedAt(p);
    return saved !== null && saved === at;
  }

  /** Any provider works: first-run setup can finish without an Anthropic key. */
  ready(): boolean {
    return OFFERED_PROVIDERS.some((p) => this.working(p));
  }

  /** The account's provider: the one setup chose while it still works, else the first working one. */
  account(): P | null {
    const a = this.state.account;
    if (a && this.working(a)) return a;
    return ORDER.find((p) => this.working(p)) ?? null;
  }

  /** The saved key (or the app on this Mac) just answered. The first provider to work becomes the account's. */
  markWorking(p: P): void {
    const at = isLocalProvider(p) ? 1 : this.d.keySavedAt(p);
    if (at === null) return;
    if (this.state.working[p] === at && this.state.account && this.working(this.state.account)) return;
    this.state.working[p] = at;
    if (!this.state.account || !this.working(this.state.account)) this.state.account = p;
    this.save();
  }

  /** The key was removed or rejected: it no longer counts. */
  forget(p: P): void {
    if (this.state.working[p] === undefined) return;
    delete this.state.working[p];
    this.save();
  }

  /** A typed key's Test answered OK: saving that same key next counts as a working key (no second paid call). */
  noteCandidateWorked(p: P, key: string): void {
    this.candidates.set(p, { hash: hashKey(key), at: this.now() });
  }

  /** A key was just saved: it works if its Test answered OK moments ago; otherwise it has to be tested again. */
  keySaved(p: P, key: string): void {
    const c = this.candidates.get(p);
    this.candidates.delete(p);
    if (c && c.hash === hashKey(key) && this.now() - c.at < CANDIDATE_TTL_MS) this.markWorking(p);
    else this.forget(p);
  }

  private save(): void {
    fs.mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, this.state, 0o600);
  }
}

const hashKey = (k: string) => createHash("sha256").update(k.trim()).digest("hex");

export function providerSetupStoreFor(cfg: { hostPrivate: string }, o: Omit<ProviderSetupDeps, "dir">): ProviderSetupStore {
  return new ProviderSetupStore({ dir: path.join(cfg.hostPrivate, PROVIDER_AUTH_DIR), ...o });
}
