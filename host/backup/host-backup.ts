import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { backup, DatabaseSync } from "node:sqlite";
import type { HostConfig } from "../config";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { END_RECORD, encodeRecord, readRecords } from "./records";

/**
 * Settings → Backups, host half. One consistent snapshot of the host's own state, streamed to the Mac
 * (which encrypts it into the user's archive), and the staged restore the host applies at start-up.
 *
 * What is in it:
 *   data/…    the whole data root: Bot folders (profile, settings, store.db), memories, chat
 *             transcripts, templates, host settings
 *   private/… host history and ledgers from the host-private folder: history-archive, scheduler,
 *             usage, runtime-metrics, memory and search indexes, chains, B2B threads, …
 *   sealed/…  stores that are already sealed with this box's vault key (MCP headers, Google, the
 *             secret vault, connector secrets), copied as ciphertext and restored only onto a box
 *             holding the same vault key
 * What never is: the vault key itself, the Claude OAuth token, the gateway token, the box keypair,
 * the host lock, CMP-12 snapshots, caches. Ruling (a) of the snapshot work stands: host keys never
 * leave the box, so a sealed store in a backup stays exactly as encrypted as it is on disk.
 *
 * Live SQLite databases go through the online backup API, so rows still in the WAL are included and
 * the copy is a consistent image, never a torn file copy.
 */
export interface HostBackupManifest {
  kind: "synapse-host-backup"; v: 1; createdAt: number; hostVersion: string;
  bots: { id: string; name: string }[]; vaultKeyId: string | null; files: number; bytes: number;
}
export interface RestoreResult { at: number; ok: boolean; message?: string; bots?: number; sealed?: "applied" | "skipped" | "none" }

const DENY_PRIVATE = new Set(["gateway.json", "box-keypair.json", "host.lock", "vault.key", "catalog-index.db", "brain-conformance.json", "restore-pending.json", "restore-result.json", "host-run.json"]);
/** Review round 2 (S5): an old Claude login token (and any temp file of it) is never carried by a backup. */
const DENY_PREFIX = ["claude-oauth-token"];
/** A file directly in hostPrivate that a backup never carries. */
export function deniedPrivate(name: string): boolean {
  return DENY_PRIVATE.has(name) || DENY_PREFIX.some((p) => name === p || name.startsWith(`${p}.`));
}
const PRIVATE_DIRS = new Set(["b2b-threads"]);
const SEALED_DIRS = ["mcp", "google", "connector-secrets", "secrets", "anthropic-auth"];
const SIDE_FILE = /-(wal|shm|journal)$/;
const WORK = /^\.(restore-|backup-work)/;
const STAGED = "restore-staged.sbk.gz";
const MARKER = "restore-pending.json";
const RESULT = "restore-result.json";
export const RESTORE_TTL_MS = 10 * 60_000;
const MAX_UPLOAD = 8 * 1024 ** 3;

function isSqlite(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(16);
    return fs.readSync(fd, b, 0, 16, 0) === 16 && b.toString("latin1") === "SQLite format 3\u0000";
  } catch { return false; } finally { if (fd !== null) fs.closeSync(fd); }
}

function* walk(root: string, rel = ""): Generator<{ abs: string; rel: string; mode: number }> {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (WORK.test(e.name) || SIDE_FILE.test(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(root, r);
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield { abs, rel: r, mode: fs.statSync(abs).mode & 0o777 };
  }
}

/** The vault key's fingerprint (domain-separated, truncated): says "same box key", reveals nothing. */
export function vaultKeyId(cfg: HostConfig): string | null {
  try { return createHash("sha256").update("synapse-backup/vault-id/v1").update(fs.readFileSync(path.join(cfg.hostPrivate, "vault.key"))).digest("hex").slice(0, 16); } catch { return null; }
}

function sources(cfg: HostConfig): { p: string; abs: string; mode: number }[] {
  const out: { p: string; abs: string; mode: number }[] = [];
  for (const f of walk(cfg.dataRoot)) out.push({ p: `data/${f.rel}`, abs: f.abs, mode: f.mode });
  for (const e of fs.existsSync(cfg.hostPrivate) ? fs.readdirSync(cfg.hostPrivate, { withFileTypes: true }) : []) {
    if (deniedPrivate(e.name) || WORK.test(e.name) || SIDE_FILE.test(e.name)) continue;
    const abs = path.join(cfg.hostPrivate, e.name);
    if (e.isFile() && /\.(json|jsonl|db)$/.test(e.name)) out.push({ p: `private/${e.name}`, abs, mode: fs.statSync(abs).mode & 0o777 });
    else if (e.isDirectory() && PRIVATE_DIRS.has(e.name)) for (const f of walk(abs)) out.push({ p: `private/${e.name}/${f.rel}`, abs: f.abs, mode: f.mode });
    else if (e.isDirectory() && SEALED_DIRS.includes(e.name)) for (const f of walk(abs)) out.push({ p: `sealed/${e.name}/${f.rel}`, abs: f.abs, mode: f.mode });
  }
  return out;
}

/**
 * Copies everything into a private work folder first (databases through sqlite's online backup,
 * the rest as plain copies; every JSON store is written tmp+rename, so each copy is whole), then
 * streams that frozen copy as gzip. The work folder is removed when the stream finishes or fails.
 */
export async function snapshotHostState(cfg: HostConfig, o: { bots(): { id: string; name: string }[]; hostVersion: string; now(): number }): Promise<Readable> {
  fs.mkdirSync(cfg.hostPrivate, { recursive: true, mode: 0o700 });
  // A download the Mac abandoned never ran the generator's finally; one snapshot runs at a time (routes.ts).
  for (const f of fs.readdirSync(cfg.hostPrivate)) if (f.startsWith(".backup-work-")) fs.rmSync(path.join(cfg.hostPrivate, f), { recursive: true, force: true });
  const work = fs.mkdtempSync(path.join(cfg.hostPrivate, ".backup-work-"));
  const staged: { p: string; file: string; mode: number }[] = [];
  try {
    const all = sources(cfg);
    // Databases first: they are the ones still changing while we copy.
    all.sort((a, b) => Number(isSqlite(b.abs)) - Number(isSqlite(a.abs)));
    let i = 0;
    for (const s of all) {
      const dest = path.join(work, String(i++));
      try {
        if (isSqlite(s.abs)) {
          const db = new DatabaseSync(s.abs);
          try { await backup(db, dest); } finally { db.close(); }
        } else fs.copyFileSync(s.abs, dest);
        staged.push({ p: s.p, file: dest, mode: s.mode });
      } catch (e) {
        // A file that vanished between the listing and the copy (a deleted Bot, a rotated log) is
        // simply not in this backup; anything else fails the whole snapshot.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
  const manifest: HostBackupManifest = {
    kind: "synapse-host-backup", v: 1, createdAt: o.now(), hostVersion: o.hostVersion, bots: o.bots(), vaultKeyId: vaultKeyId(cfg),
    files: staged.length, bytes: staged.reduce((n, s) => n + fs.statSync(s.file).size, 0),
  };
  async function* records(): AsyncGenerator<Buffer> {
    try {
      yield encodeRecord("manifest.json", Buffer.from(JSON.stringify(manifest)));
      for (const s of staged) yield encodeRecord(s.p, fs.readFileSync(s.file), s.mode);
      yield END_RECORD;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  const gz = createGzip();
  const src = Readable.from(records());
  src.on("error", (e) => gz.destroy(e));
  return src.pipe(gz);
}

/** PUT /backup/restore: stores the upload and marks it pending. Nothing is applied until the host restarts. */
export async function stageRestore(cfg: HostConfig, body: AsyncIterable<Buffer | string>, sha256: string, now: () => number): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("backup: a restore needs its sha256 checksum");
  fs.mkdirSync(cfg.hostPrivate, { recursive: true, mode: 0o700 });
  const file = path.join(cfg.hostPrivate, STAGED);
  const part = `${file}.part`;
  const hash = createHash("sha256");
  const fd = fs.openSync(part, "w", 0o600);
  let n = 0;
  try {
    for await (const c of body) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      n += b.length;
      if (n > MAX_UPLOAD) throw new Error("backup: the restore upload is too large");
      hash.update(b);
      fs.writeSync(fd, b);
    }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  if (hash.digest("hex") !== sha256) { fs.rmSync(part, { force: true }); throw new Error("backup: the restore upload didn't match its checksum"); }
  fs.renameSync(part, file);
  writeJsonAtomic(path.join(cfg.hostPrivate, MARKER), { sha256, stagedAt: now() }, 0o600);
}

export function readLastRestore(cfg: HostConfig): RestoreResult | null {
  return readJson<RestoreResult | null>(path.join(cfg.hostPrivate, RESULT), null);
}

function move(a: string, b: string, done: [string, string][]): void {
  fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
  fs.renameSync(a, b);
  done.push([a, b]);
}

async function unpack(file: string, dataWork: string, privWork: string): Promise<HostBackupManifest> {
  let manifest: HostBackupManifest | null = null;
  for await (const r of readRecords(fs.createReadStream(file).pipe(createGunzip()))) {
    if (r.meta.p === "manifest.json") { manifest = JSON.parse(r.data.toString("utf8")) as HostBackupManifest; continue; }
    const [top, ...rest] = r.meta.p.split("/");
    if (!rest.length) continue;
    const root = top === "data" ? dataWork : top === "private" || top === "sealed" ? path.join(privWork, top) : null;
    if (!root) continue;
    const dest = path.join(root, ...rest);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: top === "data" ? 0o750 : 0o700 });
    fs.writeFileSync(dest, r.data, { mode: r.meta.m ?? 0o600 });
    if (r.meta.m !== undefined) fs.chmodSync(dest, r.meta.m);
  }
  if (!manifest || manifest.kind !== "synapse-host-backup" || manifest.v !== 1) throw new Error("backup: this isn't a Synapse host backup");
  return manifest;
}

/**
 * Runs in main.ts before the host opens a single store. Everything the restore replaces is moved
 * aside first and moved back if any step fails, so a damaged archive can't leave half a host.
 * The host's keys and tokens are never touched.
 */
export async function applyPendingRestore(cfg: HostConfig, now: () => number = Date.now): Promise<RestoreResult | null> {
  const hp = cfg.hostPrivate;
  const marker = readJson<{ sha256: string; stagedAt: number } | null>(path.join(hp, MARKER), null);
  const staged = path.join(hp, STAGED);
  if (!marker) { fs.rmSync(staged, { force: true }); return null; }
  const dataWork = path.join(cfg.dataRoot, ".restore-work");
  const dataOld = path.join(cfg.dataRoot, ".restore-old");
  const privWork = path.join(hp, ".restore-work");
  const privOld = path.join(hp, ".restore-old");
  const clean = () => { for (const d of [dataWork, dataOld, privWork, privOld]) fs.rmSync(d, { recursive: true, force: true }); };
  let result: RestoreResult;
  const done: [string, string][] = [];
  try {
    if (now() - marker.stagedAt > RESTORE_TTL_MS) throw new Error("The staged restore expired before the host restarted, so it wasn't applied.");
    if (createHash("sha256").update(fs.readFileSync(staged)).digest("hex") !== marker.sha256) throw new Error("The staged restore is damaged.");
    clean();
    fs.mkdirSync(dataWork, { recursive: true, mode: 0o750 });
    fs.mkdirSync(privWork, { recursive: true, mode: 0o700 });
    const manifest = await unpack(staged, dataWork, privWork);
    for (const c of fs.readdirSync(cfg.dataRoot)) if (!WORK.test(c)) move(path.join(cfg.dataRoot, c), path.join(dataOld, c), done);
    for (const c of fs.readdirSync(dataWork)) move(path.join(dataWork, c), path.join(cfg.dataRoot, c), done);
    const install = (kind: "private" | "sealed") => {
      const dir = path.join(privWork, kind);
      if (!fs.existsSync(dir)) return false;
      for (const name of fs.readdirSync(dir)) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const live = path.join(hp, name + suffix);
          if (fs.existsSync(live)) move(live, path.join(privOld, kind, name + suffix), done);
        }
        move(path.join(dir, name), path.join(hp, name), done);
      }
      return true;
    };
    install("private");
    const hasSealed = fs.existsSync(path.join(privWork, "sealed"));
    const sameKey = !!manifest.vaultKeyId && manifest.vaultKeyId === vaultKeyId(cfg);
    const sealed = !hasSealed ? "none" : sameKey && install("sealed") ? "applied" : "skipped";
    result = { at: now(), ok: true, bots: manifest.bots.length, sealed };
    log.info("backup restore applied", { bots: manifest.bots.length, files: manifest.files, sealed });
  } catch (e) {
    for (const [a, b] of done.reverse()) { try { fs.renameSync(b, a); } catch { /* best effort: keep going */ } }
    result = { at: now(), ok: false, message: (e as Error).message };
    log.error("backup restore failed; the previous state was kept", { error: (e as Error).message });
  }
  clean();
  fs.rmSync(staged, { force: true });
  fs.rmSync(path.join(hp, MARKER), { force: true });
  writeJsonAtomic(path.join(hp, RESULT), result, 0o600);
  return result;
}
