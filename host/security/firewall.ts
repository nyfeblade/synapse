import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net, { BlockList } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The box firewall without a VM: the real `box/files/bots-ports` renders the Mac guard into a temp root (with a fake
 * `nft` that loads nothing and a fake `getent` that answers like OrbStack), and a small evaluator walks the rendered
 * nftables rules for one new outgoing connection. The shipped auth-proxy rule is evaluated as it is.
 *
 * The evaluator knows only the rule shapes these two files use; a rule it can't read throws, so a new rule shape
 * fails the suite instead of being skipped. It is a model of nftables, not nftables: the box's own test
 * (verify-box.sh) is what proves the loaded rules on a real kernel.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const BOX_DIR = path.resolve(here, "../../box");

export interface Packet { uid: number; user?: string; daddr: string; proto: "tcp" | "udp"; dport: number }
export type FwVerdict = { verdict: "accept" | "reject"; rule: string };

interface Ruleset { sets: Map<string, BlockList>; chains: Map<string, string[]> }

function listOf(addrs: string[]): BlockList {
  const l = new BlockList();
  for (const a of addrs) {
    const [ip, p] = a.split("/") as [string, string | undefined];
    const fam = net.isIP(ip);
    if (!fam) throw new Error(`firewall model: not an address: ${a}`);
    const t = fam === 4 ? "ipv4" : "ipv6";
    if (p === undefined) l.addAddress(ip, t);
    else l.addSubnet(ip, Number(p), t);
  }
  return l;
}

export function parseRuleset(text: string): Ruleset {
  const sets = new Map<string, BlockList>();
  for (const m of text.matchAll(/^\s*set (\w+) \{([^\n]*)\}\s*$/gm)) {
    const els = /elements = \{([^}]*)\}/.exec(m[2]!)?.[1] ?? "";
    sets.set(m[1]!, listOf(els.split(",").map((s) => s.trim()).filter(Boolean)));
  }
  const chains = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const open = /^chain (\w+) \{$/.exec(line);
    if (open) { cur = []; chains.set(open[1]!, cur); continue; }
    if (!cur) continue;
    if (line === "}") { cur = null; continue; }
    if (!line || line.startsWith("#") || line.startsWith("type filter")) continue;
    cur.push(line);
  }
  return { sets, chains };
}

const LOCAL = listOf(["127.0.0.0/8", "::1/128"]);
const fam = (ip: string) => (net.isIP(ip) === 4 ? "ipv4" : "ipv6");

function inAddr(rs: Ruleset, spec: string, ip: string): boolean {
  if (spec.startsWith("@")) {
    const s = rs.sets.get(spec.slice(1));
    if (!s) throw new Error(`firewall model: unknown set ${spec}`);
    return s.check(ip, fam(ip));
  }
  return listOf([spec]).check(ip, fam(ip));
}
const nums = (spec: string) => spec.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
function uidMatch(spec: string, p: Packet): boolean {
  return nums(spec).some((x) => {
    const q = /^"(\w+)"$/.exec(x);
    if (q) return q[1] === p.user;
    const r = /^(\d+)-(\d+)$/.exec(x);
    if (r) return p.uid >= Number(r[1]) && p.uid <= Number(r[2]);
    if (/^\d+$/.test(x)) return p.uid === Number(x);
    throw new Error(`firewall model: can't read skuid ${x}`);
  });
}

/** Does every condition in the rule hold for this packet? Returns the rule's action when it does. */
function ruleAction(rs: Ruleset, rule: string, p: Packet): string | null {
  let rest = rule;
  const take = (re: RegExp): RegExpExecArray | null => { const m = re.exec(rest); if (m) rest = rest.replace(m[0], " "); return m; };
  if (take(/\bct state [\w,]+( ct direction \w+)?/)) return null; // a new connection is never established/related
  const v4 = take(/\bip daddr (\S+)/);
  if (v4 && (net.isIP(p.daddr) !== 4 || !inAddr(rs, v4[1]!, p.daddr))) return null;
  const v6 = take(/\bip6 daddr (\S+)/);
  if (v6 && (net.isIP(p.daddr) !== 6 || !inAddr(rs, v6[1]!, p.daddr))) return null;
  const l4 = take(/\bmeta l4proto (\{[^}]*\}|\w+)/);
  if (l4 && !nums(l4[1]!).includes(p.proto)) return null;
  const tcp = take(/\btcp dport (\{[^}]*\}|\d+)/);
  if (tcp && (p.proto !== "tcp" || !nums(tcp[1]!).map(Number).includes(p.dport))) return null;
  const th = take(/\bth dport (\d+)/);
  if (th && p.dport !== Number(th[1])) return null;
  const uid = take(/\bmeta skuid (\{[^}]*\}|"\w+"|\d+-\d+|\d+)/);
  if (uid && !uidMatch(uid[1]!, p)) return null;
  if (take(/\bfib daddr type local/) && !LOCAL.check(p.daddr, fam(p.daddr))) return null;
  take(/\bcounter\b/);
  const action = rest.replace(/\s+/g, " ").trim();
  if (!/^(accept|goto \w+|reject( with .+)?)$/.test(action)) throw new Error(`firewall model: can't read rule "${rule}"`);
  return action;
}

/** One new outgoing connection through the ruleset's `output` chain (policy accept, as both files declare). */
export function evaluate(rs: Ruleset, p: Packet): FwVerdict {
  let chain = "output";
  for (let hops = 0; hops < 8; hops++) {
    const rules = rs.chains.get(chain);
    if (!rules) throw new Error(`firewall model: no chain ${chain}`);
    let jumped = false;
    for (const rule of rules) {
      const a = ruleAction(rs, rule, p);
      if (!a) continue;
      if (a === "accept") return { verdict: "accept", rule };
      if (a.startsWith("reject")) return { verdict: "reject", rule };
      chain = a.slice(5);
      jumped = true;
      break;
    }
    if (!jumped) return { verdict: "accept", rule: "(chain policy: accept)" };
  }
  throw new Error("firewall model: too many jumps");
}

/** Renders the Mac guard with the real bots-ports script into a temp root, as a box on OrbStack would. */
export function renderMacGuard(o: { lanOpen?: boolean } = {}): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "sec-fw-"));
  try {
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(BOX_DIR, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    fs.writeFileSync(path.join(r, "etc/resolv.conf"), "nameserver 0.250.250.200\n");
    if (o.lanOpen) fs.writeFileSync(path.join(r, "etc/bots/net-guard.conf"), "LAN_BLOCK=off\n");
    const getent = path.join(r, "getent");
    fs.writeFileSync(getent, `#!/bin/sh\ncase "$2" in\n  host.orb.internal) echo "fd07:b51a:cc66:f0::fe STREAM x"; echo "0.250.250.254 STREAM x" ;;\n  host.docker.internal) echo "0.250.250.254 STREAM x" ;;\n  host.internal) echo "fd07:b51a:cc66:f0::fe STREAM x" ;;\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
    const res = spawnSync("bash", [path.join(BOX_DIR, "files/bots-ports"), "load"], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", R: r, GETENT: getent, VISUDO: "true", SYSTEMCTL: "true", NFT: "true", IP: "false" },
    });
    if (res.status !== 0) throw new Error(`bots-ports load failed: ${res.stderr}`);
    return fs.readFileSync(path.join(r, "etc/bots/mac-guard.nft"), "utf8");
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
}

export const authProxyRules = (): string => fs.readFileSync(path.join(BOX_DIR, "files/bots-auth-proxy.nft"), "utf8");
