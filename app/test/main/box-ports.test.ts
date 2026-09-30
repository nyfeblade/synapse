import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { helloMessage, userPorts, WRONG_HOST_MESSAGE } from "@synapse/shared";

// Two macOS accounts on one Mac: the box scripts compute and apply each Mac user's own ports (shared/src/user-ports.ts).
// Nothing here runs orb: ORB points at a fake, and the in-box step runs against a temp root with fake systemctl/nft.
const box = path.resolve(__dirname, "../../../box");
const read = (f: string) => fs.readFileSync(path.join(box, f), "utf8");
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "box-ports-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const sh = (script: string, env: Record<string, string> = {}, input?: string) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8", input, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ORB: "/usr/bin/false", ...env } });

describe("box/orb.sh: this Mac user's ports", () => {
  it.each([501, 502, 503, 626, 627, 1000, 0])("uid %i gets the same ports as the app computes", (uid) => {
    const r = sh(`source '${box}/orb.sh'; echo "$SYNAPSE_GATEWAY_PORT $SYNAPSE_WEBHOOK_PORT $SYNAPSE_AUTH_PROXY_PORT"`, { SYNAPSE_UID: String(uid) });
    expect(r.status, r.stderr).toBe(0);
    const p = userPorts(uid);
    expect(r.stdout.trim()).toBe(`${p.gateway} ${p.webhook} ${p.authProxy}`);
  });

  it("ports the app passes win over the computed ones", () => {
    const r = sh(`source '${box}/orb.sh'; echo "$SYNAPSE_GATEWAY_PORT $SYNAPSE_WEBHOOK_PORT $SYNAPSE_AUTH_PROXY_PORT"`,
      { SYNAPSE_UID: "501", SYNAPSE_GATEWAY_PORT: "48000", SYNAPSE_WEBHOOK_PORT: "48001", SYNAPSE_AUTH_PROXY_PORT: "48002" });
    expect(r.stdout.trim()).toBe("48000 48001 48002");
  });
});

// The in-box step is one script, box/files/bots-ports: deploy streams it (`apply`), provision installs it, and the
// auth proxy's firewall service runs it at every boot (`load`), so the loaded rule always follows the drop-in's port.
describe("box/files/bots-ports: the host's ports and the auth proxy's firewall rule", () => {
  const DROPIN = "etc/systemd/system/bothost.service.d/20-ports.conf";
  /** layout "old": a box provisioned before this change (only the rendered rule); "new": the shipped template too. */
  const root = (layout: "old" | "new" = "new") => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft"));
    if (layout === "new") fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    return r;
  };
  const run = (r: string, args: string[], o: { nftFails?: boolean; getent?: string } = {}) => {
    const log = path.join(r, "calls.log");
    const res = spawnSync("bash", [path.join(box, "files/bots-ports"), ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, R: r, GETENT: o.getent ?? "false", VISUDO: "true", SYSTEMCTL: `echo systemctl >> '${log}'; true`, NFT: o.nftFails ? `echo nft >> '${log}'; false` : `echo nft >> '${log}'; true` },
    });
    return { ...res, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const rule = (r: string) => fs.readFileSync(path.join(r, "etc/bots/auth-proxy.nft"), "utf8");

  it.each(["old", "new"] as const)("apply (%s box): the rule moves with the proxy port and loads BEFORE the host's drop-in is written", (layout) => {
    const r = root(layout);
    const res = run(r, ["apply", "47900", "47901", "47902"]);
    expect(res.status, res.stderr).toBe(0);
    const dropin = fs.readFileSync(path.join(r, DROPIN), "utf8");
    expect(dropin).toContain("Environment=HOST_PORT=47900");
    expect(dropin).toContain("Environment=WEBHOOK_PORT=47901");
    expect(dropin).toContain("Environment=SYNAPSE_AUTH_PROXY_PORT=47902");
    // The old port stays covered too, so a host still on it before its restart is never left open.
    expect(rule(r)).toContain("tcp dport { 47802, 47902 } meta skuid");
    expect(rule(r)).toMatch(/ip6 daddr ::1 tcp dport \{ 47802, 47902 \} counter reject/);
    expect(res.calls).toEqual(["nft", "nft", "systemctl"]); // the auth proxy rule, then the Mac guard (bug 362)
  });

  it("a rule that fails to load never moves the host: no drop-in is written", () => {
    const r = root();
    const res = run(r, ["apply", "47900", "47901", "47902"], { nftFails: true });
    expect(res.status).not.toBe(0);
    expect(fs.existsSync(path.join(r, DROPIN))).toBe(false);
  });

  it("every run loads the rule and reloads systemd, even when the files already say so (a failed load before is fixed)", () => {
    const r = root();
    run(r, ["apply", "47900", "47901", "47902"], { nftFails: true });
    fs.rmSync(path.join(r, "calls.log"));
    expect(run(r, ["apply", "47900", "47901", "47902"]).calls).toEqual(["nft", "nft", "systemctl"]);
    fs.rmSync(path.join(r, "calls.log"));
    expect(run(r, ["apply", "47900", "47901", "47902"]).calls).toEqual(["nft", "nft", "systemctl"]);
  });

  it("a missing firewall rule fails loudly instead of moving the host unguarded", () => {
    const r = tmp();
    const res = run(r, ["apply", "47900", "47901", "47902"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/firewall rule is missing/);
    expect(fs.existsSync(path.join(r, DROPIN))).toBe(false);
  });

  it("load (every boot, and provision): renders the rule for the drop-in's port and loads it", () => {
    const r = root();
    fs.mkdirSync(path.dirname(path.join(r, DROPIN)), { recursive: true });
    fs.writeFileSync(path.join(r, DROPIN), "[Service]\nEnvironment=HOST_PORT=47910\nEnvironment=WEBHOOK_PORT=47911\nEnvironment=SYNAPSE_AUTH_PROXY_PORT=47912\n");
    const res = run(r, ["load"]);
    expect(res.status, res.stderr).toBe(0);
    expect(rule(r)).toContain("tcp dport { 47802, 47912 } meta skuid");
    expect(res.calls).toEqual(["nft", "nft"]);
  });

  it("load with no drop-in (the account on 47800, or a box before its first deploy) is the shipped rule byte for byte", () => {
    const r = root();
    fs.writeFileSync(path.join(r, "etc/bots/auth-proxy.nft"), "stale");
    expect(run(r, ["load"]).status).toBe(0);
    expect(rule(r)).toBe(read("files/bots-auth-proxy.nft"));
    const r2 = root();
    run(r2, ["apply", "47800", "47801", "47802"]);
    expect(rule(r2)).toBe(read("files/bots-auth-proxy.nft"));
  });

  it("refuses a port that isn't a number", () => {
    expect(run(root(), ["apply", "47900", "x;rm", "47902"]).status).not.toBe(0);
  });

  it("orb.sh streams this same script to the box", () => {
    const r = sh(`source '${box}/orb.sh'; box_ports_script`);
    expect(r.stdout).toBe(read("files/bots-ports"));
    // Bug 364: installed first (the boot service and the host's sudo check run the installed copy), then run.
    expect(sh(`source '${box}/orb.sh'; type box_apply_ports`).stdout).toMatch(/cat > \/usr\/local\/lib\/bots\/bots-ports\.new[\s\S]*\/usr\/local\/lib\/bots\/bots-ports apply/);
  });
});

// Bug 362: OrbStack forwards the Mac's own addresses to any port on the Mac's 127.0.0.1, so bots-ports also renders and
// loads the Mac guard on every run (provision, every boot, every deploy).
describe("box/files/bots-ports: the Mac guard (Bots can't reach the Mac or the LAN)", () => {
  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    fs.writeFileSync(path.join(r, "etc/resolv.conf"), "# OrbStack DNS config\nnameserver 0.250.250.200\noptions edns0\n");
    return r;
  };
  /** A fake getent: the Mac's names resolve like OrbStack's, anything else fails. */
  const fakeGetent = (r: string, lines: Record<string, string[]>) => {
    const f = path.join(r, "getent");
    const cases = Object.entries(lines).map(([n, a]) => `  ${n}) ${a.map((x) => `echo "${x} STREAM ${n}"`).join("; ")} ;;`).join("\n");
    fs.writeFileSync(f, `#!/bin/sh\ncase "$2" in\n${cases}\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
    return f;
  };
  const orbstack = { "host.orb.internal": ["fd07:b51a:cc66:f0::fe", "0.250.250.254"], "host.docker.internal": ["0.250.250.254"], "host.internal": ["fd07:b51a:cc66:f0::fe"] };
  const load = (r: string, getent = "false", nftFails = false) => spawnSync("bash", [path.join(box, "files/bots-ports"), "load"], {
    encoding: "utf8", env: { PATH: process.env.PATH!, R: r, GETENT: getent, VISUDO: "true", SYSTEMCTL: "true", NFT: nftFails ? "false" : "true" },
  });
  const guard = (r: string) => fs.readFileSync(path.join(r, "etc/bots/mac-guard.nft"), "utf8");

  it("refuses every account but root and bothost on the Mac's addresses, IPv4 and IPv6, on every port", () => {
    const r = root();
    const res = load(r, fakeGetent(r, orbstack));
    expect(res.status, res.stderr).toBe(0);
    const g = guard(r);
    expect(g).toMatch(/^table inet bots_mac_guard\ndelete table inet bots_mac_guard\ntable inet bots_mac_guard \{$/m); // idempotent reload
    expect(g).toContain("set mac4 { type ipv4_addr; elements = { 0.250.250.254 } }");
    expect(g).toContain("set mac6 { type ipv6_addr; elements = { fd07:b51a:cc66:f0::fe } }");
    expect(g).toContain('meta skuid { "root", "bothost" } accept');
    const out = g.slice(g.indexOf("chain output"), g.indexOf("chain bots"));
    // Order: replies and root/bothost first, the box's own addresses, then the Mac (no port match: all ports), then the Bots.
    const at = (s: string) => { const i = out.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at("ct state established,related accept")).toBeLessThan(at('meta skuid { "root", "bothost" } accept'));
    expect(at("fib daddr type local accept")).toBeLessThan(at("ip daddr @mac4 goto deny"));
    expect(at("ip6 daddr @mac6 goto deny")).toBeLessThan(at('meta skuid "box" goto bots'));
    expect(out).toContain("meta skuid 60200-61099 goto bots");
    for (const l of out.split("\n").filter((x) => /goto deny/.test(x))) expect(l).not.toMatch(/dport/); // every port
    expect(g).toMatch(/chain deny \{\n\s+meta l4proto tcp counter reject with tcp reset\n\s+counter reject with icmpx type admin-prohibited/);
  });

  it("keeps box and the Bots off private and local ranges, but lets their DNS through to the box's nameserver", () => {
    const r = root();
    load(r, fakeGetent(r, orbstack));
    const g = guard(r);
    for (const c of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15"]) expect(g).toMatch(new RegExp(`set lan4 \\{[^}]*flags interval; elements = \\{[^}]*${c.replace(/\./g, "\\.")}`));
    for (const c of ["fc00::/7", "fe80::/10", "64:ff9b::/96"]) expect(g).toMatch(new RegExp(`set lan6 \\{[^}]*${c}`));
    expect(g).toContain("set dns4 { type ipv4_addr; elements = { 0.250.250.200 } }");
    const bots = g.slice(g.indexOf("chain bots"), g.indexOf("chain deny"));
    // DNS is let through in the output chain, before the Bots' chain is entered.
    expect(g.indexOf("ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept")).toBeGreaterThan(-1);
    expect(g.indexOf("ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept")).toBeLessThan(g.indexOf('meta skuid "box" goto bots'));
    expect(bots).not.toContain("dport 53");
    expect(bots).toContain("ip6 daddr @lan6 goto deny");
  });

  it("a boot before DNS is up uses the addresses cached at the last run; the fixed ones are there regardless", () => {
    const r = root();
    load(r, fakeGetent(r, orbstack));
    expect(fs.readFileSync(path.join(r, "etc/bots/mac-hosts"), "utf8").trim().split("\n")).toEqual(["0.250.250.254", "fd07:b51a:cc66:f0::fe"]);
    fs.rmSync(path.join(r, "etc/bots/mac-guard.nft"));
    expect(load(r, "false").status).toBe(0);
    expect(guard(r)).toContain("set mac6 { type ipv6_addr; elements = { fd07:b51a:cc66:f0::fe } }");
    const fresh = root();
    expect(load(fresh, "false").status).toBe(0);
    expect(guard(fresh)).toContain("set mac4 { type ipv4_addr; elements = { 0.250.250.254 } }");
    // Bug 366: OrbStack's host ULA is fixed like 0.250.250.254, so it is denied even with no lookup and no cache.
    expect(guard(fresh)).toContain("set mac6 { type ipv6_addr; elements = { fd07:b51a:cc66:f0::fe } }");
  });

  it("a lookup answer that isn't an address never reaches the rule", () => {
    const r = root();
    load(r, fakeGetent(r, { "host.orb.internal": ["1.2.3.4;flush ruleset", "}", "fd07::fe"] }));
    const g = guard(r);
    expect(g).not.toMatch(/flush ruleset|1\.2\.3\.4/);
    expect(g).toContain("set mac6 { type ipv6_addr; elements = { fd07::fe, fd07:b51a:cc66:f0::fe } }");
  });

  it("a guard that fails to load fails the run (provision, boot and deploy all see it)", () => {
    expect(load(root(), "false", true).status).not.toBe(0);
  });

  it("the boot service stops the guard too, and verify-box checks a Bot can't reach the Mac", () => {
    expect(read("files/bots-auth-proxy.service")).toContain("ExecStop=-/usr/sbin/nft delete table inet bots_mac_guard");
    const v = read("verify-box.sh");
    expect(v).toContain("a Bot account can't reach the Mac ($a)");
    expect(v).toContain('MACADDRS="host.orb.internal host.docker.internal 0.250.250.254 fd07:b51a:cc66:f0::fe"');
    expect(read("two-account-sim.sh")).toContain("every Mac-reach check");
  });
});

// Bug 364: fail closed.
describe("box/files/bots-ports: fail closed (bug 364)", () => {
  const script = path.join(box, "files/bots-ports");
  const fn = (f: string, arg: string) => spawnSync("bash", ["-c", `eval "$(sed -n '/^is_ipv4()/,/^is_addr()/p' '${script}')"; ${f} '${arg}'`], { encoding: "utf8" }).status === 0;
  it.each(["0.250.250.254", "10.0.0.1", "255.255.255.255", "0.0.0.0", "192.168.1.1"])("IPv4 %s parses", (a) => expect(fn("is_ipv4", a)).toBe(true));
  it.each(["1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1..2.3", "1.2.3.", ".1.2.3", "1.2.3.4/8", "a.b.c.d", "", "1.2.3.4 ", "1234.1.1.1"])("IPv4 %j is refused", (a) => expect(fn("is_ipv4", a)).toBe(false));
  it.each(["::1", "::", "fd07:b51a:cc66:f0::fe", "fe80::1", "2001:db8::", "1:2:3:4:5:6:7:8", "::ffff:192.168.1.1", "64:ff9b::1.2.3.4", "1::8", "1:2:3:4:5:6:7::"])("IPv6 %s parses", (a) => expect(fn("is_ipv6", a)).toBe(true));
  it.each(["fd07", "fd07:", ":1::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3", ":::", "12345::", "g::1", "::ffff:1.2.3", "1:2:3:4:5:6:7:8::", "fd07::fe/64", ""])("IPv6 %j is refused", (a) => expect(fn("is_ipv6", a)).toBe(false));

  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    return r;
  };
  const run = (r: string, args: string[], env: Record<string, string> = {}) => spawnSync("bash", [script, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH!, R: r, GETENT: "false", VISUDO: "true", SYSTEMCTL: "true", NFT: "true", ...env },
  });

  it("check passes only when both tables are loaded", () => {
    const r = root();
    expect(run(r, ["check"]).status).toBe(0);
    expect(run(r, ["check"], { NFT: `f() { [ "$3 $4" != "inet bots_mac_guard" ]; }; f` }).status).not.toBe(0);
    expect(run(r, ["check"], { NFT: `f() { [ "$3 $4" != "inet bots_auth_proxy" ]; }; f` }).status).not.toBe(0);
  });

  it("apply and load install the one sudoers line the host's check needs, validated first", () => {
    for (const verb of [["apply", "47900", "47901", "47902"], ["load"]]) {
      const r = root();
      expect(run(r, verb).status).toBe(0);
      const sudo = fs.readFileSync(path.join(r, "etc/sudoers.d/bots-ports-check"), "utf8");
      expect(sudo).toBe("Defaults!/usr/local/lib/bots/bots-ports !use_pty\nbothost ALL=(root) NOPASSWD: /usr/local/lib/bots/bots-ports check\n");
      expect(fs.statSync(path.join(r, "etc/sudoers.d/bots-ports-check")).mode & 0o777).toBe(0o440);
    }
    const bad = root();
    expect(run(bad, ["load"], { VISUDO: "false" }).status).not.toBe(0);
    expect(fs.existsSync(path.join(bad, "etc/sudoers.d/bots-ports-check"))).toBe(false);
  });

  it("the sudoers line is valid sudoers syntax (real visudo, where there is one)", () => {
    if (!fs.existsSync("/usr/sbin/visudo")) return; // no visudo here: the throwaway-box run covers it
    const r = root();
    run(r, ["load"]);
    expect(spawnSync("/usr/sbin/visudo", ["-cf", path.join(r, "etc/sudoers.d/bots-ports-check")], { encoding: "utf8" }).status).toBe(0);
  });

  it("apply makes the host require the firewall service (a box provisioned before this gets it at deploy)", () => {
    const r = root();
    expect(run(r, ["apply", "47900", "47901", "47902"]).status).toBe(0);
    expect(fs.readFileSync(path.join(r, "etc/systemd/system/bothost.service.d/05-firewall.conf"), "utf8")).toBe("[Unit]\nRequires=bots-auth-proxy.service\nAfter=bots-auth-proxy.service\n");
    const unit = read("files/bothost.service");
    expect(unit).toMatch(/^Requires=bots-auth-proxy\.service$/m);
    expect(unit).toMatch(/^After=.*\bbots-auth-proxy\.service\b/m);
  });

  it("the rendered guard passes `nft -c` (only where nft runs as root: the throwaway box, not this Mac)", () => {
    const nft = ["/usr/sbin/nft", "/sbin/nft"].find((p) => fs.existsSync(p));
    if (!nft || process.getuid?.() !== 0) return; // note: skipped here; run on a throwaway box (bug 364)
    const r = root();
    run(r, ["load"]);
    expect(spawnSync(nft, ["-c", "-f", path.join(r, "etc/bots/mac-guard.nft")], { encoding: "utf8" }).status).toBe(0);
  });
});

// Bug 365: the Mac's own networks (global IPv6 prefixes, non-RFC 1918 LAN IPv4) from the Mac.
describe("box/files/bots-ports: the Mac's own networks (bug 365)", () => {
  const script = path.join(box, "files/bots-ports");
  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    fs.writeFileSync(path.join(r, "etc/resolv.conf"), "nameserver 0.250.250.200\n");
    return r;
  };
  const run = (r: string, args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, R: r, GETENT: "false", VISUDO: "true", SYSTEMCTL: "true", NFT: "true" } });
  const conf = (r: string) => fs.readFileSync(path.join(r, "etc/bots/net-guard.conf"), "utf8");
  const guard = (r: string) => fs.readFileSync(path.join(r, "etc/bots/mac-guard.nft"), "utf8");

  it("apply's 5th argument saves the list (normalized, bad entries dropped) and the guard denies it to all but root and bothost", () => {
    const r = root();
    const res = run(r, ["apply", "47900", "47901", "47902", "2601:646:8f00:1a0:1c2b:3cff:fe4d:5e6f/64 203.0.113.77/24 1.2.3/8 fd07::/129 x"]);
    expect(res.status, res.stderr).toBe(0);
    expect(conf(r)).toMatch(/^MAC_NETS=203\.0\.113\.0\/24 2601:646:8f00:1a0::\/64$/m);
    const g = guard(r);
    expect(g).toContain("set macnet4 { type ipv4_addr; flags interval; elements = { 203.0.113.0/24 } }");
    expect(g).toContain("set macnet6 { type ipv6_addr; flags interval; elements = { 2601:646:8f00:1a0::/64 } }");
    const out = g.slice(g.indexOf("chain output"), g.indexOf("chain bots"));
    expect(out.indexOf('meta skuid { "root", "bothost" } accept')).toBeLessThan(out.indexOf("ip daddr @macnet4 goto deny"));
    expect(out.indexOf("ip6 daddr @macnet6 goto deny")).toBeLessThan(out.indexOf('meta skuid "box" goto bots'));
    // DNS to the box's nameserver comes before every deny, for every account.
    expect(out.indexOf("ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept")).toBeLessThan(out.indexOf("ip daddr @mac4 goto deny"));
  });

  it("apply without it keeps the saved list; an empty one clears it; mac-nets replaces it and reloads only the guard", () => {
    const r = root();
    run(r, ["apply", "47900", "47901", "47902", "2001:db8::/64"]);
    run(r, ["apply", "47900", "47901", "47902"]);
    expect(conf(r)).toMatch(/^MAC_NETS=2001:db8::\/64$/m);
    expect(run(r, ["mac-nets", "198.51.100.0/24"]).status).toBe(0);
    expect(conf(r)).toMatch(/^MAC_NETS=198\.51\.100\.0\/24$/m);
    expect(conf(r).match(/^MAC_NETS=/gm)).toHaveLength(1);
    expect(guard(r)).toContain("elements = { 198.51.100.0/24 }");
    run(r, ["apply", "47900", "47901", "47902", ""]);
    expect(conf(r)).toMatch(/^MAC_NETS=$/m);
    expect(guard(r)).toContain("set macnet6 { type ipv6_addr; flags interval; }");
  });

  it("the host's guarded fetch reads the same line", () => {
    expect(fs.readFileSync(path.resolve(box, "../host/net/guarded-fetch.ts"), "utf8")).toMatch(/\/etc\/bots\/net-guard\.conf[\s\S]*MAC_NETS=/);
  });

  it("orb.sh passes SYNAPSE_MAC_NETS through only when the app set it", () => {
    expect(read("orb.sh")).toContain('${SYNAPSE_MAC_NETS+"$SYNAPSE_MAC_NETS"}');
  });
});

// Bug 366: the low items of the review.
describe("box/files/bots-ports: OrbStack's own addresses and the cache (bug 366)", () => {
  const script = path.join(box, "files/bots-ports");
  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    fs.writeFileSync(path.join(r, "etc/resolv.conf"), "nameserver 0.250.250.200\n");
    return r;
  };
  const getent = (r: string, lines: string) => { const f = path.join(r, "getent"); fs.writeFileSync(f, `#!/bin/sh\n[ "$2" = host.orb.internal ] || exit 2\n${lines}\n`, { mode: 0o755 }); return f; };
  const load = (r: string, g = "false") => spawnSync("bash", [script, "load"], { encoding: "utf8", env: { PATH: process.env.PATH!, R: r, GETENT: g, VISUDO: "true", SYSTEMCTL: "true", NFT: "true" } });
  const guard = (r: string) => fs.readFileSync(path.join(r, "etc/bots/mac-guard.nft"), "utf8");

  it("0.250.250.0/24, 198.19.249.1 and the host services' ULA net are denied to all but root and bothost, after DNS", () => {
    const r = root();
    expect(load(r).status).toBe(0);
    const g = guard(r);
    expect(g).toContain("set orb4 { type ipv4_addr; flags interval; elements = { 0.250.250.0/24, 198.19.249.1 } }");
    expect(g).toContain("set orb6 { type ipv6_addr; flags interval; elements = { fd07:b51a:cc66:f0::/64 } }");
    const out = g.slice(g.indexOf("chain output"), g.indexOf("chain bots"));
    const at = (x: string) => { const i = out.indexOf(x); expect(i, x).toBeGreaterThan(-1); return i; };
    expect(at('meta skuid { "root", "bothost" } accept')).toBeLessThan(at("ip daddr @orb4 goto deny"));
    expect(at("ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept")).toBeLessThan(at("ip daddr @orb4 goto deny"));
    expect(at("ip6 daddr @orb6 goto deny")).toBeLessThan(at('meta skuid "box" goto bots'));
  });

  it("the cache of the Mac's resolved addresses is merged, never replaced", () => {
    const r = root();
    load(r, getent(r, 'echo "fd07:aaaa::fe STREAM"'));
    load(r, getent(r, 'echo "0.250.250.253 STREAM"'));
    expect(fs.readFileSync(path.join(r, "etc/bots/mac-hosts"), "utf8").trim().split("\n")).toEqual(["0.250.250.253", "fd07:aaaa::fe"]);
    expect(guard(r)).toContain("set mac6 { type ipv6_addr; elements = { fd07:aaaa::fe, fd07:b51a:cc66:f0::fe } }");
    expect(guard(r)).toContain("set mac4 { type ipv4_addr; elements = { 0.250.250.253, 0.250.250.254 } }");
  });

  it("verify-box never lets a Mac or LAN check skip silently", () => {
    const v = read("verify-box.sh");
    expect(v).not.toContain("${MV6:+");
    expect(v).toMatch(/FAIL a Bot account can't reach the Mac \(IPv6/);
    for (const c of ["a Bot account can't reach the LAN", "a Bot account can't send UDP to the Mac", "a Bot account can't ping the Mac", "boxmcp can't reach the Mac"]) expect(v).toContain(c);
    const sim = read("two-account-sim.sh");
    expect(sim).toMatch(/\^SKIP \.\*\(Mac\|LAN\)/);
  });
});

// Bug 367 (product call): the LAN block is driven by one config in the box, all blocked by default.
describe("box/files/bots-ports: the LAN block comes from net-guard.conf (bug 367)", () => {
  const script = path.join(box, "files/bots-ports");
  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    return r;
  };
  const load = (r: string) => spawnSync("bash", [script, "load"], { encoding: "utf8", env: { PATH: process.env.PATH!, R: r, GETENT: "false", VISUDO: "true", SYSTEMCTL: "true", NFT: "true" } });
  const conf = (r: string) => path.join(r, "etc/bots/net-guard.conf");
  const guard = (r: string) => fs.readFileSync(path.join(r, "etc/bots/mac-guard.nft"), "utf8");
  const bots = (r: string) => { const g = guard(r); return g.slice(g.indexOf("chain bots"), g.indexOf("chain deny")); };

  it("writes the defaults once (everything blocked) and renders the sets from them", () => {
    const r = root();
    expect(load(r).status).toBe(0);
    const c = fs.readFileSync(conf(r), "utf8");
    expect(c).toMatch(/^LAN_BLOCK=on$/m);
    expect(c).toMatch(/^LAN4=0\.0\.0\.0\/8 10\.0\.0\.0\/8 100\.64\.0\.0\/10 169\.254\.0\.0\/16 172\.16\.0\.0\/12 192\.168\.0\.0\/16 198\.18\.0\.0\/15 224\.0\.0\.0\/4 240\.0\.0\.0\/4$/m);
    expect(c).toMatch(/^LAN6=64:ff9b::\/96 64:ff9b:1::\/48 fc00::\/7 fe80::\/10 ff00::\/8$/m);
    expect(guard(r)).toContain("set lan4 { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } }");
    expect(bots(r)).toContain("ip daddr @lan4 goto deny");
    expect(bots(r)).toContain("ip6 daddr @lan6 goto deny");
  });

  it("an owner's edit is kept; LAN_BLOCK=off (the future opt-in) lifts only the LAN, never the Mac", () => {
    const r = root();
    load(r);
    fs.writeFileSync(conf(r), fs.readFileSync(conf(r), "utf8").replace(/^LAN_BLOCK=on$/m, "LAN_BLOCK=off").replace(/^LAN4=.*$/m, "LAN4=10.0.0.0/8 bogus"));
    expect(load(r).status).toBe(0);
    expect(fs.readFileSync(conf(r), "utf8")).toMatch(/^LAN_BLOCK=off$/m);
    expect(guard(r)).toContain("set lan4 { type ipv4_addr; flags interval; elements = { 10.0.0.0/8 } }");
    expect(bots(r)).not.toMatch(/goto deny/);
    const out = guard(r).slice(guard(r).indexOf("chain output"), guard(r).indexOf("chain bots"));
    expect(out).toContain("ip daddr @mac4 goto deny");
    expect(out).toContain("ip daddr @orb4 goto deny");
  });

  it("anything but off blocks, and a list with nothing valid falls back to the default", () => {
    const r = root();
    load(r);
    fs.writeFileSync(conf(r), fs.readFileSync(conf(r), "utf8").replace(/^LAN_BLOCK=on$/m, "LAN_BLOCK=maybe").replace(/^LAN6=.*$/m, "LAN6=nope"));
    load(r);
    expect(bots(r)).toContain("ip daddr @lan4 goto deny");
    expect(guard(r)).toContain("set lan6 { type ipv6_addr; flags interval; elements = { 64:ff9b::/96, 64:ff9b:1::/48, fc00::/7, fe80::/10, ff00::/8 } }");
  });
});

describe("provision installs the rule from the drop-in's port, and a reboot keeps it", () => {
  const prov = read("provision.sh");
  it("provision.sh installs the shipped rule as the template and renders it with bots-ports load", () => {
    expect(prov).toContain('"$HERE/files/bots-auth-proxy.nft" /etc/bots/auth-proxy.nft.in');
    expect(prov).not.toMatch(/"\$HERE\/files\/bots-auth-proxy\.nft" \/etc\/bots\/auth-proxy\.nft\s*$/m);
    expect(prov).toMatch(/install -m 0755 -o root -g root "\$HERE\/files\/bots-ports" \/usr\/local\/lib\/bots\/bots-ports\n\/usr\/local\/lib\/bots\/bots-ports load/);
  });
  it("the firewall service loads the rule through bots-ports at every boot", () => {
    expect(read("files/bots-auth-proxy.service")).toContain("ExecStart=/usr/local/lib/bots/bots-ports load");
  });
});

describe("the box scripts pass the ports at provision and deploy time", () => {
  it("deploy.sh applies them before it restarts the host", () => {
    const d = read("deploy.sh");
    expect(d).toMatch(/box_apply_ports[\s\S]*systemctl restart bothost/);
  });
  it("provision-from-mac.sh applies them after provision.sh (which reinstalls the shipped firewall rule)", () => {
    expect(read("provision-from-mac.sh")).toMatch(/provision\.sh[\s\S]*box_apply_ports/);
  });
  it("verify-box.sh checks the auth proxy on this user's port", () => {
    const v = read("verify-box.sh");
    expect(v).toContain("$SYNAPSE_AUTH_PROXY_PORT");
    expect(v).not.toMatch(/127\.0\.0\.1:47802/);
  });
});

describe("check-gateway.sh (deploy's last step)", () => {
  const run = (info: string, curlCode: string) => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "orb"), `#!/bin/sh\necho '${info}'\n`, { mode: 0o755 });
    // Like curl: -w prints the status; -sf fails (22) on anything but 2xx.
    fs.writeFileSync(path.join(d, "curl"), `#!/bin/sh\ncase "$*" in *"-K -"*) cat >/dev/null;; esac\ncase "$*" in *http_code*) echo ${curlCode}; exit 0;; esac\n[ ${curlCode} = 200 ] && { echo '{"ok":true}'; exit 0; }\nexit 22\n`, { mode: 0o755 });
    return spawnSync("bash", [path.join(box, "check-gateway.sh")], {
      encoding: "utf8",
      env: { PATH: `${d}:${process.env.PATH}`, HOME: process.env.HOME!, ORB: path.join(d, "orb"), BOX_MACHINE: "synapse-box", SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_CHECK_TRIES: "2" },
    });
  };
  it("a port answered by another account's host fails plainly instead of passing or timing out", () => {
    const r = run('{"port":47900,"token":"t"}', "401");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(WRONG_HOST_MESSAGE);
  });
  // Final review: right after a restart the script sent the token to whatever answered the port. With `hello: 1` in
  // gateway.json it now checks the host's /hello proof (HMAC-SHA256 of its nonce, keyed with the token) first.
  const helloRun = (hostKey: string) => {
    const d = tmp();
    const log = path.join(d, "curl.log");
    fs.writeFileSync(path.join(d, "orb"), `#!/bin/sh\necho '{"port":47900,"token":"tok","hello":1}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(d, "curl"), [
      "#!/bin/bash", `echo "$*" >> '${log}'`,
      `case "$*" in *"-K -"*) cat >> '${log}.stdin';; esac`,
      'for a in "$@"; do case "$a" in *"/hello?nonce="*) n="${a##*nonce=}"; p="$(printf \'synapse-hello:%s\' "$n" | openssl dgst -sha256 -hmac \'' + hostKey + '\' | awk \'{print $NF}\')"; echo "{\\"ok\\":true,\\"proof\\":\\"$p\\"}"; exit 0;; esac; done',
      'case "$*" in *Origin*) echo 403; exit 0;; *http_code*) echo 200; exit 0;; esac',
      "echo '{\"ok\":true}'",
    ].join("\n") + "\n", { mode: 0o755 });
    const r = spawnSync("bash", [path.join(box, "check-gateway.sh")], {
      encoding: "utf8",
      env: { PATH: `${d}:${process.env.PATH}`, HOME: process.env.HOME!, ORB: path.join(d, "orb"), BOX_MACHINE: "synapse-box", SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_CHECK_TRIES: "2" },
    });
    return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [], stdin: fs.existsSync(`${log}.stdin`) ? fs.readFileSync(`${log}.stdin`, "utf8") : "" };
  };
  it("a host that answers /hello proves itself before the token is sent", () => {
    const r = helloRun("tok");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PASS gateway /health");
    expect(r.calls[0]).toMatch(/\/hello\?nonce=[0-9a-f]{32}/);
    expect(r.calls[0]).not.toMatch(/Authorization/);
    // The token goes to curl on stdin, never in its arguments.
    expect(r.calls.some((c) => /tok/.test(c.replace(/nonce=[0-9a-f]+/, "")))).toBe(false);
    expect(r.stdin).toContain('header = "Authorization: Bearer tok"');
  });
  it("a wrong proof is another account's host, and the token is never sent", () => {
    const r = helloRun("someone-elses");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(WRONG_HOST_MESSAGE);
    expect(r.calls.some((c) => /Authorization/.test(c))).toBe(false);
    expect(r.stdin).toBe("");
  });
  it("waits for the host to come up on this user's port, not a stale gateway.json", () => {
    const r = run('{"port":47800,"token":"t"}', "200");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/47900/);
  });
});

// Re-review: check-gateway.sh runs on the Mac (deploy.sh calls it there; curl and openssl are Mac processes), and
// another macOS account can read any process's arguments with ps. So the host token never goes into an external
// command's arguments: curl gets its Authorization header on stdin (-K -), and the /hello HMAC is computed from the
// token held in a shell variable (orb.sh synapse_hello_hmac), with only the data piped to openssl.
describe("the host token never appears in a process's arguments", () => {
  const scripts = { "check-gateway.sh": read("check-gateway.sh"), "orb.sh": read("orb.sh") };
  it("every line that uses the token passes it only to printf (a builtin) or the HMAC shell function", () => {
    const bad: string[] = [];
    for (const [name, src] of Object.entries(scripts)) {
      src.split("\n").forEach((line, i) => {
        if (/^\s*#/.test(line) || !/\$\{?(TOKEN|key)\b/.test(line) || /^\s*TOKEN="\$\(printf '%s' "\$INFO" \| plutil/.test(line)) return;
        const segs = line.split(/\|(?!\|)|\$\(|;|&&/).filter((seg) => /\$\{?(TOKEN|key)\b/.test(seg));
        for (const seg of segs) {
          const cmd = seg.trim().replace(/^[a-z_]+\(\)\s*/, "").replace(/^[{(]\s*/, "").replace(/^(local|if|then|elif|!)\s+/, "");
          if (!/^(printf|synapse_hello_hmac|local\s|[a-z_]+=|\[)/.test(cmd)) bad.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it.each([64, 32, 100])("synapse_hello_hmac matches the host's HMAC for a %i-character token", (len) => {
    const token = "ab12".repeat(40).slice(0, len);
    const nonce = "0123456789abcdef0123456789abcdef";
    const r = sh(`source '${box}/orb.sh'; TOKEN='${token}'; synapse_hello_hmac '${nonce}'`, { SYNAPSE_UID: "501" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(createHmac("sha256", token).update(helloMessage(nonce)).digest("hex"));
  });
});
