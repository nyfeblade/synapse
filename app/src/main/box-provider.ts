import { execFile, spawn } from "node:child_process";
import { resolveOrb } from "./orb-path";

export type GatewayRoute = "localhost" | "orb-hostname" | "ssh-tunnel";
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execCommand: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    // 64 MB: a full provision prints far more than execFile's 1 MB default, which killed it mid-run.
    execFile(cmd, args, { timeout: opts?.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** OrbStack's ssh: <machine>@orb reaches that machine (portable install: the profile's machine, not always "box"). */
export function spawnSshTunnel(localPort: number, remotePort: number, machine = "box"): { close(): void } {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machine)) throw new Error("bad machine name");
  const p = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, `${machine}@orb`], { stdio: "ignore" });
  return { close: () => p.kill() };
}

export interface BoxProviderConfig {
  machine: string;
  route: GatewayRoute;
  gatewayHost?: string;
  pollMs?: number;
  spawnTunnel?: (localPort: number, remotePort: number, machine: string) => { close(): void };
}

export class OrbBoxProvider {
  constructor(private exec: Exec, private cfg: BoxProviderConfig) {}

  async status(): Promise<"running" | "stopped" | "missing"> {
    const r = await this.exec(resolveOrb(), ["list"]);
    const line = r.stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === this.cfg.machine);
    if (!line) return "missing";
    return line.trim().split(/\s+/)[1] === "running" ? "running" : "stopped";
  }

  async ensureRunning(): Promise<void> {
    const s = await this.status();
    if (s === "missing") throw new Error(`OrbStack machine "${this.cfg.machine}" not found`);
    if (s === "stopped") {
      const r = await this.exec(resolveOrb(), ["start", this.cfg.machine], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`orb start failed: ${r.stderr.trim()}`);
    }
  }

  async stop(): Promise<void> {
    const s = await this.status();
    if (s !== "running") return;
    const r = await this.exec(resolveOrb(), ["stop", this.cfg.machine], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`orb stop failed: ${r.stderr.trim()}`);
  }

  async readGatewayInfo(timeoutMs = 60_000): Promise<{ port: number; token: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.exec(resolveOrb(), ["-m", this.cfg.machine, "-u", "root", "cat", "/home/box/.host/gateway.json"]);
      if (r.code === 0) {
        const j = JSON.parse(r.stdout) as { port: number; token: string };
        return { port: j.port, token: j.token };
      }
      if (Date.now() > deadline) throw new Error("The host did not start (no gateway.json).");
      await new Promise((res) => setTimeout(res, this.cfg.pollMs ?? 1000));
    }
  }

  async connect(port: number): Promise<{ baseUrl: string; close(): void }> {
    switch (this.cfg.route) {
      case "localhost":
        return { baseUrl: `http://127.0.0.1:${port}`, close: () => {} };
      case "orb-hostname":
        return { baseUrl: `http://${this.cfg.gatewayHost ?? `${this.cfg.machine}.orb.local`}:${port}`, close: () => {} };
      case "ssh-tunnel": {
        const t = (this.cfg.spawnTunnel ?? spawnSshTunnel)(port, port, this.cfg.machine);
        return { baseUrl: `http://127.0.0.1:${port}`, close: () => t.close() };
      }
    }
  }
}
