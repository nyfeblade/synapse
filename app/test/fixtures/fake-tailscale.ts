import http from "node:http";
import { makeTailscale, type RunResult, type Tailscale } from "../../src/main/phone/tailscale";
import type { PhoneServer } from "../../src/main/phone/server";

/**
 * Bug 198: a stand-in for the Tailscale CLI that keeps a serve config the way tailscaled does, so
 * the wiring's on / off / verify logic can be tested without ever running the real one. Every
 * command still goes through makeTailscale (and its assertSafeArgs guard) and is recorded.
 */
export class FakeTailscale {
  cli: string[][] = [];
  version = "1.102.3";
  unix = true;
  running = true;
  /** The "/" proxy target on <dns>:443 (null = nothing). */
  root: string | null = null;
  /** The user's own :443 config (another path) and Funnel. */
  foreign = false;
  funnel = false;
  onResult: "ok" | "needs-enable" | "fail" = "ok";
  offResult: "ok" | "fail" = "ok";
  syncOffs = 0;
  offDelayMs = 0;
  constructor(public dns: string, public login: string) {}

  private statusJson(): string {
    return JSON.stringify({ Version: `${this.version}-tabc`, BackendState: this.running ? "Running" : "Stopped", Self: { DNSName: `${this.dns}.`, UserID: 1 }, User: { "1": { LoginName: this.login } } });
  }

  private serveJson(): string {
    const handlers: Record<string, unknown> = {};
    if (this.root) handlers["/"] = { Proxy: this.root };
    if (this.foreign) handlers["/grafana"] = { Proxy: "http://127.0.0.1:3000" };
    const web = Object.keys(handlers).length ? { [`${this.dns}:443`]: { Handlers: handlers } } : {};
    return JSON.stringify({ ...(Object.keys(web).length ? { TCP: { "443": { HTTPS: true } }, Web: web } : {}), ...(this.funnel ? { AllowFunnel: { [`${this.dns}:443`]: true } } : {}) });
  }

  run = async (_cli: string, args: string[]): Promise<RunResult> => {
    this.cli.push(args);
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    const a = args.join(" ");
    if (a === "status --json") return ok(this.statusJson());
    if (a === "serve status --json") return ok(this.serveJson());
    if (a === "serve --help") return ok(this.unix ? "On Unix-like systems, you can also specify a Unix domain socket (e.g., unix:/tmp/myservice.sock)." : "USAGE\n  tailscale serve <target>");
    if (a === "serve --https=443 off") {
      if (this.offResult === "fail") return { code: 1, stdout: "", stderr: "error: backend unavailable", timedOut: false };
      this.root = null;
      // A slow CLI: the off has happened, the answer comes later (races with a bring-up).
      if (this.offDelayMs) await new Promise((r) => setTimeout(r, this.offDelayMs));
      return ok();
    }
    if (args[0] === "serve" && args[1] === "--bg") {
      if (this.onResult === "needs-enable") return { code: null, stdout: "To enable, visit:\n  https://login.tailscale.com/f/serve?node=n1\n", stderr: "", timedOut: true };
      if (this.onResult === "fail") return { code: 1, stdout: "", stderr: "error: something broke", timedOut: false };
      this.root = args[3]!;
      return ok();
    }
    return { code: 1, stdout: "", stderr: "unexpected", timedOut: false };
  };

  /** No Tailscale CLI on this Mac (find() answers null). */
  missing = false;

  tailscale(): Tailscale {
    return makeTailscale({
      find: () => (this.missing ? null : "/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
      run: this.run,
      runSync: (_c, a) => {
        this.cli.push(a);
        if (a.join(" ") === "serve status --json") return { code: 0, stdout: this.serveJson() };
        this.syncOffs++;
        if (this.offResult === "fail") return { code: 1, stdout: "" };
        this.root = null;
        return { code: 0, stdout: "" };
      },
    });
  }
}

/** What serve does for the wiring's probe: a request to the mapped target, with the owner's identity. */
export function probeThrough(fake: FakeTailscale, server: () => PhoneServer): (url: string) => Promise<string | null> {
  return (url) => new Promise((resolve) => {
    const s = server();
    const root = fake.root;
    if (!root) return resolve(null);
    const u = new URL(url);
    if (!root.startsWith("unix:")) return resolve(null);
    // agent: false — a pooled keep-alive connection could still point at an earlier listener.
    const opts: http.RequestOptions = { socketPath: root.slice(5), agent: false };
    const r = http.request({ ...opts, path: u.pathname, headers: { host: u.host, "tailscale-user-login": fake.login } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve((JSON.parse(b) as { probe?: string }).probe ?? null); } catch { resolve(null); } });
    });
    r.on("error", () => resolve(null));
    r.end();
    void s;
  });
}

/** A test stand-in for safeStorage (never the real keychain). */
export const fakeSeal = { encrypt: (s: string) => Buffer.from(`sealed:${s}`), decrypt: (b: Buffer) => b.toString().replace(/^sealed:/, "") };
