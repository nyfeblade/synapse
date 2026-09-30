import { spawn } from "node:child_process";
import type { Exec, ExecResult } from "./box-provider";
import { resolveOrb } from "./orb-path";

/**
 * Bug 435: every `orb` call the app makes goes through here. OrbStack 2.2.3's agent now and then leaves a finished
 * command unreaped (seen within minutes of the box host restarting), and the Mac-side `orb` then waits forever.
 * So each call gets a limit sized to what it does, the whole process group is killed when it runs out, an
 * idempotent call is tried once more, and anything else comes back as a plain error the caller shows (setup: Retry).
 * The normal path adds nothing: no polling, the result resolves the moment the process closes.
 */

/** Exit code of a call that ran out of time (the same as timeout(1)). */
export const TIMED_OUT = 124;
/** Every timeout message starts with this; setup's plainError keys on it. */
export const ORB_TIMEOUT_TEXT = "OrbStack didn't answer";

/** Per-operation limits (ms). Short queries are a few seconds; create, provision and deploy are generous. */
export const ORB_LIMITS = {
  /** orb status / version / list. */
  query: 10_000,
  /** One quick read inside the machine (gateway.json, a marker file). */
  read: 10_000,
  /** A short command inside the machine that may first wake it (marks, bots-ports, journal). */
  inBox: 30_000,
  start: 5 * 60_000,
  stop: 2 * 60_000,
  restart: 3 * 60_000,
  delete: 3 * 60_000,
  create: 20 * 60_000,
  /** Backups: a tar of the Bots' projects in or out. */
  transfer: 10 * 60_000,
} as const;

/**
 * The box scripts the app runs (they bound their own orb calls, box/orb.sh). Each app limit sits just above the
 * script's own worst case, so the script's limit, with its plain "OrbStack didn't answer", always fires first.
 * provision-from-mac.sh: pkill 30 s + the in-box provision stream 3600 s + bots-ports 2 x 120 s = 64.5 min.
 * deploy.sh: the host stream 900 s + drop-in 60 s + bots-ports 2 x 120 s + restart 180 s = 23 min, plus the gateway check.
 */
export const SCRIPT_LIMITS = {
  provision: 65 * 60_000,
  deploy: 25 * 60_000,
} as const;

/** After SIGTERM to the group, SIGKILL follows this much later (a stuck orb ignores SIGTERM: seen live, only SIGKILL ends it); after SIGKILL, the call gives up on its pipes. */
const KILL_GRACE_MS = 1_500;
/** A process that exited but whose pipes a leftover grandchild still holds: stop waiting for them after this. */
const PIPE_GRACE_MS = 2_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface BoundedResult { code: number; stdout: Buffer; stderr: string; timedOut: boolean }

/**
 * Runs a command in its own process group with a hard limit. On timeout the whole group gets SIGTERM, then SIGKILL,
 * and the call resolves with code 124 whether or not the pipes ever close. Never rejects.
 */
export function runBounded(cmd: string, args: string[], o: { timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: Buffer; graceMs?: number }): Promise<BoundedResult> {
  const grace = o.graceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let overflow = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const timers: NodeJS.Timeout[] = [];
    let child: ReturnType<typeof spawn>;
    const finish = (code: number, extraErr = "") => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const stderr = Buffer.concat(err).toString("utf8") + extraErr;
      resolve({ code: timedOut ? TIMED_OUT : code, stdout: Buffer.concat(out), stderr, timedOut });
    };
    try {
      child = spawn(cmd, args, { detached: true, stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"], ...(o.env ? { env: o.env } : {}) });
    } catch (e) {
      resolve({ code: 1, stdout: Buffer.alloc(0), stderr: String((e as Error).message ?? e), timedOut: false });
      return;
    }
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const onData = (buf: Buffer[], isOut: boolean) => (d: Buffer) => {
      const n = isOut ? (outLen += d.length) : (errLen += d.length);
      if (n > MAX_BUFFER) { if (!overflow) { overflow = true; killGroup("SIGKILL"); } return; }
      buf.push(d);
    };
    child.stdout!.on("data", onData(out, true));
    child.stderr!.on("data", onData(err, false));
    if (o.stdin && child.stdin) { child.stdin.on("error", () => { /* the command closed its stdin early */ }); child.stdin.end(o.stdin); }
    child.on("error", (e) => finish(1, `${e.message}\n`));
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : 1);
      // Normally 'close' follows at once. A grandchild still holding the pipes must not hold the call.
      timers.push(setTimeout(() => finish(exitCode!), PIPE_GRACE_MS));
    });
    child.on("close", (code, signal) => finish(overflow ? 1 : (exitCode ?? code ?? (signal ? 128 : 1)), overflow ? "output too large\n" : ""));
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      timers.push(setTimeout(() => {
        killGroup("SIGKILL");
        timers.push(setTimeout(() => finish(TIMED_OUT), grace));
      }, grace));
    }, o.timeoutMs));
  });
}

export interface OrbCallOpts {
  timeoutMs: number;
  /** Safe to run twice: a timed-out call is tried once more. Anything else surfaces the error. */
  idempotent: boolean;
  env?: Record<string, string>;
  stdin?: Buffer;
}
export interface OrbResult extends ExecResult { timedOut?: boolean }

/** Which orb operation, for the message: "list", "start", "-m box … cat", never the full script. */
function verb(args: string[]): string {
  if (args[0] === "-m") {
    const rest = args.slice(2);
    const i = rest[0] === "-u" ? 2 : 0;
    return `${args[1]}: ${rest.slice(i, i + 1).join(" ")}`.trim();
  }
  return args.slice(0, 2).join(" ");
}

function timeoutMessage(args: string[], o: OrbCallOpts, tries: number): string {
  const s = Math.round(o.timeoutMs / 1000);
  return `${ORB_TIMEOUT_TEXT} within ${s} s (orb ${verb(args)}${tries > 1 ? `, tried ${tries} times` : ""}). Retry; if it keeps happening, restart OrbStack.`;
}

/**
 * The ONE way the app runs orb. `exec` is the runner (the production one, execCommand, kills the process group on
 * timeout); `orb` the CLI path (resolveOrb). A test guards that nothing else in app/src spawns orb.
 */
export async function orbCall(exec: Exec, orb: string, args: string[], o: OrbCallOpts): Promise<OrbResult> {
  const run = () => exec(orb, args, { timeoutMs: o.timeoutMs, ...(o.env ? { env: o.env } : {}), ...(o.stdin ? { stdin: o.stdin } : {}) }) as Promise<OrbResult>;
  let r = await run();
  let tries = 1;
  if (r.timedOut && o.idempotent) { r = await run(); tries = 2; }
  if (r.timedOut) return { ...r, code: TIMED_OUT, stderr: timeoutMessage(args, o, tries), timedOut: true };
  return r;
}

/** orbCall with the production runner and the resolved CLI. */
export function orb(args: string[], o: OrbCallOpts, exec?: Exec): Promise<OrbResult> {
  return orbCall(exec ?? execBounded, resolveOrb(), args, o);
}

/** Bytes out (a tarball): the same limits, kill and retry rule, without the string round trip. */
export async function orbBytes(args: string[], o: OrbCallOpts & { fullEnv?: NodeJS.ProcessEnv }): Promise<Buffer> {
  const bin = resolveOrb();
  const run = () => runBounded(bin, args, { timeoutMs: o.timeoutMs, env: { ...(o.fullEnv ?? process.env), ...o.env }, ...(o.stdin ? { stdin: o.stdin } : {}) });
  let r = await run();
  let tries = 1;
  if (r.timedOut && o.idempotent) { r = await run(); tries = 2; }
  if (r.timedOut) throw new Error(timeoutMessage(args, o, tries));
  if (r.code !== 0) throw new Error(`orb ${verb(args)} exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout;
}

/** The production Exec: runBounded with string output. */
export const execBounded: Exec = async (cmd, args, opts) => {
  const r = await runBounded(cmd, args, { timeoutMs: opts?.timeoutMs ?? 30_000, env: opts?.env ? { ...process.env, ...opts.env } : process.env, ...(opts?.stdin ? { stdin: opts.stdin } : {}) });
  return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr, timedOut: r.timedOut };
};

/** The CLI path handed to the box scripts as ORB (they bound their own calls: box/orb.sh). */
export function orbPathForScripts(): string { return resolveOrb(); }
