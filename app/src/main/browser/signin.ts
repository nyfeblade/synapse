/**
 * mac-browser, "Sign in to sites" (bug-log 150). Google refuses a sign-in in a Chrome that runs with remote debugging
 * ("Couldn't sign you in": it treats it as automated), so the Bots' window can't be where the user signs in. This
 * opens the SAME dedicated profile as plain Chrome (no debugging, no automation flags); the user signs in once and
 * quits it or clicks Done, and later Bot sessions reuse the saved cookies over CDP.
 *
 * Chrome runs one process per profile (SingletonLock, "<host>-<pid>"): a second launch on a locked profile only hands
 * its arguments to the running one and exits. So the automated Chrome quits first, and while the plain one is open
 * the controller refuses actions instead of relaunching onto it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_PROFILE_NAME, STRB } from "@synapse/shared";

export const SIGNIN_START_URL = "https://accounts.google.com/";

/** Plain Chrome on the Bots' profile: only the profile and the first-run skips, then the page to open. */
export function chromeSigninArgs(profileDir: string, url = SIGNIN_START_URL): string[] {
  return [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", url];
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}
const obj = (o: Record<string, unknown>, k: string): Record<string, unknown> => {
  const v = o[k];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  const n: Record<string, unknown> = {};
  o[k] = n;
  return n;
};

/**
 * Names the profile (Local State's profile list and the profile's own Preferences) so Chrome shows "Synapse", not
 * the default "Your Chrome" that reads as a guest, and marks the last exit clean (no "Restore pages?" bubble). Only
 * while Chrome isn't running on it; every other setting is kept.
 */
export function nameProfile(profileDir: string, name = BROWSER_PROFILE_NAME): void {
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true, mode: 0o700 });
  const lsFile = path.join(profileDir, "Local State");
  const ls = readJson(lsFile);
  const entry = obj(obj(obj(ls, "profile"), "info_cache"), "Default");
  entry.name = name;
  entry.is_using_default_name = false;
  fs.writeFileSync(lsFile, JSON.stringify(ls), { mode: 0o600 });
  const prFile = path.join(profileDir, "Default", "Preferences");
  const pr = readJson(prFile);
  const p = obj(pr, "profile");
  p.name = name;
  p.using_default_name = false;
  p.exit_type = "Normal";
  fs.writeFileSync(prFile, JSON.stringify(pr), { mode: 0o600 });
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Who holds the profile: Chrome's SingletonLock, if a live process on this Mac owns it (a stale one is null). */
export function profileLock(profileDir: string, host = os.hostname()): { pid: number } | null {
  let target: string;
  try { target = fs.readlinkSync(path.join(profileDir, "SingletonLock")); } catch { return null; }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m || m[1] !== host) return null;
  const pid = Number(m[2]);
  return pidAlive(pid) ? { pid } : null;
}

export async function waitForUnlock(profileDir: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (profileLock(profileDir)) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** Waits for a child to exit; SIGKILL after the grace. */
export function quitProcess(proc: ChildProcess, graceMs: number, signal: NodeJS.Signals | null = "SIGTERM"): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, graceMs);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
    if (signal) { try { proc.kill(signal); } catch { /* gone */ } }
  });
}

export class BrowserSignin {
  private proc: ChildProcess | null = null;
  private busy: Promise<void> | null = null;
  private opening: Promise<void> | null = null;

  constructor(private o: {
    controller: { beginSignin(): Promise<void>; endSignin(): void };
    chrome: string | null;
    profileDir: string;
    log(line: string): void;
    onChange?(active: boolean): void;
    spawnFn?: typeof spawn;
    lockTimeoutMs?: number;
  }) {}

  active(): boolean { return this.proc !== null; }

  /** Quits the automated Chrome, then opens the profile as plain Chrome. Throws a user-facing message. */
  start(): Promise<void> {
    if (this.proc && !this.opening) return Promise.resolve();
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<void> {
    if (!this.o.chrome) throw new Error(STRB.signinNeedsChrome);
    await this.busy;
    await this.o.controller.beginSignin();
    const dir = this.o.profileDir;
    if (!(await waitForUnlock(dir, this.o.lockTimeoutMs ?? 10_000))) {
      this.o.controller.endSignin();
      throw new Error(STRB.signinLocked);
    }
    nameProfile(dir);
    const proc = (this.o.spawnFn ?? spawn)(this.o.chrome, chromeSigninArgs(dir), { stdio: "ignore", detached: false });
    this.proc = proc;
    let announced = false;
    const ended = (why: string) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.o.controller.endSignin();
      this.o.log(`browser: sign-in window ${why}; Bots will reuse its sign-ins`);
      if (announced) this.o.onChange?.(false);
    };
    proc.once("exit", () => ended("closed"));
    proc.once("error", (e) => ended(`failed (${e.message})`));
    // Up once it holds the profile (a quick exit instead means it handed off to a Chrome we don't know about).
    for (let until = Date.now() + 5_000; this.proc === proc && !profileLock(dir) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    if (this.proc !== proc) throw new Error(STRB.signinLocked);
    this.o.log("browser: Sign in to sites opened the profile in plain Chrome (no remote debugging)");
    announced = true;
    this.o.onChange?.(true);
  }

  /** Done: quits that Chrome cleanly (it saves its cookies on SIGTERM) and hands the profile back to the Bots. */
  async done(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.busy = (async () => {
      await quitProcess(proc, 8_000);
      await waitForUnlock(this.o.profileDir, 3_000);
    })();
    await this.busy;
  }
}
