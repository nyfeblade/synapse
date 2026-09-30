import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ACP_INSTALL_PINS, ACP_VENDORS, STR_ACP, scrubClaudeLogin, type AcpInstallView, type AcpVendorId } from "@synapse/shared";

/**
 * 0.1.6: the owner's Install / Remove of a vendor coding CLI (Settings → Account → Coding CLIs). On the box it is only
 * ever `sudo -n bot-acp-install <vendor> <install|remove>`: the root helper installs the version pinned in
 * box/files/acp-pins/<vendor> (every package checked against npm's published sha512) as root, where bot-acp-as-box
 * looks. The host passes the vendor id and the verb, nothing else. Only the gateway command reaches this (the gateway
 * token is the app's alone), and no Bot account may sudo the helper.
 *
 * It runs in the background (an npm install takes a while); the view says Installing… until it ends. Whether a CLI is
 * installed is read from the install itself (its `.installed.json` and launcher), so a restart loses nothing.
 */
export const ACP_INSTALL_HELPER = "/usr/local/libexec/bot-acp-install";
const INSTALL_MAX_MS = 15 * 60_000;

export type AcpInstallVerb = "install" | "remove";
/** Runs one install or remove to the end; rejects with a message fit to show. */
export type AcpInstallRunner = (vendor: AcpVendorId, verb: AcpInstallVerb) => Promise<void>;

/** The helper's own last "bot-acp-install: …" line (its words, not npm's output), else a plain failure. */
export function helperReason(stderr: string, vendor: AcpVendorId): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("bot-acp-install: "));
  const last = lines.at(-1)?.slice("bot-acp-install: ".length).replace(/[^\x20-\x7e]/g, "").slice(0, 200);
  return last ? `${STR_ACP.installFailed(vendor)} ${last.charAt(0).toUpperCase()}${last.slice(1)}.` : STR_ACP.installFailed(vendor);
}

/** The box: the root helper through sudo, with an empty environment. */
export function sudoAcpInstall(): AcpInstallRunner {
  return (vendor, verb) => new Promise((resolve, reject) => {
    execFile("sudo", ["-n", ACP_INSTALL_HELPER, vendor, verb], { env: scrubClaudeLogin({ PATH: "/usr/bin:/bin" }), timeout: INSTALL_MAX_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, _out, stderr) => (err ? reject(new Error(helperReason(String(stderr ?? ""), vendor))) : resolve()));
  });
}

/**
 * FUZZ runs and the UI e2e: no box, so a stand-in writes what the helper would (a launcher and `.installed.json`) under
 * the run's own folder. Never used with the real brain.
 */
export function simulatedAcpInstall(root: string, delayMs = 300): AcpInstallRunner {
  return async (vendor, verb) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const dir = path.join(root, vendor);
    if (verb === "remove") { fs.rmSync(dir, { recursive: true, force: true }); return; }
    const pin = ACP_INSTALL_PINS[vendor];
    if (!pin) throw new Error(STR_ACP.installFailed(vendor));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ACP_VENDORS[vendor].bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, ".installed.json"), JSON.stringify({ vendor, package: pin.package, version: pin.version }));
  };
}

export class AcpInstaller {
  private jobs = new Map<AcpVendorId, { verb: AcpInstallVerb; done: Promise<void> }>();
  private errors = new Map<AcpVendorId, string>();
  constructor(private d: {
    /** Where the vendor CLIs live (ACP_VENDOR_ROOT on the box). */
    root: string;
    /** null: this host can't install (no box). */
    run: AcpInstallRunner | null;
    /** Per-Bot accounts: without them a vendor CLI can't run, so Install isn't offered. */
    accountsReady(): boolean;
    log?: (m: string, f?: Record<string, unknown>) => void;
  }) {}

  /** The installed version (null when the launcher is there but not from Install), or undefined when not installed. */
  installed(v: AcpVendorId): string | null | undefined {
    const dir = path.join(this.d.root, v);
    try {
      const st = fs.lstatSync(path.join(dir, ACP_VENDORS[v].bin));
      if (!st.isFile()) return undefined;
    } catch { return undefined; }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, ".installed.json"), "utf8")) as { version?: unknown };
      return typeof j.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(j.version) ? j.version : null;
    } catch { return null; }
  }

  accountsNeeded(): boolean { return this.d.run !== null && !this.d.accountsReady(); }

  view(v: AcpVendorId): AcpInstallView {
    const pin = ACP_INSTALL_PINS[v];
    const job = this.jobs.get(v);
    const base = { pinned: pin?.version ?? null, package: pin?.package ?? null, error: this.errors.get(v) ?? null };
    if (job) return { ...base, state: job.verb === "install" ? "installing" : "removing", version: null };
    const have = this.installed(v);
    if (have !== undefined) return { ...base, state: "installed", version: have };
    if (!this.d.run || !pin) return { ...base, state: "unavailable", version: null };
    return { ...base, state: "not-installed", version: null };
  }

  /** Starts an install or remove in the background; throws a message fit to show when it can't start. */
  start(v: AcpVendorId, verb: AcpInstallVerb): void {
    const run = this.d.run;
    if (!run) throw new Error(STR_ACP.offBox);
    if (this.jobs.has(v)) return; // already on its way
    if (verb === "install") {
      if (!ACP_INSTALL_PINS[v]) throw new Error(STR_ACP.noVerifiedPackage);
      if (!this.d.accountsReady()) throw new Error(STR_ACP.accounts);
    }
    this.errors.delete(v);
    const done = run(v, verb).then(
      () => { this.d.log?.(`coding CLI ${verb}ed`, { vendor: v }); },
      (e: unknown) => { const msg = e instanceof Error ? e.message : String(e); this.errors.set(v, msg); this.d.log?.(`coding CLI ${verb} failed`, { vendor: v, error: msg }); },
    ).finally(() => { this.jobs.delete(v); });
    this.jobs.set(v, { verb, done });
  }

  /** Tests: waits for a vendor's running job. */
  async settled(v: AcpVendorId): Promise<void> { await this.jobs.get(v)?.done; }
}
