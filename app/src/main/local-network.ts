/**
 * 0.1.4 Settings → Computer → Local network (off by default). On, box and the Bot accounts may reach the owner's
 * local network (RFC 1918 and ULA); the Mac itself stays blocked either way (box/files/bots-ports, docs/decisions.md).
 *
 * Owner only: this runs from the app's main process, as root in the box through OrbStack — the same path the Mac's
 * networks take (`bots-ports mac-nets`). The host (bothost) has no sudoers line for it and no gateway command reaches
 * it, so no Bot, tool, MCP server or approval can flip it. The box's loaded firewall is the truth: `get` reads it, and
 * a failed `set` answers with whatever is loaded (off when turning on failed: bots-ports goes back to blocking).
 *
 * The owner's choice is also kept in app-settings.json (`localNetwork`), so an Update or Reset, which recreates the
 * box with the default (blocked) config, gets it back at the next connect (`reconcile`).
 */
export const PORTS_SCRIPT = "/usr/local/lib/bots/bots-ports";

export interface LocalNetworkDeps {
  /** Runs bots-ports as root in the box: `orb -m <box> -u root /usr/local/lib/bots/bots-ports ...args`. */
  run(args: string[]): Promise<{ code: number; stdout: string }>;
  wanted(): boolean;
  setWanted(on: boolean): void;
  log?(line: string): void;
}

function parse(stdout: string): boolean | null {
  const last = stdout.trim().split("\n").pop()?.trim();
  return last === "on" ? true : last === "off" ? false : null;
}

export class LocalNetwork {
  private busy: Promise<unknown> = Promise.resolve();
  /** Tells the host to hold (true) or let Bot turns run (false); rebound at every connect. null = no host yet. */
  private pauseHost: ((on: boolean) => Promise<void>) | null = null;
  /** The host last confirmed a pause from this check. */
  private paused = false;
  constructor(private d: LocalNetworkDeps) {}

  setPauseHost(fn: ((on: boolean) => Promise<void>) | null): void { this.pauseHost = fn; if (fn && this.paused) void fn(true).catch(() => {}); }

  /**
   * 0.1.4 tamper check, on every Mac-networks watcher tick: the box's loaded Local network state AND net-guard.conf
   * must both equal the owner's choice (app-settings.json). On a mismatch the host pauses Bot turns (with a tray),
   * the owner's choice is applied again (fail closed: a failed "on" leaves it off and remembered off), and the pause
   * lifts once both match. A box that can't be asked changes nothing (no Bot runs there either).
   */
  verify(): Promise<"ok" | "fixed" | "mismatch" | "unknown"> {
    const next = this.busy.then(() => this.check());
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async state(): Promise<{ loaded: boolean; conf: boolean } | null> {
    const r = await this.d.run(["local-network", "state"]).catch(() => null);
    const m = r && r.code === 0 ? /^(on|off) (on|off)$/m.exec(r.stdout.trim()) : null;
    return m ? { loaded: m[1] === "on", conf: m[2] === "on" } : null;
  }

  private async setPause(on: boolean): Promise<void> {
    if (!this.pauseHost) return;
    try { await this.pauseHost(on); this.paused = on; } catch { /* host unreachable: retried next tick */ }
  }

  private async check(): Promise<"ok" | "fixed" | "mismatch" | "unknown"> {
    const want = this.d.wanted();
    const st = await this.state();
    if (!st) return "unknown";
    if (st.loaded === want && st.conf === want) { if (this.paused) await this.setPause(false); return "ok"; }
    this.d.log?.(`local-network: the Bots' computer says loaded=${st.loaded ? "on" : "off"} config=${st.conf ? "on" : "off"}, the owner chose ${want ? "on" : "off"}; pausing Bots and applying the owner's choice`);
    await this.setPause(true);
    await this.apply(want).catch(() => null);
    const after = await this.state();
    const target = this.d.wanted(); // a failed "on" is remembered as off (fail closed)
    if (after && after.loaded === target && after.conf === target) { await this.setPause(false); return "fixed"; }
    return "mismatch";
  }

  /** What the box's loaded firewall does now. Throws when the box can't be asked. */
  async get(): Promise<{ on: boolean }> {
    const r = await this.d.run(["local-network", "status"]);
    const on = parse(r.stdout);
    if (r.code !== 0 || on === null) throw new Error("Couldn't read the Bots' computer's network setting.");
    return { on };
  }

  /** Applies it live and answers with what is loaded afterwards (fail closed: a failed "on" reads back off). */
  set(on: boolean): Promise<{ on: boolean }> {
    const next = this.busy.then(() => this.apply(on));
    this.busy = next.catch(() => undefined);
    return next;
  }

  /** At every connect: an Update or Reset recreated the box with the LAN blocked; put the owner's choice back. */
  async reconcile(): Promise<void> {
    const want = this.d.wanted();
    const now = await this.get().catch(() => null);
    if (!now || now.on === want) return;
    const got = await this.set(want).catch(() => null);
    if (got?.on !== want) this.d.log?.(`local-network: couldn't ${want ? "reopen" : "close"} the local network for the Bots; it stays ${got?.on ? "on" : "off"}`);
  }

  private async apply(on: boolean): Promise<{ on: boolean }> {
    const r = await this.d.run(["local-network", on ? "on" : "off"]).catch(() => ({ code: 1, stdout: "" }));
    let now = parse(r.stdout);
    if (r.code !== 0 || now === null) now = (await this.get()).on;
    // The owner's choice is kept only when it took; a failed "on" is remembered as off (it never reopens by itself).
    this.d.setWanted(on ? now : false);
    return { on: now };
  }
}
