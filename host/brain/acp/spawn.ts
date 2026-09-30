import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AcpVendorId } from "@synapse/shared";
import type { HostConfig } from "../../config";
import { botOsUser } from "../../walls/bot-uid";

/**
 * How a vendor CLI is started for a Bot (Wave 3). On the box it is ALWAYS the root helper box/files/bot-acp-as-box,
 * which drops to the Bot's own uid, sets HOME to the Bot's 0700 home (so the vendor's login lands there and no other Bot
 * can read it) and runs the one command its own table names for that vendor and mode. The host passes only the
 * account, the Bot id, the vendor id and the mode — never a path or an argument — and an empty environment.
 *
 * A box that hasn't moved to per-Bot accounts refuses: every Bot would share the `box` home, and so one Bot's vendor
 * login would be readable by all the others.
 */
export const ACP_AS_BOX = "/usr/local/libexec/bot-acp-as-box";
export type AcpMode = "acp" | "login";

export interface AcpProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number | null;
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(cb: (e: Error) => void): void;
}
export type AcpSpawn = (o: { botId: string; vendor: AcpVendorId; mode: AcpMode }) => AcpProcess;

export class AcpNotAvailable extends Error {
  constructor(message: string) { super(message); this.name = "AcpNotAvailable"; }
}

export function wrapChild(c: ChildProcess): AcpProcess {
  return {
    stdin: c.stdin!, stdout: c.stdout!, stderr: c.stderr!,
    get pid() { return c.pid ?? null; },
    kill: (s = "SIGTERM") => { try { c.kill(s); } catch { /* already gone */ } },
    onExit: (cb) => { c.once("exit", cb); },
    onError: (cb) => { c.once("error", cb); },
  };
}

/** The box: `sudo -n bot-acp-as-box <account> <botId> <vendor> <mode>`, nothing else. */
export function boxAcpSpawn(cfg: Pick<HostConfig, "perBotUid" | "botHomes" | "workspace">): AcpSpawn {
  return ({ botId, vendor, mode }) => {
    const u = botOsUser(cfg, botId);
    if (!u) throw new AcpNotAvailable("A coding CLI sign-in needs the Bot's own account, and this Bot doesn't have one yet.");
    const c = nodeSpawn("sudo", ["-n", ACP_AS_BOX, u.name, botId, vendor, mode], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
    return wrapChild(c);
  };
}

/** Tests and the fake brain: a given command, with the Bot's own (test) home as HOME and nothing else in its env. */
export function directAcpSpawn(o: { command: string; args: (vendor: AcpVendorId, mode: AcpMode) => string[]; home: (botId: string) => string; cwd?: string }): AcpSpawn {
  return ({ botId, vendor, mode }) => {
    const c = nodeSpawn(o.command, o.args(vendor, mode), { cwd: o.cwd ?? "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.home(botId) }, stdio: ["pipe", "pipe", "pipe"] });
    return wrapChild(c);
  };
}
