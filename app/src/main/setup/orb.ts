import fs from "node:fs";
import path from "node:path";
import type { Exec } from "../box-provider";
import { isExecutableFile, orbAppCandidates, orbCandidates } from "../orb-path";
import type { OrbReport } from "./state";

/**
 * Portable install: what the setup screen needs to know about OrbStack and the Bots' computer. OrbStack
 * itself is never bundled (its licence), only detected, linked to and started.
 */
export const ORBSTACK_DOWNLOAD_URL = "https://orbstack.dev/download";
/** A new install's machine. A Mac that already had Synapse's "box" keeps it (boxMachineName). */
export const NEW_MACHINE = "synapse-box";
export const LEGACY_MACHINE = "box";
/** Written into a machine the moment Synapse creates it: only a marked machine is ever adopted or reset. */
export const CREATED_MARKER = "/etc/bots/created-by-synapse";

/**
 * Which machine this profile uses: the one recorded in settings, else "box" for a profile that has
 * already talked to one (box-pin.json exists: it pinned that box's key), else "synapse-box".
 */
export function boxMachineName(o: { setting?: string | null; userData: string; exists?: (p: string) => boolean }): string {
  if (o.setting && /^[a-z0-9][a-z0-9-]{0,62}$/.test(o.setting)) return o.setting;
  return (o.exists ?? fs.existsSync)(path.join(o.userData, "box-pin.json")) ? LEGACY_MACHINE : NEW_MACHINE;
}

export interface OrbDetection extends OrbReport { cliPath: string | null; version: string | null }

export async function detectOrb(o: { exec: Exec; home: string; exists?: (p: string) => boolean; isExec?: (p: string) => boolean }): Promise<OrbDetection> {
  const exists = o.exists ?? fs.existsSync;
  const isExec = o.isExec ?? isExecutableFile;
  const app = orbAppCandidates(o.home).some((p) => exists(p));
  const cliPath = orbCandidates(o.home).find((p) => isExec(p)) ?? null;
  if (!cliPath) return { app, cli: false, cliPath: null, version: null, status: app ? "stopped" : "unknown" };
  // `orb status`: Running = 0, Starting = 2, Stopped = 1 (its own help text).
  const r = await o.exec(cliPath, ["status"], { timeoutMs: 10_000 });
  const status: OrbReport["status"] = r.code === 0 ? "running" : r.code === 2 || /starting/i.test(r.stdout) ? "starting" : "stopped";
  let version: string | null = null;
  if (status === "running") {
    const v = await o.exec(cliPath, ["version"], { timeoutMs: 10_000 });
    version = /Version:\s*([\d.]+)/.exec(v.stdout)?.[1] ?? null;
  }
  return { app, cli: true, cliPath, version, status };
}

/**
 * Start OrbStack. Its very first launch opens its own window (the licence and its helper install need the user),
 * so it is not hidden then; once it has been set up (~/.orbstack exists) it starts in the background (-g).
 */
export async function startOrbStack(exec: Exec, o: { home: string; exists?: (p: string) => boolean }): Promise<void> {
  const setUp = (o.exists ?? fs.existsSync)(path.join(o.home, ".orbstack"));
  const r = await exec("/usr/bin/open", [...(setUp ? ["-g"] : []), "-a", "OrbStack"], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "OrbStack could not be started.");
}

export interface MachineInfo { name: string; state: string; isolated: boolean }

/** `orb list -f json`; [] when OrbStack can't answer. */
export async function listMachines(exec: Exec, orb: string): Promise<MachineInfo[]> {
  const r = await exec(orb, ["list", "-f", "json"], { timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{ name?: unknown; state?: unknown; config?: { isolated?: unknown } }>;
    return rows.filter((m) => typeof m.name === "string").map((m) => ({ name: String(m.name), state: String(m.state ?? ""), isolated: m.config?.isolated === true }));
  } catch {
    return [];
  }
}

/** `ok`: the machine answered (all five fields came back); false when it couldn't be read (down, timed out). */
export interface MachineMarks { ok: boolean; image: string | null; provisioned: string | null; created: boolean; hostBuild: string | null; gateway: boolean }

/** One call into the machine: the markers Synapse writes, the host build it runs, whether the host is up. */
/** `gatewayPort`: the host counts as up only on this Mac user's own port (two accounts on one Mac, user-ports.ts). */
export async function machineMarks(exec: Exec, orb: string, name: string, gatewayPort?: number): Promise<MachineMarks> {
  const port = gatewayPort !== undefined && Number.isInteger(gatewayPort) ? gatewayPort : null;
  const script = [
    "cat /etc/bots/image-version 2>/dev/null; echo '|'",
    "cat /etc/bots/provisioned 2>/dev/null; echo '|'",
    `test -f ${CREATED_MARKER} && echo yes; echo '|'`,
    "cat /opt/bothost/app/build-id.txt 2>/dev/null; echo '|'",
    port === null
      ? "test -s /home/box/.host/gateway.json && echo yes"
      : `grep -Eq '"port"[[:space:]]*:[[:space:]]*${port}[^0-9]' /home/box/.host/gateway.json 2>/dev/null && echo yes`,
  ].join("; ");
  const r = await exec(orb, ["-m", name, "-u", "root", "sh", "-c", script], { timeoutMs: 60_000 });
  const parts = r.stdout.split("|");
  const [image, provisioned, created, hostBuild, gateway] = parts.map((s) => s.trim());
  const v = (s: string | undefined) => (s && /^[0-9a-f]{16}$/.test(s) ? s : null);
  return { ok: r.code === 0 && parts.length === 5, image: v(image), provisioned: v(provisioned), created: created === "yes", hostBuild: v(hostBuild), gateway: gateway === "yes" };
}

/**
 * Whether Synapse may use (or reset) a machine: it must be isolated and carry a Synapse marker. A user's
 * own machine that happens to share the name is never adopted, provisioned or deleted.
 */
export function adoptable(m: MachineInfo | undefined, marks: Pick<MachineMarks, "image" | "provisioned" | "created"> | null): boolean {
  return !!m && m.isolated && !!marks && (marks.created || marks.image !== null || marks.provisioned !== null);
}

/** Machine size: 4 CPUs (or fewer), memory min(8 GiB, half this Mac), 64 GB disk. */
export function machineSize(o: { cpus: number; totalMemBytes: number }): { cpus: number; memoryMib: number; disk: string } {
  const half = Math.floor(o.totalMemBytes / 2 / 1024 / 1024);
  return { cpus: Math.max(1, Math.min(4, o.cpus)), memoryMib: Math.max(2048, Math.min(8192, half)), disk: "64G" };
}
