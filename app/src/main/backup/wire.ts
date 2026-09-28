import { spawn } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { HealthInfo } from "@synapse/shared";
import { readAppSettings, writeAppSettings } from "../app-settings";
import type { AppRuntime } from "../box-lifecycle";
import { sealer } from "../sealing";
import { resolveOrb } from "../orb-path";
import { createRotatingLog } from "../rotating-log";
import { readSecret, storeSecret } from "../secrets";
import { BackupService, type BackupSettings } from "./service";
import { APP_DATA_NAME } from "../data-rename";

/** ~/Library/Logs/Synapse: every log the app writes (main, voice, update, backup, crash). Bug 285: the log folder from before the rename is moved here (data-rename.ts). */
export const logsDir = () => path.join(os.homedir(), "Library", "Logs", APP_DATA_NAME);
export const defaultBackupDir = () => path.join(os.homedir(), "Library", "Application Support", APP_DATA_NAME, "backups");

export interface GatewayRef { baseUrl: string; token: string }

/** Runs a command, collecting stdout as bytes (execFile's string stdout would corrupt a tarball). */
function runBytes(cmd: string, args: string[], stdin?: Buffer, timeoutMs = 10 * 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: scrubClaudeLogin(process.env), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c: Buffer) => { err = (err + c.toString()).slice(-400); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim()}`)); });
    p.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

export function registerBackups(o: {
  userData: string; appDir: string; runtime: AppRuntime; appVersion: string; fuzz: boolean;
  gateway(): GatewayRef | null; reconnect(): Promise<void>; call(cmd: "listAgents"): Promise<{ agents: unknown[] }>;
  reg(name: string, fn: (a: any) => unknown): void; emit(ch: string, p: unknown): void;
  dialog: { openFolder(): Promise<string | null>; openArchive(): Promise<string | null>; saveText(name: string, text: string): Promise<boolean> };
  reveal(file: string): void;
  /** Portable install: the profile's OrbStack machine. */
  machine?: () => string;
}): BackupService {
  const log = createRotatingLog({ dir: logsDir(), name: "backup.log", maxBytes: 512 * 1024, keep: 2 });
  const settings = (): BackupSettings => {
    const s = readAppSettings(o.userData, o.appDir, o.runtime);
    // FUZZ / e2e profiles never write into the user's real backups folder or back up on a timer.
    return { auto: o.fuzz ? s.backupAuto === true : s.backupAuto !== false, keep: s.backupKeep ?? 7, dir: s.backupDir || (o.fuzz ? path.join(o.userData, "backups") : defaultBackupDir()) };
  };
  const need = () => { const g = o.gateway(); if (!g) throw new Error("Synapse isn't connected to its host yet."); return g; };
  const auth = (g: GatewayRef) => ({ authorization: `Bearer ${g.token}` });
  const orb = (user: "box" | "root", args: string[], stdin?: Buffer) => runBytes(resolveOrb(), ["-m", o.machine?.() ?? "box", "-u", user, ...args], stdin);
  const svc = new BackupService({
    userData: o.userData, appVersion: o.appVersion, now: Date.now, settings, log,
    key: {
      get: () => { const v = readSecret(o.userData, "backupKey"); return v ? Buffer.from(v, "base64") : null; },
      set: (k) => storeSecret(o.userData, "backupKey", k.toString("base64")),
    },
    canUnseal: (b) => sealer.read((s) => { try { s.decryptString(b); return true; } catch { return false; } }, false),
    // The backups folder may not exist yet: its nearest existing parent is on the same volume.
    freeBytes: (dir) => {
      for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { if (d === path.dirname(d)) return null; }
      }
    },
    host: {
      snapshot: async () => {
        const g = need();
        const r = await fetch(`${g.baseUrl}/backup/snapshot`, { headers: auth(g) });
        if (!r.ok || !r.body) throw new Error(`The host couldn't make a snapshot (${r.status}).`);
        return Readable.fromWeb(r.body as never);
      },
      stage: async (file, sha256) => {
        const g = need();
        const r = await fetch(`${g.baseUrl}/backup/restore`, {
          method: "PUT", headers: { ...auth(g), "x-backup-sha256": sha256, "content-length": String(fs.statSync(file).size) },
          body: Readable.toWeb(fs.createReadStream(file)) as never, duplex: "half",
        } as RequestInit);
        if (!r.ok) throw new Error(`The host refused the restore (${r.status}).`);
      },
      health: async () => {
        const g = o.gateway();
        if (!g) return null;
        const r = await fetch(`${g.baseUrl}/health`, { headers: auth(g) }).catch(() => null);
        return r?.ok ? (await r.json()) as HealthInfo : null;
      },
      botCount: async () => (await o.call("listAgents")).agents.length,
      // The FUZZ/local host restarts on reconnect (connect() disposes and relaunches it on the same data).
      restart: async () => { if (o.fuzz) await o.reconnect(); else await orb("root", ["systemctl", "restart", "bothost"]); },
      reconnect: o.reconnect,
    },
    // The Bots' Claude Code sessions are box-private (walls: cli-sessions), so they travel as the box user.
    sessions: o.fuzz ? undefined : {
      pull: () => orb("box", ["tar", "-C", "/home/box/.claude", "-czf", "-", "projects"]),
      push: async (tgz) => { await orb("box", ["tar", "-C", "/home/box/.claude", "-xzf", "-"], tgz); },
    },
  });
  // Only archives this session listed or the user picked can be previewed or restored.
  const allowed = new Set<string>();
  const allow = (f: string) => { allowed.add(path.resolve(f)); return f; };
  const checked = (f: unknown) => {
    const p = typeof f === "string" ? path.resolve(f) : "";
    if (!allowed.has(p) && !svc.list().some((a) => a.file === p)) throw new Error("Pick the backup file first.");
    return p;
  };
  const status = () => ({ ...svc.status(), defaultDir: o.fuzz ? path.join(o.userData, "backups") : defaultBackupDir() });
  const publish = () => o.emit("backups", status());
  o.reg("backups.status", () => status());
  o.reg("backups.backupNow", async () => { try { return await svc.backupNow("manual"); } finally { publish(); } });
  o.reg("backups.setSettings", (a: { auto?: unknown; keep?: unknown; dir?: unknown }) => {
    const patch: Record<string, unknown> = {};
    if (typeof a?.auto === "boolean") patch.backupAuto = a.auto;
    if (typeof a?.keep === "number" && a.keep >= 1 && a.keep <= 100) patch.backupKeep = Math.trunc(a.keep);
    if (a?.dir === null) patch.backupDir = null;
    writeAppSettings(o.userData, patch);
    return status();
  });
  o.reg("backups.chooseFolder", async () => {
    const dir = await o.dialog.openFolder();
    if (dir) writeAppSettings(o.userData, { backupDir: dir });
    return status();
  });
  o.reg("backups.chooseArchive", async () => { const f = await o.dialog.openArchive(); return f ? { file: allow(f) } : { file: null }; });
  o.reg("backups.preview", (a: { file: unknown; code?: unknown }) => svc.preview(checked(a?.file), typeof a?.code === "string" ? a.code : undefined));
  o.reg("backups.restore", async (a: { file: unknown; code?: unknown }) => {
    try { return await svc.restore(checked(a?.file), typeof a?.code === "string" ? a.code : undefined); } finally { publish(); }
  });
  o.reg("backups.reveal", (a: { file: unknown }) => { o.reveal(checked(a?.file)); return {}; });
  o.reg("backups.recoveryCode", () => ({ code: svc.pendingRecoveryCode() }));
  o.reg("backups.ackRecoveryCode", () => { svc.ackRecoveryCode(); return status(); });
  o.reg("backups.saveRecoveryCode", async () => {
    const code = svc.pendingRecoveryCode();
    if (!code) throw new Error("The recovery code was already saved.");
    return { saved: await o.dialog.saveText("Synapse Recovery Code.txt", `Synapse backup recovery code\n\n${code}\n\nKeep this somewhere safe. It opens your Synapse backups on another Mac.\n`) };
  });
  // The daily backup: checked every 30 minutes (and shortly after launch); runs once a day.
  const tick = async () => { if (o.gateway() && await svc.tick()) publish(); };
  setTimeout(() => void tick(), 2 * 60_000).unref();
  setInterval(() => void tick(), 30 * 60_000).unref();
  return svc;
}
