import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeRaw } from "./policy-io";

/**
 * policy-key-file (bug 225): the HMAC key for this Mac's permission files. A random 32-byte key kept in the profile
 * as `local-policy.key` (0600, owned by the user, written atomically, created once) — never the keychain and never the
 * build's code identity, so a switch stays on across launches, reinstalls and re-signing. It used to be an HKDF
 * subkey of the keychain-sealed hash key: a relocked keychain namespace made every permission switch refuse.
 *
 * The Bots can't reach it: the whole profile folder is behind the NEVER wall of every Mac tool (perm-rules.ts
 * secretExfil / isProtectedStore, the executor's protected paths).
 */
export const POLICY_KEY_FILE = "local-policy.key";

/** Every file the policy store signs (policy.ts). */
export const POLICY_FILES = [
  "computers.json", "local-tool-approvals.json", "local-tool-grants.json", "local-tool-retirements.json",
  "local-exec-delivered.json", "local-bot-modes.json", "local-bot-mode-declines.json", "local-browser-origins.json",
  "local-policy-reset.json",
] as const;

/** Bug 256: signed with the new key when earlier permission files couldn't be carried over (or after Reset permissions),
 *  so the app shows ONE "Your Mac permissions were reset" prompt instead of a silent card per command. */
export const POLICY_RESET_FILE = "local-policy-reset.json";

function markReset(dir: string, key: Buffer, lost: string[]): void {
  const data = { at: Date.now(), lost };
  writeRaw(path.join(dir, POLICY_RESET_FILE), { data, mac: policyMac(key, POLICY_RESET_FILE, data) });
}

const KEY_BYTES = 32;

export type PolicyKeyResult =
  | { ok: true; key: Buffer; created: boolean }
  | { ok: false; reason: "symlink" | "not-a-file" | "permissions" | "owner" | "size" | "unreadable" | "sound" };

export function policyMac(key: Buffer, name: string, data: unknown): string {
  return createHmac("sha256", key).update(`${name}\0${JSON.stringify(data)}`).digest("hex");
}

function verifies(key: Buffer, name: string, raw: { data?: unknown; mac?: unknown } | null): boolean {
  if (!raw || typeof raw.mac !== "string" || !("data" in raw)) return false;
  const want = Buffer.from(policyMac(key, name, raw.data), "hex");
  const got = Buffer.from(raw.mac, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Reads an existing key file without following a link, and refuses one that is anything but ours and private. */
function readKey(file: string, uid: number): PolicyKeyResult | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, reason: "unreadable" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!st.isFile()) return { ok: false, reason: "not-a-file" };
  if (st.uid !== uid) return { ok: false, reason: "owner" };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: "permissions" };
  if (st.size !== KEY_BYTES) return { ok: false, reason: "size" };
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return { ok: false, reason: "unreadable" }; }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile() || f.ino !== st.ino || f.size !== KEY_BYTES) return { ok: false, reason: "unreadable" };
    const key = Buffer.alloc(KEY_BYTES);
    if (fs.readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) return { ok: false, reason: "unreadable" };
    return { ok: true, key, created: false };
  } catch { return { ok: false, reason: "unreadable" }; } finally { fs.closeSync(fd); }
}

/** Writes a new key atomically: a private temp file, fsync'd, then hard-linked into place (never over an existing one). */
function createKey(file: string): boolean {
  const key = randomBytes(KEY_BYTES);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, key);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.chmodSync(tmp, 0o600);
    fs.linkSync(tmp, file); // EEXIST: another instance made one first — use theirs
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

/**
 * Carries the files signed by the old keychain-derived key over to the new key: a file that verifies with the old
 * key is re-signed; one that verifies with neither is unrecoverable and is left for the store to ignore (it falls
 * back to Ask) — one log line names them, and the user re-toggles once.
 */
function migrate(dir: string, key: Buffer, legacyKey: Buffer | undefined, log: (s: string) => void): void {
  const lost: string[] = [];
  for (const name of POLICY_FILES) {
    const f = path.join(dir, name);
    let raw: { data?: unknown; mac?: unknown } | null;
    try { raw = JSON.parse(fs.readFileSync(f, "utf8")) as { data?: unknown; mac?: unknown }; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      raw = null;
    }
    if (verifies(key, name, raw)) continue;
    if (legacyKey && raw && verifies(legacyKey, name, raw)) {
      writeRaw(f, { data: raw.data, mac: policyMac(key, name, raw.data) });
      continue;
    }
    lost.push(name);
  }
  if (lost.length) markReset(dir, key, lost);
  if (lost.length) log(`local-exec: new permission key; ${lost.length} earlier permission file(s) could not be verified and start fresh (${lost.join(", ")}) — switch those permissions on again once.`);
}

/**
 * The permission key for this profile: read it, or create it once (then migrate the files an older build signed with
 * the keychain-derived key). A key file that is a link, not a plain file, someone else's, readable by others or the
 * wrong size is refused: the caller fails closed and Settings offers Reset permissions.
 */
export function loadPolicyKey(dir: string, o: { legacyKey?: Buffer; log?: (s: string) => void; uid?: number } = {}): PolicyKeyResult {
  const file = path.join(dir, POLICY_KEY_FILE);
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const existing = readKey(file, uid);
  if (existing) return existing;
  fs.mkdirSync(dir, { recursive: true });
  const mine = createKey(file);
  const r = readKey(file, uid);
  if (!r) return { ok: false, reason: "unreadable" };
  if (!r.ok || !mine) return r;
  migrate(dir, r.key, o.legacyKey, o.log ?? ((s) => console.error(s)));
  return { ...r, created: true };
}

/** The key file's state now, without creating one: null when there is none. */
export function inspectPolicyKey(dir: string, o: { uid?: number } = {}): PolicyKeyResult | null {
  return readKey(path.join(dir, POLICY_KEY_FILE), o.uid ?? process.getuid?.() ?? 0);
}

/** Reset permissions: a new key and fresh files. Removes the key path itself (never a link's target) and the signed files.
 *  Bug 229: refused (ok: false, nothing touched) while the key file is sound. */
export function resetPolicyKey(dir: string, o: { uid?: number } = {}): PolicyKeyResult {
  const file = path.join(dir, POLICY_KEY_FILE);
  const now = inspectPolicyKey(dir, o);
  if (now?.ok) return { ok: false, reason: "sound" };
  try {
    const st = fs.lstatSync(file);
    if (st.isDirectory()) fs.rmSync(file, { recursive: true, force: true }); else fs.unlinkSync(file);
  } catch { /* already gone */ }
  const lost: string[] = [];
  for (const name of POLICY_FILES) { try { fs.unlinkSync(path.join(dir, name)); if (name !== POLICY_RESET_FILE) lost.push(name); } catch { /* not there */ } }
  const r = loadPolicyKey(dir, { uid: o.uid, log: () => {} });
  if (r.ok && lost.length) markReset(dir, r.key, lost); // bug 256: one prompt to turn the Bots' modes back on
  return r;
}
