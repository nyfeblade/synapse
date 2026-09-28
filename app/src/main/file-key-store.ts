import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Keychain retired (owner's decision 2026-09-26, bug-log 279). The app's sealing key is a random 32-byte file in
 * its own data folder — `<profile>/keys/seal.key`, 0600 in a 0700 folder — and values are sealed with AES-256-GCM.
 * No macOS keychain, so no password prompt after an update and nothing that can stall the main thread.
 *
 * The trade-off is accepted and written down (docs/decisions.md): another app running as the same user can read
 * this file. The Bots cannot: every Mac command runs in a sandbox that read-denies the whole data folder
 * (coordinator/local-exec/executor.ts ownDataSandboxProfile), and the static NEVER wall covers it too.
 *
 * Sealed format: SEAL_PREFIX (8 bytes, "SYNSEAL" + version 1) | IV (12) | tag (16) | ciphertext. The prefix is also
 * the GCM additional data, and safeStorage's own output starts with "v10"/"v11", so the two can never be confused.
 */
export interface SafeStore {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export const SEAL_KEY_DIR = "keys";
export const SEAL_KEY_FILE = "seal.key";
export const SEAL_PREFIX = Buffer.from("SYNSEAL\x01", "latin1");
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** "missing": there is no key file, yet the profile holds data sealed with one — a new key would orphan it. */
export type KeyProblem = "missing" | "symlink" | "not-a-file" | "not-a-folder" | "owner" | "permissions" | "size" | "unreadable" | "create-failed";

/** True when these bytes were sealed by a FileKeyStore (any key), never by safeStorage. */
export function isFileSealed(b: Buffer): boolean {
  return b.length >= SEAL_PREFIX.length && b.subarray(0, SEAL_PREFIX.length).equals(SEAL_PREFIX);
}

export class FileKeyStore implements SafeStore {
  private key: Buffer | null = null;
  private refused: KeyProblem | null = null;
  private readonly dir: string;
  private readonly file: string;
  private readonly uid: number;
  /** Re-review 5: a key is only ever made where a guard says so; with none, a missing key stays "missing". */
  private mayCreate: () => boolean;

  constructor(profileDir: string, o: { uid?: number; mayCreate?: () => boolean } = {}) {
    this.mayCreate = o.mayCreate ?? (() => false);
    this.dir = path.join(profileDir, SEAL_KEY_DIR);
    this.file = path.join(this.dir, SEAL_KEY_FILE);
    this.uid = o.uid ?? process.getuid?.() ?? 0;
  }

  /**
   * Review B1: asked before a key is ever created. sealing.ts answers "no" while the profile holds anything sealed
   * with a key file (or its marker says the move finished): a missing key then stays a loud "missing", never a new
   * key that would leave everything sealed before it unreadable and mix two keys.
   */
  setCreateGuard(fn: () => boolean): void { this.mayCreate = fn; }

  /** Why the key can't be used (null when it can, or has not been looked at yet). */
  problem(): KeyProblem | null { return this.refused; }

  /** Loads the key, creating it once when there is none. Never overwrites or follows a link. */
  isEncryptionAvailable(): boolean { return this.load(true) !== null; }

  encryptString(s: string): Buffer {
    const key = this.load(true);
    if (!key) throw new Error(`The app's key file can't be used (${this.refused ?? "unknown"}).`);
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(SEAL_PREFIX);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return Buffer.concat([SEAL_PREFIX, iv, c.getAuthTag(), ct]);
  }

  decryptString(b: Buffer): string {
    if (!isFileSealed(b) || b.length < SEAL_PREFIX.length + IV_BYTES + TAG_BYTES) throw new Error("Not sealed with this app's key file.");
    const key = this.load(false);
    if (!key) throw new Error(`The app's key file can't be used (${this.refused ?? "missing"}).`);
    const at = SEAL_PREFIX.length;
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(at, at + IV_BYTES));
    d.setAAD(SEAL_PREFIX);
    d.setAuthTag(b.subarray(at + IV_BYTES, at + IV_BYTES + TAG_BYTES));
    // A wrong key or any changed byte fails the tag check here and throws.
    return Buffer.concat([d.update(b.subarray(at + IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
  }

  private load(create: boolean): Buffer | null {
    if (this.key) return this.key;
    this.refused = null;
    if (!this.ensureDir(create)) return null;
    const existing = this.read();
    if (existing || this.refused || !create) return existing;
    let allowed = false;
    try { allowed = this.mayCreate(); } catch { allowed = false; }
    if (!allowed) { this.refused = "missing"; return null; }
    try { this.create(); } catch { this.refused = "create-failed"; return null; }
    return this.read();
  }

  /** The 0700 key folder: made if missing, tightened if ours but too open, refused if it's a link or someone else's. */
  private ensureDir(create: boolean): boolean {
    if (create && !fs.existsSync(this.dir)) {
      // Review B1: not even the folder is made where a key would be refused.
      let allowed = false;
      try { allowed = this.mayCreate(); } catch { allowed = false; }
      if (!allowed) { this.refused = "missing"; return false; }
    }
    let st: fs.Stats;
    try { st = fs.lstatSync(this.dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { this.refused = "unreadable"; return false; }
      if (!create) return false;
      try { fs.mkdirSync(this.dir, { mode: 0o700 }); } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") { this.refused = "create-failed"; return false; }
      }
      try { st = fs.lstatSync(this.dir); } catch { this.refused = "unreadable"; return false; }
    }
    if (st.isSymbolicLink()) { this.refused = "symlink"; return false; }
    if (!st.isDirectory()) { this.refused = "not-a-folder"; return false; }
    if (st.uid !== this.uid) { this.refused = "owner"; return false; }
    if ((st.mode & 0o777) !== 0o700) {
      // Tightened through a descriptor opened without following a link, and only if it is still the folder checked.
      let fd: number | null = null;
      try {
        fd = fs.openSync(this.dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
        const f = fs.fstatSync(fd);
        if (!f.isDirectory() || f.ino !== st.ino || f.uid !== this.uid) { this.refused = "permissions"; return false; }
        fs.fchmodSync(fd, 0o700);
      } catch { this.refused = "permissions"; return false; } finally { if (fd !== null) fs.closeSync(fd); }
    }
    return true;
  }

  /** Reads the key without following a link; refuses one that isn't a private, 32-byte file of ours. */
  private read(): Buffer | null {
    let st: fs.Stats;
    try { st = fs.lstatSync(this.file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.refused = "unreadable";
      return null;
    }
    if (st.isSymbolicLink()) { this.refused = "symlink"; return null; }
    if (!st.isFile()) { this.refused = "not-a-file"; return null; }
    if (st.uid !== this.uid) { this.refused = "owner"; return null; }
    if ((st.mode & 0o077) !== 0) { this.refused = "permissions"; return null; }
    if (st.size !== KEY_BYTES) { this.refused = "size"; return null; }
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { this.refused = "unreadable"; return null; }
    try {
      const f = fs.fstatSync(fd);
      if (!f.isFile() || f.ino !== st.ino || f.size !== KEY_BYTES) { this.refused = "unreadable"; return null; }
      const key = Buffer.alloc(KEY_BYTES);
      if (fs.readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) { this.refused = "unreadable"; return null; }
      this.key = key;
      return key;
    } catch { this.refused = "unreadable"; return null; } finally { fs.closeSync(fd); }
  }

  /**
   * A new key, atomically: a private temp file made with O_EXCL|O_NOFOLLOW, fsync'd, then linked into place. A link
   * is the rename that can't replace an existing file, so two instances racing both end up on the first key made.
   */
  private create(): void {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600); // the umask can't widen it, and nothing is ever chmod'ed by path
      fs.writeSync(fd, randomBytes(KEY_BYTES));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      fs.linkSync(tmp, this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another instance made one first: use theirs
    } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    // The new name is durable only once its folder is: fsync keys/ after the link (and the unlink).
    let dfd: number | null = null;
    try {
      dfd = fs.openSync(this.dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
      fs.fsyncSync(dfd);
    } catch { /* best effort: the key itself is already fsync'd */ } finally { if (dfd !== null) fs.closeSync(dfd); }
  }
}
