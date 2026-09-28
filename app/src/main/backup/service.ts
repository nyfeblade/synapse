import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { HealthInfo } from "@synapse/shared";
import { writeFileAtomic } from "../atomic-file";
import { archiveRecords, decryptArchive, END_RECORD, encodeRecord, keyId, newBackupKey, parseRecoveryCode, readArchiveHeader, readRecords, recoveryCode, writeArchive, type ArchiveRecord } from "./archive";

/**
 * Settings → Backups. One encrypted archive (archive.ts) rebuilds the user's Synapse:
 *   host/…      the host's own consistent snapshot (GET /backup/snapshot, host/backup/host-backup.ts)
 *   sessions/…  the Bots' Claude Code session files, pulled from the box (needed to resume a chat)
 *   mac/…       this profile's JSON state (settings, box pin, local Bot modes, local-exec policy)
 *               and its sealed secret files, which stay sealed with this Mac's key file (never in the archive)
 * Restore: safety backup → stage on the host → restart the host (it applies the restore before any
 * store opens) → verify (/health reports the restore, the Bot count matches) → sessions → Mac files.
 */
export interface BackupSettings { auto: boolean; keep: number; dir: string }
export type BackupReason = "manual" | "auto" | "pre-restore";
export interface ArchiveInfo { file: string; name: string; createdAt: number; bytes: number; reason: BackupReason }
export interface BackupPreview { file: string; createdAt: number; bytes: number; appVersion: string; hostVersion: string; bots: { id: string; name: string }[]; sessions: boolean; macFiles: string[]; reason: BackupReason }
export interface RestoreOutcome { ok: true; bots: number; verified: boolean; macSecretsSkipped: boolean; hostSealed: "applied" | "skipped" | "none" }
export interface BackupStatus { settings: BackupSettings; lastAt: number | null; lastError: string | null; running: "backup" | "restore" | null; archives: ArchiveInfo[]; recoveryPending: boolean }

type Health = Pick<HealthInfo, "ok" | "bootId" | "hostVersion"> & { lastRestore?: HealthInfo["lastRestore"] };
export interface BackupDeps {
  userData: string;
  appVersion: string;
  now(): number;
  settings(): BackupSettings;
  /** The archive key, sealed with the profile's key file (sealing.ts). `set` may silently fail while secrets aren't open. */
  key: { get(): Buffer | null; set(k: Buffer): void };
  host: {
    snapshot(): Promise<AsyncIterable<Buffer | string>>;
    stage(file: string, sha256: string): Promise<void>;
    health(): Promise<Health | null>;
    botCount(): Promise<number>;
    /** Stop the host and start it again (it applies the staged restore on the way up). */
    restart(): Promise<void>;
    reconnect(): Promise<void>;
  };
  sessions?: { pull(): Promise<Buffer | null>; push(tgz: Buffer): Promise<void> };
  /** Whether a sealed file from a backup opens with THIS Mac's key file. */
  canUnseal(sealed: Buffer): boolean;
  /** Free bytes on the volume holding `dir` (null = unknown). The daily backup skips itself under 5 GB. */
  freeBytes?(dir: string): number | null;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
}

// box-pin.json: the key of THIS Mac's box. Restored onto a new Mac (or a recreated box) it would block secret sync forever.
const MAC_DENY = new Set(["code-identity.json", "keychain-namespace.json", "keychain-retired.json", "keychain-retire-attempts.json", "backup-state.json", "window-bounds.json", "box-pin.json"]);
const PHONE_FILE = "phone-access.json";
const SEALED_MAC = (rel: string) => rel === "secrets.hashkey.bin" || rel === "secrets.vault.json" || rel.startsWith("secrets/");
const NAME = /^Synapse-(\d{4}-\d{2}-\d{2}-\d{6})(-pre-restore)?\.synbak$/;
const DAY = 24 * 3600_000;
/** bug-log 128: the automatic backup never runs the Mac out of space; under this it skips with a warning. */
export const AUTO_BACKUP_MIN_FREE_BYTES = 5 * 1024 ** 3;
const gb = (b: number) => (Math.round((b / 1024 ** 3) * 10) / 10).toFixed(1);

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class BackupService {
  private running: "backup" | "restore" | null = null;
  /** The archive being restored: the safety backup's pruning must never delete it. */
  private protect: string | null = null;
  private tmpRoot: string;
  constructor(private d: BackupDeps) {
    this.tmpRoot = path.join(d.userData, "backup-tmp");
    fs.rmSync(this.tmpRoot, { recursive: true, force: true }); // a previous run may have died mid-way
  }

  private stateFile() { return path.join(this.d.userData, "backup-state.json"); }
  private state(): { lastAt: number | null; lastError: string | null; recoveryPending: boolean } {
    try { return { lastAt: null, lastError: null, recoveryPending: false, ...JSON.parse(fs.readFileSync(this.stateFile(), "utf8")) }; } catch { return { lastAt: null, lastError: null, recoveryPending: false }; }
  }
  private patch(p: Partial<ReturnType<BackupService["state"]>>): void {
    writeFileAtomic(this.stateFile(), JSON.stringify({ ...this.state(), ...p }), 0o600);
  }

  status(): BackupStatus {
    const s = this.state();
    return { settings: this.d.settings(), lastAt: s.lastAt, lastError: s.lastError, running: this.running, archives: this.list(), recoveryPending: s.recoveryPending };
  }

  list(): ArchiveInfo[] {
    const dir = this.d.settings().dir;
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.flatMap((name) => {
      const m = NAME.exec(name);
      if (!m) return [];
      const file = path.join(dir, name);
      try {
        const h = readArchiveHeader(file);
        return [{ file, name, createdAt: h.createdAt, bytes: h.size, reason: (m[2] ? "pre-restore" : "manual") as BackupReason }];
      } catch { return []; }
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The recovery code, only until the user says they saved it. */
  pendingRecoveryCode(): string | null {
    const key = this.d.key.get();
    return key && this.state().recoveryPending ? recoveryCode(key) : null;
  }
  ackRecoveryCode(): void { this.patch({ recoveryPending: false }); }

  private ensureKey(): Buffer {
    const have = this.d.key.get();
    if (have) return have;
    const k = newBackupKey();
    this.d.key.set(k);
    const back = this.d.key.get();
    if (!back || !back.equals(k)) throw new Error("Secrets aren't open yet, so no backup key could be kept. Try again in a moment.");
    this.patch({ recoveryPending: true });
    this.d.log(`backup key created id=${keyId(k)}`);
    return k;
  }

  /**
   * Re-review 1: phone-access.json carries one sealed value, the push (VAPID) private key. One sealed by another
   * Mac's key file can't be opened here, so it is dropped with its subscriptions (they belong to that key): the
   * phones stay paired and push pairs again with a key made here, instead of mixing keys.
   */
  private phoneForThisMac(data: Buffer): Buffer {
    let p: { vapid?: { sealed?: unknown } | null; subs?: unknown[] };
    try { p = JSON.parse(data.toString("utf8")) as typeof p; } catch { return data; }
    const sealed = p?.vapid?.sealed;
    if (typeof sealed !== "string" || this.d.canUnseal(Buffer.from(sealed, "base64"))) return data;
    this.d.log("restore: the push key was sealed on another Mac; dropped (push pairs again)");
    return Buffer.from(JSON.stringify({ ...p, vapid: null, subs: [] }, null, 2));
  }

  private tmp(): string {
    fs.mkdirSync(this.tmpRoot, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(this.tmpRoot, "op-"));
  }

  private macFiles(): { rel: string; abs: string }[] {
    const ud = this.d.userData;
    const out: { rel: string; abs: string }[] = [];
    for (const e of fs.readdirSync(ud, { withFileTypes: true })) {
      if (e.isFile() && (e.name.endsWith(".json") || e.name === "secrets.hashkey.bin") && !MAC_DENY.has(e.name)) out.push({ rel: e.name, abs: path.join(ud, e.name) });
    }
    const sec = path.join(ud, "secrets");
    for (const e of fs.existsSync(sec) ? fs.readdirSync(sec, { withFileTypes: true }) : []) {
      if (e.isFile() && e.name.endsWith(".bin") && e.name !== "backupKey.bin") out.push({ rel: `secrets/${e.name}`, abs: path.join(sec, e.name) });
    }
    return out;
  }

  async backupNow(reason: BackupReason): Promise<ArchiveInfo> {
    if (this.running) throw new Error(this.running === "restore" ? "A restore is running." : "A backup is already running.");
    this.running = "backup";
    try { return await this.doBackup(reason); } finally { this.running = null; }
  }

  private async doBackup(reason: BackupReason): Promise<ArchiveInfo> {
    const t0 = this.d.now();
    const key = this.ensureKey();
    const { dir } = this.d.settings();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const work = this.tmp();
    try {
      // The host snapshot is pulled to a private temp file first: the archive is written in one pass.
      const hostGz = path.join(work, "host.gz");
      await pipeline(Readable.from(await this.d.host.snapshot()), fs.createWriteStream(hostGz, { mode: 0o600 }));
      let hostManifest: { hostVersion?: string; bots?: { id: string; name: string }[] } = {};
      for await (const r of readRecords(fs.createReadStream(hostGz).pipe(createGunzip()))) {
        if (r.meta.p === "manifest.json") { hostManifest = JSON.parse(r.data.toString("utf8")); break; }
      }
      const sessions = await this.d.sessions?.pull().catch((e: Error) => { this.d.log(`backup sessions skipped: ${e.message}`); return null; }) ?? null;
      const mac = this.macFiles();
      const manifest = {
        kind: "synapse-backup", v: 1, createdAt: t0, reason, appVersion: this.d.appVersion, hostVersion: hostManifest.hostVersion ?? "unknown",
        bots: hostManifest.bots ?? [], sessions: !!sessions, macFiles: mac.map((m) => m.rel),
      };
      async function* records(): AsyncGenerator<ArchiveRecord> {
        yield { p: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) };
        for await (const r of readRecords(fs.createReadStream(hostGz).pipe(createGunzip()))) yield { p: `host/${r.meta.p}`, data: r.data, m: r.meta.m };
        if (sessions) yield { p: "sessions/projects.tgz", data: sessions };
        for (const m of mac) {
          try { yield { p: `mac/${m.rel}`, data: fs.readFileSync(m.abs), m: 0o600 }; } catch { /* vanished */ }
        }
      }
      const name = `Synapse-${stamp(t0)}${reason === "pre-restore" ? "-pre-restore" : ""}.synbak`;
      const file = path.join(dir, name);
      const { bytes } = await writeArchive(file, key, records(), { createdAt: t0, appVersion: this.d.appVersion });
      this.prune();
      this.patch({ lastAt: t0, lastError: null });
      this.d.log(`backup ok reason=${reason} file=${name} bytes=${bytes} bots=${manifest.bots.length} sessions=${manifest.sessions} ms=${this.d.now() - t0}`);
      return { file, name, createdAt: t0, bytes, reason };
    } catch (e) {
      this.patch({ lastError: (e as Error).message });
      this.d.log(`backup failed reason=${reason}: ${(e as Error).message}`);
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  private prune(): void {
    const keep = Math.max(1, Math.trunc(this.d.settings().keep || 7));
    for (const old of this.list().filter((a) => a.file !== this.protect).slice(keep)) {
      fs.rmSync(old.file, { force: true });
      this.d.log(`backup pruned file=${old.name}`);
    }
  }

  /** A `.part` from a backup that died mid-write (app killed, disk full) is never renamed or pruned: remove it. */
  private sweepParts(dir: string): void {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(".synbak.part") || !NAME.test(n.slice(0, -5))) continue;
      const f = path.join(dir, n);
      try {
        if (Date.now() - fs.statSync(f).mtimeMs < 3600_000) continue; // a backup may be writing it right now
        fs.rmSync(f, { force: true });
        this.d.log(`backup removed a stale partial file=${n}`);
      } catch { /* gone */ }
    }
  }

  private lowDiskWarned = false;

  /** The daily backup: runs when automatic backups are on and the last one is a day old. */
  async tick(): Promise<boolean> {
    if (!this.d.settings().auto || this.running) return false;
    const last = this.state().lastAt;
    if (last !== null && this.d.now() - last < DAY) return false;
    const { dir } = this.d.settings();
    this.sweepParts(dir);
    const free = this.d.freeBytes?.(dir) ?? null;
    if (free !== null && free < AUTO_BACKUP_MIN_FREE_BYTES) {
      const msg = `Skipped the daily backup: this Mac has only ${gb(free)} GB free (a backup needs at least ${gb(AUTO_BACKUP_MIN_FREE_BYTES).replace(".0", "")} GB). Free some space and it runs again.`;
      if (!this.lowDiskWarned) {
        this.lowDiskWarned = true;
        this.d.log(`backup skipped: low disk free=${free} min=${AUTO_BACKUP_MIN_FREE_BYTES}`);
        this.patch({ lastError: msg });
      }
      return false;
    }
    this.lowDiskWarned = false;
    try { await this.backupNow("auto"); return true; } catch { return false; }
  }

  private keyFor(file: string, code?: string): Buffer {
    const h = readArchiveHeader(file);
    const own = this.d.key.get();
    if (own && keyId(own) === h.keyId) return own;
    const k = code ? parseRecoveryCode(code) : null;
    if (!k || keyId(k) !== h.keyId) throw new Error(code ? "That recovery code doesn't open this backup." : "This backup was made on another Mac or with another key. Enter its recovery code.");
    return k;
  }

  private async open(file: string, code: string | undefined, work: string) {
    const plain = path.join(work, "plain.gz");
    await decryptArchive(file, this.keyFor(file, code), plain);
    let manifest: { createdAt: number; reason: BackupReason; appVersion: string; hostVersion: string; bots: { id: string; name: string }[]; sessions: boolean; macFiles: string[] } | null = null;
    for await (const r of archiveRecords(plain)) { if (r.meta.p === "manifest.json") manifest = JSON.parse(r.data.toString("utf8")); break; }
    if (!manifest) throw new Error("This backup has no manifest, so it can't be restored.");
    return { plain, manifest };
  }

  async preview(file: string, code?: string): Promise<BackupPreview> {
    const work = this.tmp();
    try {
      const { manifest } = await this.open(file, code, work);
      return { file, createdAt: manifest.createdAt, bytes: fs.statSync(file).size, appVersion: manifest.appVersion, hostVersion: manifest.hostVersion, bots: manifest.bots, sessions: manifest.sessions, macFiles: manifest.macFiles, reason: manifest.reason };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async restore(file: string, code?: string): Promise<RestoreOutcome> {
    if (this.running) throw new Error("A backup or restore is already running.");
    const work = this.tmp();
    this.protect = path.resolve(file);
    try {
      const { plain, manifest } = await this.open(file, code, work);
      // The safety net: what is there now, in an archive of its own, before anything is replaced.
      const safety = await this.backupNow("pre-restore");
      this.running = "restore";
      this.d.log(`restore start file=${path.basename(file)} bots=${manifest.bots.length} safety=${safety.name}`);
      const hostGz = path.join(work, "host.gz");
      const mac: { rel: string; data: Buffer }[] = [];
      let sessions: Buffer | null = null;
      async function* hostRecords() {
        for await (const r of archiveRecords(plain)) {
          if (r.meta.p.startsWith("host/")) yield encodeRecord(r.meta.p.slice(5), r.data, r.meta.m);
          else if (r.meta.p.startsWith("mac/")) mac.push({ rel: r.meta.p.slice(4), data: r.data });
          else if (r.meta.p === "sessions/projects.tgz") sessions = r.data;
        }
        yield END_RECORD;
      }
      await pipeline(Readable.from(hostRecords()), createGzip(), fs.createWriteStream(hostGz, { mode: 0o600 }));
      const sha = createHash("sha256").update(fs.readFileSync(hostGz)).digest("hex");
      const before = await this.d.host.health();
      const t0 = this.d.now();
      await this.d.host.stage(hostGz, sha);
      await this.d.host.restart();
      const h = await this.waitRestored(before?.bootId ?? null, t0);
      if (!h.lastRestore?.ok) throw new Error(h.lastRestore?.message ?? "The host didn't apply the restore.");
      if (sessions) await this.d.sessions?.push(sessions).catch((e: Error) => this.d.log(`restore sessions failed: ${e.message}`));
      const sealedHere = mac.find((m) => m.rel === "secrets.hashkey.bin");
      const sameMac = !sealedHere || this.d.canUnseal(sealedHere.data);
      for (const m of mac) {
        if (m.rel.includes("..") || m.rel.startsWith("/") || MAC_DENY.has(m.rel)) continue;
        if (!sameMac && SEALED_MAC(m.rel)) continue;
        const dest = path.join(this.d.userData, m.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        writeFileAtomic(dest, m.rel === PHONE_FILE ? this.phoneForThisMac(m.data) : m.data, 0o600);
      }
      await this.d.host.reconnect();
      const count = await this.d.host.botCount().catch(() => -1);
      const verified = count === manifest.bots.length;
      this.patch({ lastError: null });
      this.d.log(`restore ok bots=${count}/${manifest.bots.length} verified=${verified} macSecrets=${sameMac ? "restored" : "skipped"} hostSealed=${h.lastRestore.sealed ?? "none"}`);
      return { ok: true, bots: count, verified, macSecretsSkipped: !sameMac, hostSealed: h.lastRestore.sealed ?? "none" };
    } catch (e) {
      this.patch({ lastError: (e as Error).message });
      this.d.log(`restore failed: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = null;
      this.protect = null;
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** A new host process (new bootId) that has reported a restore at or after `t0`. Two minutes at most. */
  private async waitRestored(oldBoot: string | null, t0: number): Promise<Health & { lastRestore: NonNullable<Health["lastRestore"]> }> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < 120; i++) {
      const h = await this.d.host.health().catch(() => null);
      // A minute of slack: the box's clock and the Mac's can differ a little; the new bootId is the real proof.
      if (h?.ok && h.bootId !== oldBoot && h.lastRestore && h.lastRestore.at >= t0 - 60_000) return h as Health & { lastRestore: NonNullable<Health["lastRestore"]> };
      await sleep(1000);
    }
    throw new Error("The host didn't come back after the restore. Your previous state is in the pre-restore backup.");
  }
}
