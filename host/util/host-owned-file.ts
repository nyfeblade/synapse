import fs from "node:fs";
import path from "node:path";
import { syncIfDurable } from "./atomic-json";

/**
 * Host-owned output under a box-writable root (final secfix round 3, ruling 4).
 *
 * The host's Bot-visible output (upload staging, oversized webhook bodies, screenshots, published Teach recordings)
 * lives under `<workspace>/.host-out/…`, where every directory from `.host-out` down is owned by bothost (bots
 * group, 2750) and every file is 0640: box reads through the group but can't write, rename or delete there. The
 * workspace root itself stays box-writable (2775), so box CAN rename `.host-out` away and plant its own tree (with
 * symlinks) in its place. So:
 *
 *  1. `root` (the workspace) must be a real directory; EVERY component below it, down to the target directory, must
 *     be a real directory (never a symlink) owned by this process's uid. Missing ones are created one level at a
 *     time (0750; the setgid parent hands down the bots group on Linux); a group/other-writable one is healed.
 *  2. The file is created O_EXCL|O_NOFOLLOW, then — before a byte is written — verified: fstat must be a regular
 *     file we own with one link, `/proc/self/fd/<fd>` (Linux) must name exactly the expected path, and the re-walked
 *     chain must still be the same directories (dev/ino) with the expected path's lstat equal to the fstat. If any
 *     check fails the file is truncated and unlinked, and the write is refused (null).
 */
export interface HostOwnedChain { base: string; target: string; ids: { path: string; dev: number; ino: number }[] }

const myUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** Every directory from `root` (exclusive) down to `dir`: real, host-owned, not group/other-writable. */
export function ensureHostOwnedDir(root: string, dir: string, o: { create?: boolean } = {}): HostOwnedChain | null {
  try {
    const base = path.resolve(root);
    const target = path.resolve(dir);
    if (!target.startsWith(`${base}/`)) return null;
    fs.mkdirSync(base, { recursive: true });
    const b = fs.lstatSync(base);
    if (b.isSymbolicLink() || !b.isDirectory()) return null;
    const uid = myUid();
    const ids: HostOwnedChain["ids"] = [];
    let at = base;
    for (const seg of path.relative(base, target).split(path.sep).filter(Boolean)) {
      at = path.join(at, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(at);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || o.create === false) return null;
        fs.mkdirSync(at, { mode: 0o750 }); // one level at a time: never created through a link
        st = fs.lstatSync(at);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      if (uid !== null && st.uid !== uid) return null;
      if (st.mode & 0o022) fs.chmodSync(at, st.mode & 0o7755 & ~0o022); // only the host writes here
      ids.push({ path: at, dev: st.dev, ino: st.ino });
    }
    return { base, target, ids };
  } catch {
    return null;
  }
}

/** True while every directory of `chain` is still the same real, host-owned directory. */
export function chainIntact(chain: HostOwnedChain): boolean {
  try {
    const uid = myUid();
    return chain.ids.every((c) => {
      const st = fs.lstatSync(c.path);
      return !st.isSymbolicLink() && st.isDirectory() && st.dev === c.dev && st.ino === c.ino && (uid === null || st.uid === uid);
    });
  } catch {
    return false;
  }
}

/** Linux: the path the kernel reports for an open fd (null elsewhere). */
function fdPath(fd: number): string | null {
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; }
}

const SAFE_NAME = (n: string) => n.length > 0 && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\0");

/** Creates `<dir>/<name>` (never overwriting) with `content`; null when refused. Default mode 0600 (host-only). */
export function writeHostOwnedFile(root: string, dir: string, name: string, content: string | Buffer, mode = 0o600): string | null {
  if (!SAFE_NAME(name)) return null;
  const chain = ensureHostOwnedDir(root, dir);
  if (!chain) return null;
  const file = path.join(chain.target, name);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  } catch {
    return null;
  }
  let ok = false;
  try {
    if (!verifyCreated(fd, file, chain)) return null;
    fs.fchmodSync(fd, mode);
    if (typeof content === "string") fs.writeSync(fd, content);
    else fs.writeSync(fd, content);
    syncIfDurable(fd);
    ok = true;
    return file;
  } catch {
    return null;
  } finally {
    if (!ok) discard(fd, file);
    fs.closeSync(fd);
  }
}

function verifyCreated(fd: number, file: string, chain: HostOwnedChain): boolean {
  const st = fs.fstatSync(fd);
  const uid = myUid();
  if (!st.isFile() || st.nlink !== 1 || (uid !== null && st.uid !== uid)) return false;
  const reported = fdPath(fd);
  if (reported !== null) {
    let expected: string;
    try { expected = path.join(fs.realpathSync(chain.base), path.relative(chain.base, file)); } catch { return false; }
    if (reported !== expected) return false;
  }
  if (!chainIntact(chain)) return false;
  try {
    const l = fs.lstatSync(file);
    return l.dev === st.dev && l.ino === st.ino;
  } catch {
    return false;
  }
}

/** Empties the file we created and unlinks it wherever it actually landed (never someone else's file). */
function discard(fd: number, file: string): void {
  let st: fs.Stats | null = null;
  try { st = fs.fstatSync(fd); fs.ftruncateSync(fd, 0); } catch { /* nothing more to do */ }
  if (!st) return;
  for (const p of [fdPath(fd), file]) {
    if (!p) continue;
    try {
      const l = fs.lstatSync(p);
      if (l.dev === st.dev && l.ino === st.ino) { fs.unlinkSync(p); return; }
    } catch { /* try the next spelling */ }
  }
}

/**
 * Removes `p` (a file or a whole tree) under a host-owned chain: refused unless every directory from `root` down to
 * p's parent is a real, host-owned directory, and p itself isn't a symlink. rmSync never follows links inside the tree.
 */
export function removeHostOwnedPath(root: string, p: string): boolean {
  const abs = path.resolve(p);
  const chain = ensureHostOwnedDir(root, path.dirname(abs), { create: false });
  if (!chain) return false;
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!chainIntact(chain)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}

/**
 * Like writeHostOwnedFile, but replaces `<dir>/<name>` atomically: the content goes to a fresh host-owned temp file
 * in the same verified directory, which is then renamed over the name (readers never see a partial file). Null if
 * refused, or if the chain changed while publishing.
 */
export function writeHostOwnedFileAtomic(root: string, dir: string, name: string, content: string | Buffer, mode = 0o600): string | null {
  if (!SAFE_NAME(name)) return null;
  const tmp = writeHostOwnedFile(root, dir, `.${name}.${process.pid}.${Date.now()}.tmp`, content, mode);
  if (!tmp) return null;
  const chain = ensureHostOwnedDir(root, dir, { create: false });
  const file = path.join(path.dirname(tmp), name);
  try {
    if (!chain) throw new Error("chain");
    fs.renameSync(tmp, file);
    if (!chainIntact(chain)) return null;
    return file;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return null;
  }
}
