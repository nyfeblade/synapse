import { execFile } from "node:child_process";

/**
 * Bug 364: fail closed. The box firewall (bots-ports: inet bots_auth_proxy and inet bots_mac_guard, bugs 117 and 362)
 * is what keeps the Bots off the Mac, the LAN and the auth proxy. If it is missing, Bot turns are refused with a clear
 * reason instead of running unguarded. Checked at start (turns wait for the first answer) and every minute after.
 * Only root can list nftables, so the host asks the root-owned `bots-ports check` through sudo (bots-ports installs
 * its own sudoers line for exactly that command).
 */
export const FIREWALL_CHECK_CMD = ["-n", "/usr/local/lib/bots/bots-ports", "check"] as const;
export const FIREWALL_MISSING = "The Bots' computer firewall isn't loaded, so Bots are paused. Restart the Bots' computer, or run Repair.";

export function sudoFirewallCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("sudo", [...FIREWALL_CHECK_CMD], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

export class BoxFirewallCheck {
  private state: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: Promise<void> | null = null;

  constructor(private d: { enabled: boolean; run(): Promise<boolean>; onChange?(ok: boolean): void; intervalMs?: number; log?(s: string): void }) {}

  /** Runs the first check and then one every interval. */
  start(): void {
    if (!this.d.enabled || this.first) return;
    this.first = this.check().then(() => undefined);
    this.timer = setInterval(() => void this.check(), this.d.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<boolean> {
    const ok = await this.d.run().catch(() => false);
    if (ok !== this.state) {
      this.state = ok;
      if (!ok) this.d.log?.("firewall: the box firewall is missing; Bot turns are refused until it is back");
      this.d.onChange?.(ok);
    }
    return ok;
  }

  /** null when turns may run; else the reason they can't. Waits for the first check (never runs unchecked). */
  async blocked(): Promise<string | null> {
    if (!this.d.enabled) return null;
    this.start();
    await this.first;
    return this.state ? null : FIREWALL_MISSING;
  }
}
