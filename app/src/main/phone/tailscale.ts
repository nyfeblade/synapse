import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * Bug 198: the Tailscale CLI, for Phone access. Only these are ever run: `status --json`,
 * `serve status --json` and `serve --help` (read-only), and the two `serve` commands that put the
 * local phone server on https://<this Mac>.<tailnet>.ts.net for the user's OWN devices. Never
 * `funnel` (the public internet), never `up` / `set` / `login` / `reset`: the user's Tailscale
 * settings are theirs, and "off" only ever removes the mapping Synapse made.
 */

/** Where the CLI lives: the Mac app's bundled binary first, then a Homebrew / standalone install. */
export const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

/**
 * SECURITY ASSUMPTION: `tailscale serve` sets `Tailscale-User-Login` itself for tailnet users and
 * DROPS any `Tailscale-User-*` header a client sent (so a phone — or another tailnet device — can't
 * claim to be the owner). The server's tailnet gate relies on it. Stripping client-sent identity
 * headers is in every serve release since 1.56; Phone access refuses to turn on below that.
 */
export const MIN_TAILSCALE_VERSION = "1.56.0";

/** `SYNAPSE_TAILSCALE_CLI` points at a stand-in CLI — only honoured in tests and FUZZ runs. */
export function findTailscale(exists: (p: string) => boolean = (p) => fs.existsSync(p), env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.SYNAPSE_TAILSCALE_CLI;
  if (own && (env.FUZZ === "1" || env.VITEST !== undefined)) return exists(own) ? own : null;
  return TAILSCALE_CANDIDATES.find((p) => exists(p)) ?? null;
}

export interface TailnetSelf {
  /** Tailscale is up and signed in. */
  running: boolean;
  /** This Mac's MagicDNS name, without the trailing dot ("example-mac.example-tailnet.ts.net"); null = none. */
  dnsName: string | null;
  /** The login this Mac is signed in with ("me@example.com"); only this user's devices may use Phone access. */
  login: string | null;
  /** The raw backend state ("Running", "NeedsLogin", "Stopped"…). */
  state: string;
  /** Tailscale's version ("1.102.3"); null = unknown. */
  version: string | null;
}

/** `tailscale status --json` → what Phone access needs. Tolerates any shape; never throws. */
export function parseStatus(json: string): TailnetSelf {
  let d: Record<string, unknown>;
  try { d = JSON.parse(json) as Record<string, unknown>; } catch { return { running: false, dnsName: null, login: null, state: "unknown", version: null }; }
  const state = typeof d.BackendState === "string" ? d.BackendState : "unknown";
  const self = (d.Self ?? {}) as Record<string, unknown>;
  const dns = typeof self.DNSName === "string" && self.DNSName ? self.DNSName.replace(/\.$/, "").toLowerCase() : null;
  const users = (d.User ?? {}) as Record<string, { LoginName?: unknown }>;
  const uid = self.UserID !== undefined ? String(self.UserID) : "";
  const loginRaw = users[uid]?.LoginName;
  const login = typeof loginRaw === "string" && loginRaw ? loginRaw : null;
  const version = typeof d.Version === "string" ? (/^\d+\.\d+\.\d+/.exec(d.Version)?.[0] ?? null) : null;
  return { running: state === "Running", dnsName: dns, login, state, version };
}

/** a ≥ b for dotted versions ("1.102.3" ≥ "1.56.0"). */
export function versionAtLeast(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0; }
  return true;
}

/** The URL a phone opens: https on the tailnet name (tailscale serve terminates TLS with a real cert). */
export function phoneUrl(dnsName: string | null): string | null {
  return dnsName ? `https://${dnsName}/` : null;
}

/**
 * Where serve sends the phone: ONLY a Unix socket in the app's own 0700 folder. There is no TCP
 * fallback (a port can be taken over by another program); a Tailscale that can't reach the socket
 * means Phone access says so and stays off.
 */
export type ServeTarget = { socket: string };

/** macOS's sun_path limit (104 bytes, with its terminator). */
export const MAX_SOCKET_PATH = 103;

export function targetString(t: ServeTarget): string {
  if (!t.socket.startsWith("/") || !t.socket.endsWith(".sock") || /[\n\r\0]/.test(t.socket) || Buffer.byteLength(t.socket) > MAX_SOCKET_PATH) throw new Error("That socket path isn't valid.");
  return `unix:${t.socket}`;
}

/** `tailscale serve --bg --https=443 unix:<socket>` — the phone server's socket, tailnet-only. */
export function serveOnArgs(t: ServeTarget): string[] {
  return ["serve", "--bg", "--https=443", targetString(t)];
}

/** `tailscale serve --https=443 off` — takes the mapping away again. */
export function serveOffArgs(): string[] {
  return ["serve", "--https=443", "off"];
}

export const SERVE_STATUS_ARGS = ["serve", "status", "--json"];
export const SERVE_HELP_ARGS = ["serve", "--help"];

/** Never run anything that could reach the public internet or change the user's Tailscale setup. */
export function assertSafeArgs(args: readonly string[]): void {
  const same = (x: readonly string[]) => x.length === args.length && x.every((v, i) => v === args[i]);
  if (same(["status", "--json"]) || same(["version"]) || same(SERVE_STATUS_ARGS) || same(SERVE_HELP_ARGS) || same(serveOffArgs())) return;
  if (args.length === 4 && args[0] === "serve" && args[1] === "--bg" && args[2] === "--https=443" && !args.some((a) => /funnel/i.test(a))) {
    const t = args[3]!;
    try {
      if (t.startsWith("unix:") && same(serveOnArgs({ socket: t.slice(5) }))) return;
    } catch { /* not a valid on command */ }
  }
  throw new Error(`Refusing to run tailscale ${args.join(" ")}`);
}

/** What `tailscale serve status --json` says about HTTPS port 443 on this Mac's name. */
export interface Serve443 {
  /** The "/" handler's proxy target on <dnsName>:443, if any. */
  root: string | null;
  /** Anything else on :443 — other paths, other kinds of handler, a TCP forward — i.e. the user's own config. */
  foreign: boolean;
  /** Funnel (public internet) is on for :443. */
  funnel: boolean;
}

export function parseServeStatus(json: string, dnsName: string): Serve443 {
  let d: Record<string, unknown>;
  try { d = JSON.parse(json || "{}") as Record<string, unknown>; } catch { return { root: null, foreign: true, funnel: false }; }
  const web = (d.Web ?? {}) as Record<string, { Handlers?: Record<string, Record<string, unknown>> }>;
  const tcp = (d.TCP ?? {}) as Record<string, Record<string, unknown>>;
  const funnelMap = (d.AllowFunnel ?? {}) as Record<string, unknown>;
  let root: string | null = null;
  let foreign = false;
  for (const [hostPort, cfg] of Object.entries(web)) {
    if (!hostPort.endsWith(":443")) continue;
    const handlers = cfg?.Handlers ?? {};
    for (const [p, h] of Object.entries(handlers)) {
      if (hostPort.toLowerCase() === `${dnsName.toLowerCase()}:443` && p === "/" && typeof h?.Proxy === "string") root = h.Proxy;
      else foreign = true;
    }
  }
  const t443 = tcp["443"];
  if (t443 && (t443.TCPForward || t443.TerminateTLS)) foreign = true;
  const funnel = Object.entries(funnelMap).some(([k, v]) => k.endsWith(":443") && v === true);
  return { root, foreign, funnel };
}

/** Is serve's "/" target exactly the socket Synapse mapped? (Only a trailing slash is forgiven.) */
export function isOurTarget(root: string | null, t: ServeTarget | string | null): boolean {
  if (!root || !t) return false;
  let want: string;
  try { want = typeof t === "string" ? t : targetString(t); } catch { return false; }
  return root.replace(/\/+$/, "") === want.replace(/\/+$/, "");
}

/**
 * Serve not enabled on the tailnet yet: the CLI prints a login.tailscale.com link and WAITS for the
 * admin to click it. The link is what the user needs; the waiting is not (the CLI is stopped).
 */
export function enableLink(output: string): string | null {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/.exec(output);
  return m ? m[0] : null;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (cli: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runCli: Runner = (cli, args, timeoutMs) => new Promise((resolve) => {
  execFile(cli, args, { timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
  });
});

export interface Tailscale {
  cli(): string | null;
  status(): Promise<TailnetSelf & { installed: boolean }>;
  /** Whether this Tailscale can serve a Unix socket (`serve --help` mentions `unix:` targets). */
  supportsUnix(): Promise<boolean>;
  /** What serve has on :443 for this Mac's name; null = couldn't tell. */
  serveStatus(dnsName: string): Promise<Serve443 | null>;
  /** Turn the tailnet mapping on. `needsEnable`: Serve / HTTPS isn't enabled for this tailnet yet (the link does it). */
  serveOn(t: ServeTarget): Promise<{ ok: boolean; needsEnable?: string; message?: string }>;
  serveOff(): Promise<{ ok: boolean; message?: string }>;
  /**
   * At quit, synchronously (bounded — the app can't wait on a promise then): off, but only if serve's
   * :443 root on `dnsName` is still exactly `mapped` AND nothing of the user's shares :443 ("shared": left
   * alone, since off would take their handlers too). "removed" / "not-ours" (nothing to do) / "shared" / "failed".
   */
  serveOffSyncIfOurs(dnsName: string, mapped: string): "removed" | "not-ours" | "shared" | "failed";
}

export type SyncRunner = (cli: string, args: string[]) => { code: number | null; stdout: string };

export function makeTailscale(o: { run?: Runner; find?: () => string | null; serveTimeoutMs?: number; runSync?: SyncRunner } = {}): Tailscale {
  const run = o.run ?? runCli;
  const find = o.find ?? (() => findTailscale());
  const exec = (args: string[], ms: number) => {
    assertSafeArgs(args);
    const cli = find();
    if (!cli) return Promise.resolve<RunResult | null>(null);
    return run(cli, args, ms);
  };
  const why = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";
  return {
    cli: find,
    async status() {
      const r = await exec(["status", "--json"], 5_000);
      if (!r) return { installed: false, running: false, dnsName: null, login: null, state: "missing", version: null };
      // A stopped Tailscale still prints JSON (BackendState "Stopped") with a non-zero exit.
      return { installed: true, ...parseStatus(r.stdout) };
    },
    async supportsUnix() {
      const r = await exec(SERVE_HELP_ARGS, 5_000);
      return !!r && /unix:\//.test(`${r.stdout}${r.stderr}`);
    },
    async serveStatus(dnsName) {
      const r = await exec(SERVE_STATUS_ARGS, 5_000);
      if (!r || r.code !== 0) return null;
      return parseServeStatus(r.stdout, dnsName);
    },
    async serveOn(t) {
      const r = await exec(serveOnArgs(t), o.serveTimeoutMs ?? 10_000);
      if (!r) return { ok: false, message: "Tailscale isn't installed on this Mac." };
      const link = enableLink(`${r.stdout}\n${r.stderr}`);
      if (link) return { ok: false, needsEnable: link };
      if (r.code === 0 && !r.timedOut) return { ok: true };
      return { ok: false, message: why(r) || "Tailscale didn't answer." };
    },
    async serveOff() {
      const r = await exec(serveOffArgs(), 10_000);
      if (!r) return { ok: false, message: "Tailscale isn't installed on this Mac." };
      // "no serve config" / "handler does not exist" = already off, which is what was asked.
      if (r.code === 0 || /not exist|no serve config|nothing to/i.test(`${r.stdout}${r.stderr}`)) return { ok: true };
      return { ok: false, message: why(r) || "Tailscale didn't answer." };
    },
    serveOffSyncIfOurs(dnsName, mapped) {
      const cli = find();
      if (!cli) return "failed";
      const sync: SyncRunner = o.runSync ?? ((c, a) => { const r = spawnSync(c, a, { timeout: 3_000, encoding: "utf8" }); return { code: r.status, stdout: String(r.stdout ?? "") }; });
      assertSafeArgs(SERVE_STATUS_ARGS);
      const st = sync(cli, SERVE_STATUS_ARGS);
      if (st.code !== 0) return "failed";
      const s443 = parseServeStatus(st.stdout, dnsName);
      if (!isOurTarget(s443.root, mapped)) return "not-ours";
      // `serve --https=443 off` takes the WHOLE port: with the user's own handlers on it too, never.
      if (s443.foreign) return "shared";
      assertSafeArgs(serveOffArgs());
      return sync(cli, serveOffArgs()).code === 0 ? "removed" : "failed";
    },
  };
}
