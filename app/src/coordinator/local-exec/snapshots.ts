import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { macFold, macLexical, macRootAcceptable, realOfDeepest } from "@synapse/shared";

const run = promisify(execFile);

/**
 * An APFS clone of `src` at `dst` (clonefile(2), through `/bin/cp -c`: Node's COPYFILE_FICLONE is ENOSYS on macOS).
 * No data is copied; the cost is one small process, flat in the file's size. Where the disk can't clone (not APFS,
 * another volume), a plain copy.
 */
async function cloneFile(src: string, dst: string): Promise<void> {
  if (process.platform === "darwin") {
    try { await run("/bin/cp", ["-c", "--", src, dst], { timeout: 10_000 }); return; } catch { try { fs.rmSync(dst, { force: true }); } catch { /* nothing there */ } }
  }
  await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
}

/**
 * 5.6: the prior version of a file a Bot is about to change, kept so the change can be undone. A snapshot is an APFS
 * clone: no data is copied until the original is overwritten, and then only the blocks the old version still holds.
 * On a disk that can't clone it is a plain copy, which is why the caps are by logical size.
 */
export const SNAP_LIMITS = { maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 2 * 1024 ** 3, retentionMs: 7 * 24 * 3_600_000, hashMaxBytes: 16 * 1024 ** 2, pruneEveryMs: 60_000 };

/** A file as an action left it: enough to tell whether anything touched it since. */
export interface FileState { size: number; ino: string; mtimeNs: string; ctimeNs: string; hash?: string }

/** One file's undo record: its snapshot before (null = it did not exist) and its state after (null = gone). */
export interface FileUndo { path: string; before: { snap: string | null; mode?: number; dirs?: string[] }; after: FileState | null }

export type TakeResult = { ok: true; before: FileUndo["before"] } | { ok: false; why: "outside" | "too-big" | "kind" | "error" };

export class SnapshotStore {
  readonly dir: string;
  private total: number | null = null;
  private lastPrune = 0;
  private limits: typeof SNAP_LIMITS;

  constructor(dir: string, private o: { now?: () => number; limits?: Partial<typeof SNAP_LIMITS> } = {}) {
    this.dir = dir;
    this.limits = { ...SNAP_LIMITS, ...(o.limits ?? {}) };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** The retention window, so the log can call an older entry expired. */
  get retentionMs(): number { return this.limits.retentionMs; }

  has(id: string): boolean { return /^[0-9]+-[0-9a-f]{16}$/.test(id) && fs.existsSync(path.join(this.dir, id)); }

  /** Clone `abs` as it is now. A missing file is a valid "before" (the action creates it). */
  async take(abs: string): Promise<TakeResult> {
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, why: "error" };
      // The file doesn't exist yet: note the folders the write will have to create, deepest first, so an undo can
      // remove them again (only those, and only while empty).
      const dirs: string[] = [];
      for (let d = path.dirname(abs); d !== path.dirname(d) && !fs.existsSync(d); d = path.dirname(d)) dirs.push(d);
      return { ok: true, before: { snap: null, ...(dirs.length ? { dirs } : {}) } };
    }
    if (!st.isFile()) return { ok: false, why: "kind" };
    if (st.size > this.limits.maxFileBytes) return { ok: false, why: "too-big" };
    const id = `${this.now()}-${randomBytes(8).toString("hex")}`;
    const dst = path.join(this.dir, id);
    try {
      await cloneFile(abs, dst);
      fs.chmodSync(dst, 0o600);
    } catch {
      try { fs.rmSync(dst, { force: true }); } catch { /* nothing there */ }
      return { ok: false, why: "error" };
    }
    if (this.total !== null) this.total += st.size;
    this.maybePrune();
    return { ok: true, before: { snap: id, mode: st.mode & 0o7777 } };
  }

  /** Drop snapshots nobody will use: taken for an action that failed or was refused. */
  drop(ids: (string | null)[]): void {
    for (const id of ids) if (id && this.has(id)) try { fs.rmSync(path.join(this.dir, id), { force: true }); this.total = null; } catch { /* gone */ }
  }

  static stateOf(abs: string, hashMaxBytes = SNAP_LIMITS.hashMaxBytes): FileState | null {
    let st: fs.BigIntStats;
    try { st = fs.lstatSync(abs, { bigint: true }); } catch { return null; }
    const s: FileState = { size: Number(st.size), ino: String(st.ino), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) };
    if (st.isFile() && st.size <= BigInt(hashMaxBytes)) try { s.hash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex"); } catch { /* unreadable: stat only */ }
    if (!st.isFile()) s.hash = "not-a-file";
    return s;
  }

  /** The file is exactly as the action left it: the same bytes (hashed), or the same inode, times and size. */
  static unchanged(abs: string, after: FileState | null): boolean {
    const now = SnapshotStore.stateOf(abs);
    if (!after || !now) return after === now;
    if (after.hash && now.hash) return after.hash === now.hash;
    return now.size === after.size && now.ino === after.ino && now.mtimeNs === after.mtimeNs && now.ctimeNs === after.ctimeNs;
  }

  /** Put `before` back at `abs`: a clone of the snapshot renamed over it, or (it didn't exist) the file removed. */
  async restore(abs: string, before: FileUndo["before"]): Promise<void> {
    if (before.snap === null) {
      fs.rmSync(abs, { force: true });
      // The folders this action created, deepest first; the first one that isn't empty (or is gone) ends it.
      for (const d of before.dirs ?? []) {
        try { if (!fs.lstatSync(d).isDirectory()) break; fs.rmdirSync(d); } catch { break; }
      }
      return;
    }
    const src = path.join(this.dir, before.snap);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.synapse-undo-${randomBytes(4).toString("hex")}`);
    try {
      await cloneFile(src, tmp);
      if (before.mode !== undefined) fs.chmodSync(tmp, before.mode);
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing there */ }
      throw e;
    }
  }

  /** Expired snapshots go, then the oldest until the total is under the cap. At most once a minute. */
  prune(force = false): void {
    if (!force && this.now() - this.lastPrune < this.limits.pruneEveryMs && (this.total === null || this.total <= this.limits.maxTotalBytes)) return;
    this.lastPrune = this.now();
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const rows: { id: string; at: number; size: number }[] = [];
    for (const id of names) {
      const at = Number(id.split("-")[0]);
      if (!Number.isFinite(at)) continue;
      try { rows.push({ id, at, size: fs.statSync(path.join(this.dir, id)).size }); } catch { /* gone */ }
    }
    rows.sort((a, b) => a.at - b.at);
    let total = rows.reduce((n, r) => n + r.size, 0);
    for (const r of rows) {
      const old = this.now() - r.at > this.limits.retentionMs;
      if (!old && total <= this.limits.maxTotalBytes) continue;
      try { fs.rmSync(path.join(this.dir, r.id), { force: true }); total -= r.size; } catch { /* keep counting it */ }
    }
    this.total = total;
  }

  private maybePrune(): void {
    if (this.total === null || this.total > this.limits.maxTotalBytes || this.now() - this.lastPrune >= this.limits.pruneEveryMs) this.prune(true);
  }
}

/** Folders under which nothing is snapshotted: caches, the Trash, VCS internals, installed packages. */
const EXCLUDED_SEGMENTS = new Set([".trash", ".cache", "caches", "node_modules", ".git", ".hg", ".svn", "__pycache__"]);

/**
 * Where an undo is kept (5.6 follow-up: it works out of the box): any regular file under the owner's home, plus the
 * owner's project folders (Settings → Computer, the auto-run roots, which may be on another volume). Never ~/Library,
 * caches, the Trash, VCS internals, node_modules or the app's own data. Checked on the on-disk path.
 */
export type UndoScope = "ok" | "outside" | "excluded";
export function undoScope(abs: string, c: { home: string; roots?: readonly string[]; userData?: string | null }): UndoScope {
  const real = (p: string): string | null => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const deepest = realOfDeepest(abs, (p) => fs.realpathSync.native(p));
  const f = macFold(macLexical(deepest ?? abs, "/"));
  const within = (dir: string) => dir !== "/" && f.startsWith(`${dir}/`);
  if (c.userData) {
    const u = macFold(macLexical(real(c.userData) ?? c.userData, "/"));
    if (f === u || within(u)) return "excluded";
  }
  const home = macFold(macLexical(real(c.home) ?? c.home, "/"));
  const roots = (c.roots ?? []).filter((r) => typeof r === "string" && macRootAcceptable(r, c) && real(r) === r).map((r) => macFold(macLexical(r, "/")));
  const base = within(home) ? home : roots.find((r) => within(r));
  if (!base) return "outside";
  const segs = f.slice(base.length + 1).split("/");
  if (base === home && segs[0] === "library") return "excluded";
  if (segs.slice(0, -1).some((x) => EXCLUDED_SEGMENTS.has(x))) return "excluded";
  return "ok";
}
