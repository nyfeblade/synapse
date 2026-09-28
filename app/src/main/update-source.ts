import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { validFeed } from "./native/updater";

/**
 * Where updates come from: the private GitHub repo (owner/repo) and its read-only token. They lived in the
 * keychain (readSecret/storeSecret), and a relocked keychain namespace — which is what broke the permission
 * switches (bug 225) — would have broken updates the same silent way. They live in the profile now, the way
 * local-policy.key does: plain 0600 files owned by the user, the token encrypted at rest (AES-256-GCM) under
 * a random key in a second 0600 file. The Bots can't reach either: the whole profile folder is behind the
 * NEVER wall of every Mac tool and the executor's sandbox.
 */
export const UPDATE_SOURCE_FILE = "update-source.json";
export const UPDATE_KEY_FILE = "update-source.key";
const KEY_BYTES = 32;

interface Sealed { iv: string; tag: string; ct: string }
interface OnDisk { v: 1; feed: string | null; token: Sealed | null; migrated?: boolean }

/** The key file, read without following a link and refused unless it is ours, private and the right size. */
function readKey(file: string): Buffer | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size !== KEY_BYTES) return null;
  if (process.getuid && st.uid !== process.getuid()) return null;
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try {
    const key = Buffer.alloc(KEY_BYTES);
    return fs.readSync(fd, key, 0, KEY_BYTES, 0) === KEY_BYTES ? key : null;
  } finally { fs.closeSync(fd); }
}

function keyFor(ud: string, create: boolean): Buffer | null {
  const file = path.join(ud, UPDATE_KEY_FILE);
  const have = readKey(file);
  if (have || !create) return have;
  if (fs.existsSync(file) || isLink(file)) return null; // present but refused: never overwrite it silently
  fs.mkdirSync(ud, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  try { fs.linkSync(tmp, file); } catch { /* another writer won: use theirs */ } finally { fs.rmSync(tmp, { force: true }); }
  return readKey(file);
}

function isLink(p: string): boolean { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

function seal(key: Buffer, text: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("bots/update-token/v1"));
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function open(key: Buffer, s: Sealed): string | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from("bots/update-token/v1"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
  } catch { return null; }
}

function readFile(ud: string): OnDisk {
  try {
    const f = path.join(ud, UPDATE_SOURCE_FILE);
    if (isLink(f)) return { v: 1, feed: null, token: null };
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<OnDisk>;
    return { v: 1, feed: validFeed(j.feed) ? j.feed! : null, token: j.token && typeof j.token === "object" ? j.token : null, migrated: j.migrated === true };
  } catch {
    return { v: 1, feed: null, token: null };
  }
}

function writeFile(ud: string, d: OnDisk): void {
  fs.mkdirSync(ud, { recursive: true });
  writeFileAtomic(path.join(ud, UPDATE_SOURCE_FILE), JSON.stringify(d, null, 2), 0o600);
}

/** The public repo: where a fresh install looks for updates until the user saves another feed. */
export const PUBLIC_UPDATE_FEED = "nyfeblade/synapse";
/** The feed the updater uses: the one the user saved, or the public repo. */
export function effectiveFeed(saved: string | null): string {
  return saved ?? PUBLIC_UPDATE_FEED;
}

export function readUpdateSource(ud: string): { feed: string | null; token: string | null } {
  const d = readFile(ud);
  const key = d.token ? keyFor(ud, false) : null;
  return { feed: d.feed, token: d.token && key ? open(key, d.token) : null };
}

/** Patch the feed and/or the token; an empty string clears that one. */
export function writeUpdateSource(ud: string, patch: { feed?: string; token?: string }): void {
  const d = readFile(ud);
  if (patch.feed !== undefined) {
    const f = patch.feed.trim();
    if (f && !validFeed(f)) throw new Error("The update source must be owner/repo.");
    d.feed = f || null;
  }
  if (patch.token !== undefined) {
    const t = patch.token.trim();
    if (!t) d.token = null;
    else {
      const key = keyFor(ud, true);
      if (!key) throw new Error("The update token's key file can't be used (it must be a private file of yours).");
      d.token = seal(key, t);
    }
  }
  writeFile(ud, d);
}

/**
 * One-time move from the keychain, when it can be read: the values are copied into the file and the file
 * remembers it has migrated, so a keychain that later changes never overwrites what the user set here.
 */
export function migrateUpdateSourceFromKeychain(ud: string, k: { readable: boolean; read(name: "updateFeed" | "updateToken"): string | null }): boolean {
  if (!k.readable) return false;
  const d = readFile(ud);
  if (d.migrated) return false;
  const feed = k.read("updateFeed");
  const token = k.read("updateToken");
  if (feed && validFeed(feed) && !d.feed) d.feed = feed;
  if (token && !d.token) {
    const key = keyFor(ud, true);
    if (key) d.token = seal(key, token);
  }
  d.migrated = true;
  writeFile(ud, d);
  return true;
}
