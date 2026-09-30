import dns from "node:dns";
import fs from "node:fs";
import net, { BlockList } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Bug 363: one guarded fetch for every host (bothost) request to a URL that a Bot, a marketplace repo or a remote
 * server chose — a Bot-added or marketplace/curated remote MCP server, its redirects and its OAuth discovery.
 * bothost is the one account the box firewall (bots_mac_guard, bug 362) lets reach the Mac and the LAN, so without this
 * a Bot could make the host fetch the Mac's private services (OrbStack forwards host.docker.internal, 0.250.250.254 and
 * the host ULA to the Mac's 127.0.0.1) or the LAN, and read the answer back in an error.
 *
 * The check runs in the connection step of an undici dispatcher, after DNS and on every redirect hop, so a name that
 * resolves (or re-resolves) to a private address is refused like the literal address. Only servers the OWNER adds in
 * the app keep private reach (RegistryServer.ownerPrivateReach, set by the addMcpServer gateway command only).
 */
export const BLOCKED_CODE = "SYNAPSE_PRIVATE_ADDRESS";

const V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network", and OrbStack's 0.250.250.x (the Mac 0.250.250.254, its DNS .200)
  ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], // RFC 1918 LAN
  ["100.64.0.0", 10], // CGNAT, Tailscale
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["192.0.0.0", 24],
  ["198.18.0.0", 15], // benchmarking, OrbStack's 198.19.249.x
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6: [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];
const BASE = new BlockList();
for (const [a, p] of V4) BASE.addSubnet(a, p, "ipv4");
for (const [a, p] of V6) BASE.addSubnet(a, p, "ipv6");

/** The box's guard config (bots-ports, bug 362/365): MAC_NETS lists the Mac's own global IPv6 prefixes and any LAN
 *  IPv4 outside RFC 1918, passed in from the Mac. Only well-formed CIDRs are taken. */
export const GUARD_CONF = process.env.SYNAPSE_NET_GUARD_CONF ?? "/etc/bots/net-guard.conf";
export function readGuardNets(file = GUARD_CONF): string[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const line = /^MAC_NETS=(.*)$/m.exec(text)?.[1] ?? "";
  return line.split(/[\s,]+/).filter((c) => {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(c);
    if (!m) return false;
    const fam = net.isIP(m[1]!);
    return fam !== 0 && Number(m[2]) <= (fam === 4 ? 32 : 128);
  });
}
let cached: { at: number; nets: string[]; list: BlockList } | null = null;
function extraList(nets?: string[]): BlockList {
  const build = (n: string[]) => { const l = new BlockList(); for (const c of n) { const [a, p] = c.split("/"); l.addSubnet(a!, Number(p), net.isIP(a!) === 4 ? "ipv4" : "ipv6"); } return l; };
  if (nets) return build(nets);
  if (!cached || Date.now() - cached.at > 30_000) { const n = readGuardNets(); cached = { at: Date.now(), nets: n, list: build(n) }; }
  return cached.list;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1) is checked as the IPv4 address it carries. */
function unmap(ip: string): string {
  const m = /^::ffff:(?:0:)?(.+)$/i.exec(ip);
  if (!m) return ip;
  if (net.isIPv4(m[1]!)) return m[1]!;
  const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]!);
  if (!h) return ip;
  const a = parseInt(h[1]!, 16), b = parseInt(h[2]!, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** True for any address a guarded fetch may not connect to (and for anything that isn't an address). */
export function blockedAddress(ip: string, extraNets?: string[]): boolean {
  const a = unmap(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  const fam = net.isIP(a);
  if (fam === 0) return true;
  const t = fam === 4 ? "ipv4" : "ipv6";
  return BASE.check(a, t) || extraList(extraNets).check(a, t);
}

const blockedError = (host: string) => Object.assign(new Error(`Refused: ${host} is a private address (the Mac, loopback or the local network).`), { code: BLOCKED_CODE });

/** An undici dispatcher whose every connection (every hop, after DNS) refuses blocked addresses. */
export function guardedDispatcher(o: { isBlocked?: (ip: string) => boolean } = {}): Agent {
  const isBlocked = o.isBlocked ?? ((ip: string) => blockedAddress(ip));
  const lookup = ((host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as dns.LookupAddress[];
      if (!list.length || list.some((x) => isBlocked(x.address))) return cb(blockedError(host));
      if (opts.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as net.LookupFunction;
  const base = buildConnector({ lookup } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (opts, cb) => {
    const h = opts.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(h) && isBlocked(h)) { cb(blockedError(h), null); return; }
    return base(opts, cb);
  };
  return new Agent({ connect });
}

/** The guarded fetch (http/https only), shaped as the MCP SDK's FetchLike. */
export function guardedFetch(o: { isBlocked?: (ip: string) => boolean } = {}): FetchLike {
  const dispatcher = guardedDispatcher(o);
  return async (url, init) => {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError(`Only http and https URLs can be fetched (${u.protocol}).`);
    return (await undiciFetch(u, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  };
}

/** The host's one shared guarded fetch. */
let shared: FetchLike | null = null;
export function hostGuardedFetch(): FetchLike { return (shared ??= guardedFetch()); }
