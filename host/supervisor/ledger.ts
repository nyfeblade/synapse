import { execFile } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";

export interface LedgerProc { pid: number; botId: string; kind: "bot" | "child"; sessionId: string | null; startedAt: number }
export interface LedgerFile { hostBootId: string; procs: LedgerProc[] }

export class SupervisorLedger {
  /** What this host last wrote: the host's 1 s ticker calls write() every second, and an idle host must not
   *  rewrite (and fsync) an unchanged file every second (0.1.4 first-run, code audit 6.3). */
  private last: string | null = null;
  constructor(private file: string, private hostBootId: string) {}
  /** Writes only when the processes changed since the last write. Returns whether it wrote. */
  write(procs: LedgerProc[]): boolean {
    const key = JSON.stringify(procs);
    if (key === this.last) return false;
    writeJsonAtomic(this.file, { hostBootId: this.hostBootId, procs }, 0o600);
    this.last = key;
    return true;
  }
  read(): LedgerFile | null {
    return readJson<LedgerFile | null>(this.file, null);
  }
}

/** Only the host spawns processes as user box, so at host boot every one of them is an orphan (§16.8). */
export function reapWithSudo(): Promise<void> {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "/usr/local/libexec/bot-reap"], { env: scrubClaudeLogin(process.env), timeout: 10_000 }, (err) => {
      if (err) log.warn("bot-reap failed", { error: String(err) });
      resolve();
    });
  });
}

export async function bootSweep(o: { brain: "claude" | "fake"; reap: () => Promise<void> }): Promise<void> {
  if (o.brain !== "claude") return;
  await o.reap();
}
