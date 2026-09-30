import os from "node:os";
import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Bug 365: the Mac's own networks the box firewall must also keep the Bots off. The fixed ranges (RFC 1918, CGNAT,
 * link-local, ULA, OrbStack's) already cover most LANs; what they miss is the Mac's global IPv6 prefixes (the Mac and
 * its LAN neighbours answer there) and a LAN IPv4 outside RFC 1918. Passed to the box at deploy (SYNAPSE_MAC_NETS)
 * and again whenever the Mac's networks change (`bots-ports mac-nets LIST`).
 */
const COVERED = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) COVERED.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) COVERED.addSubnet(a, p, "ipv6");

function v4Network(addr: string, prefix: number): string {
  const n = addr.split(".").reduce((x, o) => (x << 8) | Number(o), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const m = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (m >>> s) & 255).join(".")}/${prefix}`;
}
function v6Network(addr: string, prefix: number): string {
  const [h, t = ""] = addr.split("::");
  const hs = h ? h.split(":") : [];
  const ts = t ? t.split(":") : [];
  const groups = addr.includes("::") ? [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts] : hs;
  let bits = groups.map((g) => parseInt(g, 16).toString(2).padStart(16, "0")).join("");
  bits = bits.slice(0, prefix).padEnd(128, "0");
  const out = Array.from({ length: 8 }, (_, i) => parseInt(bits.slice(i * 16, i * 16 + 16), 2).toString(16));
  // Compress the longest run of zero groups, like the box's python normalisation.
  let best = [-1, 0], cur = [-1, 0];
  out.forEach((g, i) => { if (g === "0") { cur = cur[0] === -1 ? [i, 1] : [cur[0]!, cur[1]! + 1]; if (cur[1]! > best[1]!) best = [...cur]; } else cur = [-1, 0]; });
  const s = best[1]! >= 2 ? `${out.slice(0, best[0]).join(":")}::${out.slice(best[0]! + best[1]!).join(":")}` : out.join(":");
  return `${s}/${prefix}`;
}

/**
 * The Mac's networks the fixed ranges don't cover, plus (0.1.4, Local network) every address of the Mac's own as a
 * /32 or /128, as normalized CIDRs, sorted. The fixed ranges stop covering the Mac's RFC 1918 and ULA addresses when
 * the owner lets the Bots reach the local network, so the box denies the Mac's own addresses by name in every state.
 * Bug 368: shorter prefixes than these are dropped (and logged), so a misread netmask never blocks a huge range; the
 * address itself is still denied.
 */
export const MIN_PREFIX = { v4: 16, v6: 32 } as const;

export function macGuardNets(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(), log: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) for (const i of list ?? []) {
    if (i.internal || !i.cidr) continue;
    const prefix = Number(i.cidr.split("/")[1]);
    const addr = i.address.replace(/%.*$/, "");
    const fam = isIPv4(addr) ? 4 : isIPv6(addr) ? 6 : 0;
    if (!fam || (fam === 4 ? addr.startsWith("127.") : addr === "::1")) continue;
    out.add(fam === 4 ? `${addr}/32` : v6Network(addr, 128));
    const v4 = fam === 4 && !COVERED.check(addr, "ipv4");
    const v6 = fam === 6 && !COVERED.check(addr, "ipv6");
    if (!v4 && !v6) continue;
    if (!Number.isInteger(prefix) || prefix < (v4 ? MIN_PREFIX.v4 : MIN_PREFIX.v6) || prefix > (v4 ? 32 : 128)) {
      log(`mac-nets: skipping ${addr}/${i.cidr.split("/")[1]} (prefix too short to block safely)`);
      continue;
    }
    out.add(v4 ? v4Network(addr, prefix) : v6Network(addr, prefix));
  }
  return [...out].sort();
}

export function macNetsEnv(nets = macGuardNets()): { SYNAPSE_MAC_NETS: string } {
  return { SYNAPSE_MAC_NETS: nets.join(" ") };
}

/**
 * Watches the Mac's networks (macOS has no change event in Electron's main process, so it compares a cheap
 * in-process snapshot every pollMs) and, after they settle for debounceMs, sends the new list to the box. A failed send
 * (box stopped) is retried at the next poll.
 */
export class MacNetsWatcher {
  private applied: string | null = null;
  private pending: string | null = null;
  private since = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private ticking = false;

  constructor(private d: { apply(nets: string[]): Promise<boolean>; nets?: () => string[]; now?: () => number; pollMs?: number; debounceMs?: number; log?(s: string): void; /** 0.1.4: runs on every tick (the Local network tamper check). */ everyTick?(): Promise<unknown> }) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.busy || this.ticking) return;
    this.ticking = true;
    try { await this.nets(); } finally { try { await this.d.everyTick?.().catch(() => undefined); } finally { this.ticking = false; } }
  }

  private async nets(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    const nets = (this.d.nets ?? macGuardNets)();
    const key = nets.join(" ");
    if (key === this.applied) { this.pending = null; return; }
    if (key !== this.pending) { this.pending = key; this.since = now; if (this.applied !== null) return; } // first run applies at once
    if (this.applied !== null && now - this.since < (this.d.debounceMs ?? 5_000)) return;
    this.busy = true;
    try {
      if (await this.d.apply(nets).catch(() => false)) { this.applied = key; this.pending = null; }
      else this.d.log?.("mac-nets: the Bots' computer didn't take the new network list; retrying at the next check");
    } finally { this.busy = false; }
  }
}
