import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Exec } from "../computer/x-exec";

export interface ShellSpawner {
  /** Bug #66: `account` = the Bot's own OS account (walls/bot-uid.ts) once the box is migrated, and `botId` the Bot
   *  (its private terminal file is /workspace/.host-out/terminals/<botId>/<id>.txt); absent = box, shared terminals. */
  start(id: string, cwd: string, account?: string, botId?: string): Promise<void>;
  stop(id: string): Promise<void>;
  status(id: string): Promise<"running" | "stopped">;
}

/** Decision 4: transient unit bot-shell-<id>.service as box, via the root helper from Task 2. */
export class SudoShellSpawner implements ShellSpawner {
  constructor(private exec: Exec, private helper = "/usr/local/libexec/bot-shell") {}
  async start(id: string, cwd: string, account?: string, botId?: string): Promise<void> {
    const r = await this.exec("sudo", ["-n", this.helper, "start", id, cwd, ...(account && botId ? [account, botId] : [])], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`bot-shell start ${id}: ${r.stderr.trim()}`);
  }
  async stop(id: string): Promise<void> {
    await this.exec("sudo", ["-n", this.helper, "stop", id], { timeoutMs: 15_000 });
  }
  async status(id: string): Promise<"running" | "stopped"> {
    const r = await this.exec("sudo", ["-n", this.helper, "status", id], { timeoutMs: 10_000 });
    return r.stdout.toString("utf8").trim() === "running" ? "running" : "stopped";
  }
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/\\(.)/g, (_s, c: string) => (c === "n" ? "\n" : c));
  }
  return out;
}

/** FUZZ mode and unit tests: same files and footer, run as the current user with plain child processes. */
export class LocalShellSpawner implements ShellSpawner {
  private procs = new Map<string, ChildProcess>();
  constructor(private o: { terminalsDir: string; runDir: string }) {}

  async start(id: string, cwd: string): Promise<void> {
    const env = parseEnvFile(fs.readFileSync(path.join(this.o.runDir, `${id}.env`), "utf8"));
    const out = path.join(this.o.terminalsDir, `${id}.txt`);
    const fd = fs.openSync(out, "a");
    const started = Date.now();
    // Like bot-shell, take the script's content at start; the service deletes the file once start returns.
    const script = fs.readFileSync(path.join(this.o.runDir, `${id}.sh`), "utf8");
    const p = spawn("bash", ["-c", script], {
      cwd: fs.existsSync(cwd) ? cwd : this.o.terminalsDir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", ...env },
      stdio: ["ignore", fd, fd], detached: true,
    });
    this.procs.set(id, p);
    p.on("exit", (code, signal) => {
      fs.closeSync(fd);
      if (!this.procs.has(id)) return; // stopped: the service writes its own footer
      this.procs.delete(id);
      const cwdFile = path.join(this.o.terminalsDir, `${id}.cwd`);
      const endCwd = fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, "utf8") : cwd;
      fs.rmSync(cwdFile, { force: true });
      const ec = code ?? (signal ? 128 + 15 : 1);
      const end = Date.now();
      // The transcript's folder can be gone by the time a shell exits (its Bot was deleted, a test cleaned up): the
      // footer is then dropped, never an uncaught exception in the host.
      try {
        fs.appendFileSync(out, `\n---\nexit_code: ${ec}\nelapsed_ms: ${end - started}\nended_at: ${end}\ncwd: ${endCwd}\n---\n`);
      } catch { /* folder removed */ }
    });
  }

  async stop(id: string): Promise<void> {
    const p = this.procs.get(id);
    this.procs.delete(id);
    if (p?.pid) {
      try { process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  async status(id: string): Promise<"running" | "stopped"> {
    return this.procs.has(id) ? "running" : "stopped";
  }
}
