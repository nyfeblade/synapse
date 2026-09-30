import { spawn } from "node:child_process";
import type { ShellService } from "../../background/shells";
import type { CodingShell } from "./coding-tools";

/**
 * Where a provider-loop or ACP coding agent's commands run.
 *  - `serviceShell`: the host's ShellService, so a command runs exactly as a Bot's Shell does: as the Bot's own account
 *    (bot-shell) on the box, with the Bot's env (never a token), in the canonical folder it was checked in. Each agent
 *    keeps its own working folder (childId), a Stop stops the command, and one past its limit is stopped, not
 *    backgrounded.
 *  - `localShell`: the coding bench on the Mac (and tests): bash in the folder, as the current user, same answer shape.
 */
const FOOTER = /\n?\[exit code (-?\d+) · [^\]]*? · cwd ([^\]]*)\]\s*$/;

export function serviceShell(shells: () => ShellService | null): CodingShell {
  return async (botId, agentId, r) => {
    const s = shells();
    if (!s) return { text: "The computer's shell isn't ready yet. Try again shortly.", isError: true };
    const res = await s.run(botId, { command: r.command, working_directory: r.cwd, block_until_ms: r.timeoutMs }, { childId: `coding:${agentId}`, signal: r.signal, stopAtLimit: true });
    const m = FOOTER.exec(res.text);
    return { text: res.text, ...(res.isError ? { isError: true } : {}), ...(m ? { cwd: m[2]!.trim() } : {}) };
  };
}

const OUTPUT_TAIL = 30_000;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function localShell(o: { env?: Record<string, string> } = {}): CodingShell {
  return (_botId, _agentId, r) => new Promise((resolve) => {
    const t0 = Date.now();
    const marker = `__coding_cwd_${Math.random().toString(36).slice(2)}__`;
    const script = `cd -- ${q(r.cwd)} || exit 97\n${r.command}\n__ec=$?\nprintf '\\n${marker}%s' "$(pwd)"\nexit $__ec\n`;
    const p = spawn("bash", ["-c", script], {
      cwd: r.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: o.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", LANG: "C.UTF-8", CI: "1" },
    });
    let out = "";
    const add = (b: Buffer) => { out += b.toString("utf8"); if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2); };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    let why: string | null = null;
    const kill = (reason: string) => { if (why) return; why = reason; try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ } };
    const timer = setTimeout(() => kill(`stopped after ${Math.round(r.timeoutMs / 1000)} s: the command ran past its time limit`), r.timeoutMs);
    const onAbort = () => kill("stopped: the coding agent was stopped");
    if (r.signal.aborted) onAbort(); else r.signal.addEventListener("abort", onAbort, { once: true });
    p.on("close", (code, sig) => {
      clearTimeout(timer);
      r.signal.removeEventListener("abort", onAbort);
      const i = out.lastIndexOf(marker);
      const end = i >= 0 ? out.slice(i + marker.length).trim() : null;
      let body = (i >= 0 ? out.slice(0, i) : out).replace(/\n+$/, "");
      if (body.length > OUTPUT_TAIL) body = `…[earlier output cut]\n${body.slice(-OUTPUT_TAIL)}`;
      const ec = code ?? (sig ? 143 : 1);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (why) { resolve({ text: `${body}\n[${why}]`, isError: true }); return; }
      resolve({ text: `${body}\n[exit code ${ec} · ${secs} s · cwd ${end ?? r.cwd}]`, ...(end ? { cwd: end } : {}) });
    });
  });
}
