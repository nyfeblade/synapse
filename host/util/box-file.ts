import fs from "node:fs";
import path from "node:path";

/**
 * Final secfix round 3 (ruling 4): the host reading (or removing) something the Bot wrote in a box-writable folder,
 * e.g. /workspace/teach-sessions/<id>/rehearsal.json. Box owns those folders, so ownership proves nothing; what
 * matters is that the host never follows a link box planted (to a host-private file, say). Every directory from
 * `root` down must be a real directory (never a link), the file is opened O_NOFOLLOW, and after the open the fd is
 * checked against the expected path (/proc/self/fd on Linux; the re-walked chain's dev/ino and the file's lstat
 * everywhere) before a byte is read.
 */
type Chain = { path: string; dev: number; ino: number }[];

function realChain(root: string, dir: string): Chain | null {
  const base = path.resolve(root);
  const target = path.resolve(dir);
  if (target !== base && !target.startsWith(`${base}/`)) return null;
  const out: Chain = [];
  let at = base;
  for (const seg of ["", ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
    at = seg ? path.join(at, seg) : at;
    try {
      const st = fs.lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      out.push({ path: at, dev: st.dev, ino: st.ino });
    } catch {
      return null;
    }
  }
  return out;
}

const intact = (c: Chain): boolean => c.every((x) => { try { const st = fs.lstatSync(x.path); return !st.isSymbolicLink() && st.dev === x.dev && st.ino === x.ino; } catch { return false; } });

/** The file's text, or null when it's missing, too big, not a regular file, or reached through a link. */
export function readBoxFile(root: string, file: string, maxBytes = 4 * 1024 * 1024): string | null {
  const abs = path.resolve(file);
  const chain = realChain(root, path.dirname(abs));
  if (!chain) return null;
  let fd: number;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    let reported: string | null = null;
    try { reported = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* not Linux */ }
    if (reported !== null && reported !== path.join(fs.realpathSync(path.resolve(root)), path.relative(path.resolve(root), abs))) return null;
    if (!intact(chain)) return null;
    const l = fs.lstatSync(abs);
    if (l.dev !== st.dev || l.ino !== st.ino) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Removes `p` (file or tree) only when every directory from `root` down to it is real and `p` isn't a link. */
export function removeBoxPath(root: string, p: string): boolean {
  const abs = path.resolve(p);
  const chain = realChain(root, path.dirname(abs));
  if (!chain) return false;
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!intact(chain)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}
