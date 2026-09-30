import { spawn } from "node:child_process";
import { execBounded, ORB_LIMITS, orbCall } from "./orb-exec";
import { resolveOrb } from "./orb-path";

export type GatewayRoute = "localhost" | "orb-hostname" | "ssh-tunnel";
export interface ExecResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string>; stdin?: Buffer }) => Promise<ExecResult>;

/**
 * Bug 435: runs in its own process group and kills the whole group on timeout (a box script's stuck `orb`
 * grandchild used to keep the pipes open, so the call never returned). 64 MB of output: a full provision prints a lot.
 */
export const execCommand: Exec = execBounded;

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
    const r = await orbCall(this.exec, resolveOrb(), ["list"], { timeoutMs: ORB_LIMITS.query, idempotent: true });
    const line = r.stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === this.cfg.machine);
    if (!line) return "missing";
    return line.trim().split(/\s+/)[1] === "running" ? "running" : "stopped";
  }

  async ensureRunning(): Promise<void> {
    const s = await this.status();
    if (s === "missing") throw new Error(`OrbStack machine "${this.cfg.machine}" not found`);
    if (s === "stopped") {
      const r = await orbCall(this.exec, resolveOrb(), ["start", this.cfg.machine], { timeoutMs: ORB_LIMITS.start, idempotent: true });
      if (r.code !== 0) throw new Error(`orb start failed: ${r.stderr.trim()}`);
    }
  }

  async stop(): Promise<void> {
    const s = await this.status();
    if (s !== "running") return;
    const r = await orbCall(this.exec, resolveOrb(), ["stop", this.cfg.machine], { timeoutMs: ORB_LIMITS.stop, idempotent: true });
    if (r.code !== 0) throw new Error(`orb stop failed: ${r.stderr.trim()}`);
  }

  /** `hello`: the host answers /hello (proof of host); an older host's gateway.json has no such field. */
  async readGatewayInfo(timeoutMs = 60_000): Promise<{ port: number; token: string; hello?: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await orbCall(this.exec, resolveOrb(), ["-m", this.cfg.machine, "-u", "root", "cat", "/home/box/.host/gateway.json"], { timeoutMs: ORB_LIMITS.read, idempotent: false /* this loop is the retry */ });
      if (r.code === 0) {
        const j = JSON.parse(r.stdout) as { port: number; token: string; hello?: unknown };
        return { port: j.port, token: j.token, ...(j.hello === 1 ? { hello: true } : {}) };
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
