import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { FileKeyStore, isFileSealed, type SafeStore } from "./file-key-store";

/**
 * The one module that owns sealing in the main process (bug-log 279, keychain retired 2026-09-26).
 *
 * Every secret the app keeps on this Mac — the Bot secrets vault, secrets/<name>.bin (backup key, old update
 * token), the vault's hash key and the push (VAPID) private key — is sealed through `sealer`, a gate over the
 * profile's key file (file-key-store.ts). The macOS keychain is not used any more: with a self-signed build,
 * "Always Allow" did not survive an update, so every launch after one stopped on a keychain password prompt.
 *
 * The keychain is read at most once per profile, by the migration below, on the first launch that finds
 * keychain-sealed material and no `keychain-retired.json` marker. That launch leaves Chromium's real keychain
 * alone so the item can still be read, opens it only after the window is up (the gate stays closed until then,
 * which is what stops a keychain prompt from ever blocking the app's first frame), re-seals everything with the
 * key file and writes the marker. Every later launch appends Chromium's `use-mock-keychain` switch before `ready`,
 * so neither this app nor Chromium's own cookie encryption (OSCrypt) asks the keychain anything.
 *
 * safeStorage itself is still named only in keychain.ts (keychain-single-entry-point.test.ts), and only
 * index.ts imports that module, to hand the migration its one keychain read.
 */

export type SealStatus = "pending" | "ready" | "unavailable" | "blocked";
export type Verdict = "ok" | "unavailable" | "blocked";
export interface SealState {
  status: SealStatus;
  /** Some secrets sealed earlier could not be carried over and must be re-entered. */
  relocked: boolean;
  message: string | null;
}
/** The keychain as the migration sees it: whether it opened, and the store (safeStorage) that reads it. */
export interface LegacyKeychain { verdict: Verdict; store: SafeStore }
export type SealMode = "retired" | "migrate";

export const KEYCHAIN_RETIRED_FILE = "keychain-retired.json";
/** Review M3: launches that couldn't read the keychain, before the move gives up on it (the marker is final). */
export const KEYCHAIN_ATTEMPTS_FILE = "keychain-retire-attempts.json";
export const MAX_KEYCHAIN_ATTEMPTS = 3;
/** Byte-for-byte copies of every keychain-sealed file the migration found, kept so nothing is ever lost. */
export const KEYCHAIN_ARCHIVE_DIR = "keychain-sealed-backup";
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

export const SEAL_PENDING_MESSAGE = "Secrets aren't open yet. They open once the window is up.";
export const SEAL_BLOCKED_MESSAGE =
  "The app's key file (keys/seal.key in its data folder) isn't a private file owned by you, so secrets, the backup key and call alerts are unavailable.";
export const SEAL_UNAVAILABLE_MESSAGE =
  "The app couldn't create its key file in its data folder, so secrets, the backup key and call alerts are unavailable.";
export const KEYCHAIN_UNREADABLE_MESSAGE =
  "Some saved secrets couldn't be read from the macOS keychain while moving them to the app's own key file. The old copies are kept; re-enter those secrets to use them again.";
export const SEAL_KEY_MISSING_MESSAGE =
  "The app's key file (keys/seal.key in its data folder) is missing, so the secrets sealed with it can't be opened. Put the file back, or re-enter the secrets after removing the old ones.";
export const keychainDeferredMessage = (attempt: number): string =>
  `The macOS keychain didn't answer, so saved secrets stay closed this time. The app asks again next launch (try ${attempt} of ${MAX_KEYCHAIN_ATTEMPTS}).`;
export const MOVE_FAILED_MESSAGE =
  "Moving saved secrets out of the macOS keychain didn't finish, so secrets are unavailable until the app is reopened.";
export const SECRETS_RELOCKED_MESSAGE =
  "These secrets were sealed with a key this app no longer has and can't be unlocked. Re-enter them.";

export class SealGate {
  private st: SealState = { status: "pending", relocked: false, message: null };
  private opening: Promise<SealState> | null = null;
  private notify: ((s: SealState) => void) | undefined;
  private store: SafeStore | null;

  constructor(o: { store?: SafeStore; onState?: (s: SealState) => void } = {}) {
    this.store = o.store ?? null;
    this.notify = o.onState;
  }

  state(): SealState { return { ...this.st }; }

  /** The store the gate hands out once open (the profile's key file). Set before open(). */
  use(store: SafeStore): void { this.store = store; }

  onState(fn: (s: SealState) => void): void {
    this.notify = fn;
    fn(this.state());
  }

  /** Runs `prepare` at most once, however many callers ask. Anything but "ok" is a loud state. */
  async open(prepare: () => Promise<Verdict>): Promise<SealState> {
    this.opening ??= (async () => {
      let v: Verdict;
      try { v = await prepare(); } catch { v = "blocked"; }
      this.set(
        v === "ok" && this.store ? { status: "ready", message: this.st.relocked ? this.st.message : null }
        : v === "unavailable" ? { status: "unavailable", message: SEAL_UNAVAILABLE_MESSAGE }
        : { status: "blocked", message: SEAL_BLOCKED_MESSAGE },
      );
      return this.state();
    })();
    return this.opening;
  }

  /** An optional read: absent is a legitimate answer, so a closed gate degrades to `fallback`. */
  read<T>(fn: (s: SafeStore) => T, fallback: T): T {
    if (this.st.status !== "ready" || !this.store) return fallback;
    return fn(this.store);
  }

  /** A read or write the user asked for: a closed gate throws the reason, it never fails open. */
  require<T>(fn: (s: SafeStore) => T): T {
    if (this.st.status !== "ready" || !this.store) throw new Error(this.st.message ?? SEAL_PENDING_MESSAGE);
    return fn(this.store);
  }

  markRelocked(message: string): void { this.set({ relocked: true, message }); }

  /** Replaces the message of a closed gate with the specific reason (the status stays as it is). */
  explain(message: string): void { if (this.st.status !== "ready") this.set({ message }); }

  private set(p: Partial<SealState>): void {
    this.st = { ...this.st, ...p };
    this.notify?.(this.state());
  }
}

/** The app's gate. index.ts gives it the profile's FileKeyStore and opens it after the window is loaded. */
export const sealer = new SealGate();

/** The marker, read without following a link: only a plain file counts. */
export function keychainRetired(profileDir: string): boolean {
  try { return fs.lstatSync(path.join(profileDir, KEYCHAIN_RETIRED_FILE)).isFile(); } catch { return false; }
}

function writeMarker(profileDir: string, v: Record<string, unknown>): void {
  writeFileAtomic(path.join(profileDir, KEYCHAIN_RETIRED_FILE), JSON.stringify({ at: Date.now(), ...v }), 0o600);
}

/** One sealed value somewhere in the profile, found by path (relative to the profile). */
interface Item { id: string; rel: string; sealed: Buffer }

const readJson = (f: string): Record<string, unknown> | null => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>; } catch { return null; }
};
const isPlainFile = (f: string): boolean => { try { return fs.lstatSync(f).isFile(); } catch { return false; } };

/** Every sealed value in the profile, keychain-sealed or already moved. Names and paths only are ever logged. */
function sealedItems(profileDir: string): Item[] {
  const out: Item[] = [];
  const hk = path.join(profileDir, "secrets.hashkey.bin");
  if (isPlainFile(hk)) out.push({ id: "secrets.hashkey.bin", rel: "secrets.hashkey.bin", sealed: fs.readFileSync(hk) });
  const sec = path.join(profileDir, "secrets");
  let names: string[] = [];
  try { names = fs.readdirSync(sec).filter((n) => n.endsWith(".bin")).sort(); } catch { /* none */ }
  for (const n of names) {
    const f = path.join(sec, n);
    if (isPlainFile(f)) out.push({ id: `secrets/${n}`, rel: `secrets/${n}`, sealed: fs.readFileSync(f) });
  }
  const vault = readJson(path.join(profileDir, "secrets.vault.json"));
  const entries = Array.isArray(vault?.entries) ? (vault!.entries as { botId?: unknown; name?: unknown; ciphertext?: unknown }[]) : [];
  entries.forEach((e, i) => {
    if (typeof e?.ciphertext === "string") out.push({ id: `vault#${i}`, rel: "secrets.vault.json", sealed: Buffer.from(e.ciphertext, "base64") });
  });
  const phone = readJson(path.join(profileDir, "phone-access.json")) as { vapid?: { sealed?: unknown } } | null;
  if (typeof phone?.vapid?.sealed === "string") out.push({ id: "vapid", rel: "phone-access.json", sealed: Buffer.from(phone.vapid.sealed, "base64") });
  return out;
}

/**
 * Review B1: whether a brand-new key file may be made. Never while anything in the profile is sealed with a key
 * file: then a missing key is lost data to report, not to paper over. Re-review 2: that is the whole test — the
 * marker doesn't veto on its own, so a key lost after every secret was removed is simply made again.
 */
export function mayCreateKey(profileDir: string): boolean {
  return !sealedItems(profileDir).some((i) => isFileSealed(i.sealed));
}

function readAttempts(profileDir: string): number {
  const n = readJson(path.join(profileDir, KEYCHAIN_ATTEMPTS_FILE))?.attempts;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

/** True when the profile holds anything sealed (by the keychain or the key file). */
export function hasSealedMaterial(profileDir: string): boolean {
  return sealedItems(profileDir).length > 0;
}

/**
 * Before `app.whenReady()`. With the marker, or on a fresh profile with nothing sealed (which writes the marker
 * now, so the keychain is never touched at all), Chromium gets `use-mock-keychain`. Otherwise this is the one
 * migration launch: the real keychain stays reachable. The bounded probe child (keychain.ts) is always "migrate".
 */
export function prepareSealing(profileDir: string, commandLine: { appendSwitch(s: string): void }, o: { probeChild?: boolean } = {}): SealMode {
  if (o.probeChild) return "migrate";
  if (!keychainRetired(profileDir) && !hasSealedMaterial(profileDir)) {
    try { writeMarker(profileDir, { outcome: "fresh" }); } catch { return "migrate"; }
  }
  if (!keychainRetired(profileDir)) return "migrate";
  commandLine.appendSwitch(MOCK_KEYCHAIN_SWITCH);
  return "retired";
}

/** Copies a file into the archive once; a different copy already there is kept and this one gets a stamped name. */
function preserve(profileDir: string, rel: string): void {
  const src = path.join(profileDir, rel);
  const bytes = fs.readFileSync(src);
  let dst = path.join(profileDir, KEYCHAIN_ARCHIVE_DIR, rel);
  fs.mkdirSync(path.join(profileDir, KEYCHAIN_ARCHIVE_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  try {
    if (fs.readFileSync(dst).equals(bytes)) return;
    dst = `${dst}.${Date.now()}`;
  } catch { /* not archived yet */ }
  writeFileAtomic(dst, bytes, 0o600);
}

/**
 * The migration can leave secrets.hashkey.bin sealed by an older build's keychain item it couldn't open.
 * The hash key only fingerprints saved secrets (valueHash), so with none saved it is safe to replace:
 * it is archived with the other keychain-sealed originals and removed, and the next use makes a fresh
 * one under the key file. With saved secrets it is left alone, so the app keeps saying they must be
 * re-entered. A hash key already sealed with the key file is never touched. Returns true if it was retired.
 */
export function retireStaleHashKey(profileDir: string): boolean {
  const rel = "secrets.hashkey.bin", f = path.join(profileDir, rel);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(f); } catch { return false; }
  if (isFileSealed(bytes)) return false;
  let saved = 0;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(profileDir, "secrets.vault.json"), "utf8")) as { entries?: unknown };
    saved = Array.isArray(v.entries) ? v.entries.length : 1; // an odd vault counts as "has secrets": leave it alone
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  if (saved > 0) return false;
  preserve(profileDir, rel);
  fs.rmSync(f, { force: true });
  return true;
}

export interface RetireOutcome {
  /** "deferred": the keychain didn't answer on this launch; nothing was changed and no marker was written. */
  outcome: "already" | "fresh" | "migrated" | "unreadable" | "deferred";
  /** Launches so far that couldn't read the keychain (only for "deferred" / "unreadable"). */
  attempt?: number;
  moved: number;
  /** Profile-relative names of what couldn't be carried over (kept as they were, and in the archive). */
  unreadable: string[];
}

/**
 * The one-time move off the keychain. Safe to run again after a crash: values already sealed by the key file are
 * left alone. Original files are archived before anything is rewritten; every rewrite is atomic; the marker is
 * written last, and only for a definite, finished result.
 *
 * Review M3: a keychain that doesn't answer (blocked, unavailable, a timeout, a throw) changes nothing and writes no
 * marker — the next launch keeps the real keychain and asks again. Only after MAX_KEYCHAIN_ATTEMPTS such launches
 * does the move give up ("unreadable"): it deletes nothing (the files stay and are archived), sets aside the hash key
 * and push key — which would otherwise stop the user re-entering secrets or pairing again — and the caller shows
 * the re-enter state.
 */
export async function retireKeychain(o: {
  profileDir: string;
  files: SafeStore;
  legacy: () => Promise<LegacyKeychain>;
  log?: (s: string) => void;
}): Promise<RetireOutcome> {
  const log = o.log ?? ((s: string) => console.error(s));
  const d = o.profileDir;
  if (keychainRetired(d)) return { outcome: "already", moved: 0, unreadable: [] };
  const items = sealedItems(d);
  if (items.length === 0) {
    writeMarker(d, { outcome: "fresh" });
    return { outcome: "fresh", moved: 0, unreadable: [] };
  }
  if (!o.files.isEncryptionAvailable()) throw new Error("the key file can't be used, so nothing was moved");
  const pending = items.filter((i) => !isFileSealed(i.sealed));
  for (const rel of [...new Set(pending.map((i) => i.rel))]) preserve(d, rel);

  // The one keychain read of this profile's life.
  const plain = new Map<string, string>();
  let opened = false;
  if (pending.length) {
    let k: LegacyKeychain | null = null;
    try { k = await o.legacy(); } catch (e) { log(`keychain: couldn't be opened to move secrets (${(e as Error).message})`); }
    opened = k?.verdict === "ok";
    if (k && opened) {
      for (const i of pending) {
        try { plain.set(i.id, k.store.decryptString(i.sealed)); } catch { /* sealed by another build: stays as it is */ }
      }
    }
  }
  let attempt: number | undefined;
  if (pending.length && !opened) {
    attempt = readAttempts(d) + 1;
    if (attempt < MAX_KEYCHAIN_ATTEMPTS) {
      let counted = false;
      try {
        writeFileAtomic(path.join(d, KEYCHAIN_ATTEMPTS_FILE), JSON.stringify({ attempts: attempt, at: Date.now() }), 0o600);
        counted = true;
      } catch (e) {
        // Re-review 3: a count that can't be kept would ask on every launch forever; this is the last attempt.
        log(`keychain: couldn't record the attempt (${(e as Error).message}); giving up on the keychain now`);
        attempt = MAX_KEYCHAIN_ATTEMPTS;
      }
      if (counted) {
        log(`keychain: couldn't be read to move secrets (try ${attempt} of ${MAX_KEYCHAIN_ATTEMPTS}); nothing changed, asking again next launch`);
        return { outcome: "deferred", moved: 0, unreadable: [], attempt };
      }
    }
  }
  const lost = pending.filter((i) => !plain.has(i.id));
  const reseal = (id: string, fallback: Buffer): Buffer => (plain.has(id) ? o.files.encryptString(plain.get(id)!) : fallback);

  // secrets.hashkey.bin and secrets/*.bin: rewritten when opened; an unopened hash key is set aside (archived).
  for (const i of pending.filter((x) => x.rel === x.id)) {
    const f = path.join(d, i.rel);
    if (plain.has(i.id)) writeFileAtomic(f, reseal(i.id, i.sealed), 0o600);
    else if (i.id === "secrets.hashkey.bin") fs.unlinkSync(f);
  }
  // The vault: each opened entry re-sealed in place; names, hashes and the sync ledger untouched.
  if (pending.some((i) => i.id.startsWith("vault#"))) {
    const f = path.join(d, "secrets.vault.json");
    const v = readJson(f)!;
    const entries = v.entries as { ciphertext?: unknown }[];
    entries.forEach((e, idx) => {
      if (plain.has(`vault#${idx}`)) e.ciphertext = reseal(`vault#${idx}`, Buffer.alloc(0)).toString("base64");
    });
    writeFileAtomic(f, JSON.stringify(v), 0o600);
  }
  // The push key: re-sealed, or (unopened) set aside so the next pairing makes a new pair; phones stay paired.
  if (pending.some((i) => i.id === "vapid")) {
    const f = path.join(d, "phone-access.json");
    const p = readJson(f) as { vapid: { sealed: string } | null; subs?: unknown[] };
    if (plain.has("vapid")) p.vapid!.sealed = reseal("vapid", Buffer.alloc(0)).toString("base64");
    else { p.vapid = null; p.subs = []; }
    writeFileAtomic(f, JSON.stringify(p, null, 2), 0o600);
  }

  const unreadable = [...new Set(lost.map((i) => i.rel))];
  const outcome: RetireOutcome["outcome"] = pending.length && !opened ? "unreadable" : "migrated";
  writeMarker(d, { outcome, moved: plain.size, unreadable, archive: KEYCHAIN_ARCHIVE_DIR, ...(attempt ? { attempts: attempt } : {}) });
  try { fs.rmSync(path.join(d, KEYCHAIN_ATTEMPTS_FILE), { recursive: true, force: true }); } catch { /* none */ }
  log(`keychain: retired (${outcome}); ${plain.size} sealed value(s) moved to the key file${unreadable.length ? `, kept as they were: ${unreadable.join(", ")}` : ""}`);
  return { outcome, moved: plain.size, unreadable, ...(attempt ? { attempt } : {}) };
}

/**
 * Opens the gate on the profile's key file. In "migrate" mode it first runs the one-time move (the only keychain
 * read); in "retired" mode `legacy` is never called. Something that couldn't be carried over raises the visible
 * re-enter state; the gate still opens, so the app works.
 */
export async function openSealing(o: {
  gate: SealGate;
  mode: SealMode;
  profileDir: string;
  files: FileKeyStore;
  legacy: () => Promise<LegacyKeychain>;
  log?: (s: string) => void;
}): Promise<SealState> {
  o.gate.use(o.files);
  o.files.setCreateGuard(() => mayCreateKey(o.profileDir));
  let lostSome = false;
  let moveFailed = false;
  let keyMissing = false;
  let deferred: number | null = null;
  const st = await o.gate.open(async () => {
    if (!o.files.isEncryptionAvailable()) {
      keyMissing = o.files.problem() === "missing";
      return o.files.problem() === "create-failed" ? "unavailable" : "blocked";
    }
    if (o.mode === "migrate") {
      try {
        const r = await retireKeychain({ profileDir: o.profileDir, files: o.files, legacy: o.legacy, log: o.log });
        // Deferred: the old values are still keychain-sealed, so nothing may be sealed or read over them this launch.
        if (r.outcome === "deferred") { deferred = r.attempt ?? 1; return "blocked"; }
        lostSome = r.outcome === "unreadable" || r.unreadable.length > 0;
      } catch (e) {
        // No marker was written, so the next launch picks up where this one stopped; until then nothing is sealed
        // or read, rather than mixing half-moved values.
        (o.log ?? console.error)(`keychain: moving secrets to the key file stopped: ${(e as Error).message}`);
        moveFailed = true;
        return "blocked";
      }
    }
    return "ok";
  });
  if (moveFailed) o.gate.explain(MOVE_FAILED_MESSAGE);
  if (keyMissing) o.gate.explain(SEAL_KEY_MISSING_MESSAGE);
  if (deferred !== null) o.gate.explain(keychainDeferredMessage(deferred));
  if (lostSome && st.status === "ready") o.gate.markRelocked(KEYCHAIN_UNREADABLE_MESSAGE);
  return o.gate.state();
}
