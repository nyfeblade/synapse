import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file";
import { hostLogLine, redactText } from "./redact";

/**
 * Settings → Diagnostics: a local store of problems Synapse recovered from. Local only — nothing
 * here is ever sent anywhere. Each report is a stack, the app and host versions and the last 200
 * log lines, all redacted; never message content (only the main-process log is read, never the
 * voice log, and host log lines are cut down to time, level and message).
 */
export type CrashKind = "main-crash" | "unhandled-rejection" | "renderer-crash" | "renderer-error" | "child-crash" | "helper-exit" | "host-crash" | "host-restart";
export interface CrashInput { kind: CrashKind; message: string; stack?: string; hostLog?: string[] }
export interface CrashReport {
  id: string; at: number; kind: CrashKind; message: string; stack?: string; appVersion: string; hostVersion: string | null;
  log: string[]; hostLog?: string[]; count: number; seen: boolean;
}

const KEEP = 50;
const LOG_LINES = 200;
const DEDUPE_MS = 60_000;

function tail(files: string[], n: number): string[] {
  const lines: string[] = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, "r");
      const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const got = buf.toString("utf8").split("\n").filter(Boolean);
      lines.push(...(len < st.size ? got.slice(1) : got));
    } catch { /* no log yet */ }
  }
  return lines.slice(-n);
}

export class CrashStore {
  private now: () => number;
  constructor(private o: { dir: string; appVersion: string; hostVersion(): string | null; logFiles(): string[]; secrets(): string[]; now?(): number }) {
    this.now = o.now ?? Date.now;
  }

  private redact(t: string, secrets: string[]): string { return redactText(t, secrets); }

  list(): CrashReport[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.o.dir).filter((f) => /^crash-[\w-]+\.json$/.test(f)); } catch { return []; }
    return names.flatMap((f) => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.o.dir, f), "utf8")) as CrashReport]; } catch { return []; }
    }).sort((a, b) => b.at - a.at);
  }

  private write(r: CrashReport): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(this.o.dir, `${r.id}.json`), JSON.stringify(r), 0o600);
  }

  /** Synchronous on purpose: it runs from uncaughtException, where nothing asynchronous is sure to finish. */
  record(i: CrashInput): CrashReport {
    const secrets = (() => { try { return this.o.secrets(); } catch { return []; } })();
    const message = this.redact(String(i.message ?? "").slice(0, 500), secrets);
    const at = this.now();
    const all = this.list();
    const same = all.find((r) => r.kind === i.kind && r.message === message && at - r.at < DEDUPE_MS);
    if (same) {
      const r = { ...same, at, count: same.count + 1, seen: false };
      this.write(r);
      return r;
    }
    const r: CrashReport = {
      id: `crash-${at.toString(36)}-${randomBytes(3).toString("hex")}`, at, kind: i.kind, message,
      ...(i.stack ? { stack: this.redact(i.stack.split("\n").slice(0, 40).join("\n").slice(0, 8000), secrets) } : {}),
      appVersion: this.o.appVersion, hostVersion: (() => { try { return this.o.hostVersion(); } catch { return null; } })(),
      log: tail(this.o.logFiles(), LOG_LINES).map((l) => this.redact(l.slice(0, 2000), secrets)),
      ...(i.hostLog ? { hostLog: i.hostLog.flatMap((l) => { const h = hostLogLine(l); return h ? [this.redact(h.slice(0, 1000), secrets)] : []; }).slice(-LOG_LINES) } : {}),
      count: 1, seen: false,
    };
    this.write(r);
    for (const old of [r, ...all].slice(KEEP)) fs.rmSync(path.join(this.o.dir, `${old.id}.json`), { force: true });
    return r;
  }

  unseen(): number { return this.list().filter((r) => !r.seen).length; }
  markSeen(): void { for (const r of this.list()) if (!r.seen) this.write({ ...r, seen: true }); }

  private get(id: string): CrashReport {
    const r = this.list().find((x) => x.id === id);
    if (!r) throw new Error("That problem report is gone.");
    return r;
  }

  reportText(id: string): string {
    const r = this.get(id);
    return [
      `Synapse problem report (local; never uploaded)`,
      `What: ${r.kind}${r.count > 1 ? ` (x${r.count})` : ""}`,
      `When: ${new Date(r.at).toISOString()}`,
      `App: ${r.appVersion}  Host: ${r.hostVersion ?? "unknown"}`,
      `Message: ${r.message}`,
      ...(r.stack ? ["", "Stack:", r.stack] : []),
      ...(r.hostLog?.length ? ["", "Host log (last lines):", ...r.hostLog] : []),
      "", "App log (last lines):", ...r.log,
    ].join("\n");
  }

  /** A zip holding report.json and every log file, redacted line by line. Returns its path. */
  async exportReport(id: string, o: { outDir: string; files?: string[]; zip?(dir: string, out: string): Promise<void> }): Promise<string> {
    const r = this.get(id);
    const secrets = (() => { try { return this.o.secrets(); } catch { return []; } })();
    fs.mkdirSync(o.outDir, { recursive: true, mode: 0o700 });
    const work = fs.mkdtempSync(path.join(o.outDir, ".report-"));
    try {
      fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(r, null, 2), { mode: 0o600 });
      for (const f of o.files ?? this.o.logFiles()) {
        const lines = tail([f], 5000);
        if (lines.length) fs.writeFileSync(path.join(work, path.basename(f)), `${lines.map((l) => this.redact(l, secrets)).join("\n")}\n`, { mode: 0o600 });
      }
      const out = path.join(o.outDir, `Synapse-report-${new Date(r.at).toISOString().replace(/[:.]/g, "-")}.zip`);
      await (o.zip ?? dittoZip)(work, out);
      return out;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

function dittoZip(dir: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => execFile("/usr/bin/ditto", ["-c", "-k", dir, out], { timeout: 60_000 }, (e) => (e ? reject(e) : resolve())));
}
