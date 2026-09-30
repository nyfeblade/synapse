import { ACP_PROTOCOL_VERSION, ACP_VENDORS, acpVendorLink, type AcpLoginStart, type AcpVendorId } from "@synapse/shared";
import { JsonRpcPeer, RPC, RpcError } from "./jsonrpc";
import { AcpNotAvailable, type AcpProcess, type AcpSpawn } from "./spawn";

/**
 * "Sign in with <vendor>" (Wave 3). The vendor's own documented sign-in runs AS the Bot (bot-acp-as-box, mode login),
 * so its token lands in the Bot's own home. Synapse only watches the command's output for the sign-in link (on the
 * vendor's own hosts) and the one-time code, shows those to the user, and lets the command finish by itself. The
 * output is never stored or logged, and nothing reads the token: whether the Bot is signed in is asked of the vendor
 * CLI itself (an ACP session/new that either works or says "authentication required").
 */
const OUTPUT_CAP = 64 * 1024;
const LINK_WAIT_MS = 30_000;
const LOGIN_MAX_MS = 15 * 60_000;
const CODE_RE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;

export const vendorLink = acpVendorLink;

export class AcpLogins {
  private running = new Map<string, { proc: AcpProcess; timer: NodeJS.Timeout }>();
  constructor(private d: { spawn: AcpSpawn; cwd(botId: string): string; log?: (m: string, f?: Record<string, unknown>) => void }) {}

  async start(botId: string, vendor: AcpVendorId): Promise<AcpLoginStart> {
    const v = ACP_VENDORS[vendor];
    if (v.loginFlow === "terminal") return { kind: "terminal", command: [v.loginBin ?? v.bin, ...v.loginArgs].join(" ") };
    const key = `${botId}:${vendor}`;
    this.stop(key);
    let proc: AcpProcess;
    try { proc = this.d.spawn({ botId, vendor, mode: "login" }); } catch (e) {
      return { kind: "failed", detail: e instanceof AcpNotAvailable ? e.message : "The sign-in couldn't start." };
    }
    const timer = setTimeout(() => this.stop(key), LOGIN_MAX_MS);
    timer.unref?.();
    this.running.set(key, { proc, timer });
    proc.stdin.end(); // nothing is typed into a vendor's sign-in
    return new Promise<AcpLoginStart>((resolve) => {
      let out = "";
      let settled = false;
      let codeWait: NodeJS.Timeout | null = null;
      const finish = (r: AcpLoginStart) => { if (settled) return; settled = true; if (codeWait) clearTimeout(codeWait); clearTimeout(linkTimer); resolve(r); };
      const look = () => {
        const url = vendorLink(out, v.loginHosts);
        if (!url) return;
        const code = CODE_RE.exec(out)?.[0] ?? null;
        if (code) finish({ kind: "link", url, code });
        else if (!codeWait) codeWait = setTimeout(() => finish({ kind: "link", url, code: CODE_RE.exec(out)?.[0] ?? null }), 500);
      };
      const onData = (c: Buffer | string) => { if (out.length < OUTPUT_CAP) out += c.toString(); look(); };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.onError(() => finish({ kind: "failed", detail: `${v.label} isn't installed on the computer yet.` }));
      proc.onExit((code) => {
        if (this.running.get(key)?.proc === proc) { clearTimeout(this.running.get(key)!.timer); this.running.delete(key); }
        finish(code === 0 ? { kind: "failed", detail: "Already signed in." } : { kind: "failed", detail: "The sign-in stopped before it showed a link." });
      });
      const linkTimer = setTimeout(() => { finish({ kind: "failed", detail: "The sign-in didn't show a link." }); this.stop(key); }, LINK_WAIT_MS);
      linkTimer.unref?.();
    });
  }

  /** Asks the vendor CLI, as the Bot, to open a session: it works (signed in) or says authentication is required. */
  async check(botId: string, vendor: AcpVendorId, timeoutMs = 30_000): Promise<{ signedIn: boolean; detail: string }> {
    let proc: AcpProcess;
    try { proc = this.d.spawn({ botId, vendor, mode: "acp" }); } catch (e) {
      return { signedIn: false, detail: e instanceof AcpNotAvailable ? e.message : "The check couldn't start." };
    }
    const peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
      request: async () => { throw new RpcError(RPC.methodNotFound, "Method not found"); },
      notification: () => {},
    });
    proc.stderr.resume();
    const failed = new Promise<never>((_, rej) => proc.onError(rej));
    failed.catch(() => {});
    try {
      await Promise.race([peer.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "synapse", version: "1" } }, timeoutMs), failed]);
      await peer.request("session/new", { cwd: this.d.cwd(botId), mcpServers: [] }, timeoutMs);
      return { signedIn: true, detail: "" };
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC.authRequired) return { signedIn: false, detail: "" };
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { signedIn: false, detail: `${ACP_VENDORS[vendor].label} isn't installed on the computer yet.` };
      this.d.log?.("acp login check failed", { botId, vendor, error: String(e).slice(0, 200) });
      return { signedIn: false, detail: "The check didn't finish." };
    } finally {
      peer.close();
      proc.stdin.end();
      proc.kill("SIGTERM");
    }
  }

  private stop(key: string): void {
    const r = this.running.get(key);
    if (!r) return;
    clearTimeout(r.timer);
    r.proc.kill("SIGTERM");
    this.running.delete(key);
  }

  dispose(): void {
    for (const k of [...this.running.keys()]) this.stop(k);
  }
}
