import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { log } from "../util/log";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Optional public webhook URL (RTN-11 ADAPTED): a cloudflared quick tunnel to the local listener. */
export class WebhookTunnel {
  private child: ChildProcess | null = null;
  private url: string | null = null;

  constructor(private d: { spawn?: typeof nodeSpawn; port: number; onUrl(url: string | null): void; bin?: string }) {}

  start(): void {
    if (this.child) return;
    const child = (this.d.spawn ?? nodeSpawn)(this.d.bin ?? "cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.d.port}`], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const scan = (b: Buffer) => {
      const m = URL_RE.exec(b.toString());
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.d.onUrl(this.url);
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      log.info("webhook tunnel stopped", { why });
      this.d.onUrl(null);
    };
    child.on("exit", () => gone("exit"));
    child.on("error", (e) => gone(String(e)));
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }
}
