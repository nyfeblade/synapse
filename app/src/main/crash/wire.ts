import fs from "node:fs";
import path from "node:path";
import { createRotatingLog } from "../rotating-log";
import { redactText } from "./redact";
import { CrashStore, type CrashInput } from "./store";

/**
 * Crash and error reporting, local only (Settings → Diagnostics). No network upload of any kind.
 *
 * Sources: main-process uncaught exceptions and unhandled rejections, renderer crashes (the window
 * is reloaded) and renderer errors, other Electron child processes and the coordinator dying, the
 * native dictation helper exiting abnormally, and a host whose previous run ended without close()
 * (/health's previousRun, with the box journal's last lines cut to time, level and message).
 */
export function installCrashReporting(o: {
  userData: string; logsDir: string; appVersion: string; hostVersion(): string | null; secrets(): string[];
  reg(name: string, fn: (a: any) => unknown): void; emit(ch: string, p: unknown): void;
  reveal(file: string): void; copyText(text: string): void;
}) {
  // Every console line of the main process also lands, redacted, in ~/Library/Logs/Synapse/main.log:
  // the "last 200 log lines" of a report come from here.
  const mainLog = createRotatingLog({ dir: o.logsDir, name: "main.log", maxBytes: 1024 * 1024, keep: 2 });
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try { mainLog(`${level} ${redactText(args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 4000))}`); } catch { /* never let logging throw */ }
    };
  }
  const logFiles = () => [path.join(o.logsDir, "main.log.1"), path.join(o.logsDir, "main.log"), path.join(o.logsDir, "backup.log"), path.join(o.logsDir, "update.log")].filter((f) => fs.existsSync(f));
  // A report's own tail is the main log; exported zips add the backup and update logs. Never voice.log (dictated speech).
  const store = new CrashStore({ dir: path.join(o.userData, "crashes"), appVersion: o.appVersion, hostVersion: o.hostVersion, secrets: o.secrets,
    logFiles: () => logFiles().filter((f) => path.basename(f).startsWith("main.log")) });
  const publish = () => { try { o.emit("crashes", { unseen: store.unseen() }); } catch { /* no window */ } };
  const record = (i: CrashInput) => {
    try { const r = store.record(i); publish(); return r; } catch { return null; }
  };
  const errOf = (e: unknown) => (e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) });

  process.on("uncaughtException", (e) => { record({ kind: "main-crash", ...errOf(e) }); });
  process.on("unhandledRejection", (e) => { record({ kind: "unhandled-rejection", ...errOf(e) }); });

  o.reg("crashes.list", () => ({ reports: store.list().map(({ log: _l, hostLog: _h, ...r }) => r), unseen: store.unseen() }));
  o.reg("crashes.unseen", () => ({ unseen: store.unseen() }));
  o.reg("crashes.markSeen", () => { store.markSeen(); publish(); return {}; });
  o.reg("crashes.reportRenderer", (a: { message?: unknown; stack?: unknown }) => {
    if (typeof a?.message === "string") record({ kind: "renderer-error", message: a.message, stack: typeof a.stack === "string" ? a.stack : undefined });
    return {};
  });
  const reportsDir = path.join(o.logsDir, "reports");
  o.reg("crashes.copy", async (a: { id?: unknown }) => {
    const id = String(a?.id ?? "");
    await store.exportReport(id, { outDir: reportsDir, files: logFiles() });
    o.copyText(store.reportText(id));
    return {};
  });
  o.reg("crashes.reveal", async (a: { id?: unknown }) => { o.reveal(await store.exportReport(String(a?.id ?? ""), { outDir: reportsDir, files: logFiles() })); return {}; });

  // Host runs already reported, so a crash is recorded once however many times the app reconnects.
  const seenFile = path.join(o.userData, "crashes", "host-runs-seen.json");
  const seenRuns = (): string[] => { try { return JSON.parse(fs.readFileSync(seenFile, "utf8")) as string[]; } catch { return []; } };
  return {
    store,
    record,
    /** From each connect's /health: a previous host run that ended without close() is a host crash. */
    async noteHostHealth(h: { previousRun?: { bootId: string; startedAt: number; clean: boolean } | null } | null, hostLog: () => Promise<string[]>): Promise<void> {
      const prev = h?.previousRun;
      if (!prev || prev.clean) return;
      const seen = seenRuns();
      if (seen.includes(prev.bootId)) return;
      fs.mkdirSync(path.dirname(seenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(seenFile, JSON.stringify([...seen, prev.bootId].slice(-50)), { mode: 0o600 });
      const lines = await hostLog().catch(() => []);
      record({ kind: "host-crash", message: `The host stopped unexpectedly (it started ${new Date(prev.startedAt).toISOString()}) and was restarted.`, hostLog: lines });
    },
  };
}
