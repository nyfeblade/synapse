import type { Exec } from "./x-exec";

export interface DisplayControl {
  /** Bug #66: `account` = the owning Bot's own OS account once the box is migrated; absent = box. */
  start(index: number, token: string, account?: string): Promise<"ok" | "owned">;
  stop(index: number): Promise<void>;
  status(index: number): Promise<"running" | "stopped">;
  restartChrome(index: number): Promise<void>;
}

/** Calls the root helper from Task 2 (`bot-display`), the only way bothost can start units. */
export class SudoDisplayControl implements DisplayControl {
  constructor(private exec: Exec, private helper = "/usr/local/libexec/bot-display") {}

  private async run(args: string[], timeoutMs = 60_000) {
    return this.exec("sudo", ["-n", this.helper, ...args], { timeoutMs });
  }

  async start(index: number, token: string, account?: string): Promise<"ok" | "owned"> {
    const r = await this.run(["start", String(index), token, ...(account ? [account] : [])]);
    if (r.code === 75) return "owned";
    if (r.code !== 0) throw new Error(`bot-display start ${index}: ${r.stderr.trim()}`);
    return "ok";
  }

  async stop(index: number): Promise<void> {
    const r = await this.run(["stop", String(index)]);
    if (r.code !== 0) throw new Error(`bot-display stop ${index}: ${r.stderr.trim()}`);
  }

  async status(index: number): Promise<"running" | "stopped"> {
    const r = await this.run(["status", String(index)], 10_000);
    return r.stdout.toString("utf8").trim() === "running" ? "running" : "stopped";
  }

  async restartChrome(index: number): Promise<void> {
    await this.run(["restart-chrome", String(index)]);
  }

  /** Bug 78: a dock app (terminal, files, browser) started as the display's owner, on its accessibility bus. */
  async openApp(index: number, app: "terminal" | "files" | "browser"): Promise<void> {
    const r = await this.run(["open-app", String(index), app], 15_000);
    if (r.code !== 0) throw new Error(`bot-display open-app ${index} ${app}: ${r.stderr.trim()}`);
  }
}
