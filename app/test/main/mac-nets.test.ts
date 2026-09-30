import type os from "node:os";
import { describe, expect, it } from "vitest";
import { MacNetsWatcher, macGuardNets, macNetsEnv } from "../../src/main/mac-nets";

// Bug 365: the Mac's own global IPv6 prefixes and any LAN IPv4 outside RFC 1918 go to the box firewall.
const i = (address: string, cidr: string, family: "IPv4" | "IPv6", internal = false) => ({ address, cidr, family, internal, netmask: "", mac: "", scopeid: 0 }) as os.NetworkInterfaceInfo;

describe("macGuardNets", () => {
  it("keeps global IPv6 prefixes and non-RFC 1918 IPv4 networks; drops what the fixed ranges already cover", () => {
    const nets = macGuardNets({
      lo0: [i("127.0.0.1", "127.0.0.1/8", "IPv4", true), i("::1", "::1/128", "IPv6", true)],
      en0: [
        i("192.168.1.23", "192.168.1.23/24", "IPv4"), i("fe80::1c2b:3cff:fe4d:5e6f%en0", "fe80::1c2b:3cff:fe4d:5e6f/64", "IPv6"),
        i("2601:646:8f00:1a0:1c2b:3cff:fe4d:5e6f", "2601:646:8f00:1a0:1c2b:3cff:fe4d:5e6f/64", "IPv6"), i("fd00:1:2:3::5", "fd00:1:2:3::5/64", "IPv6"),
      ],
      en5: [i("203.0.113.77", "203.0.113.77/24", "IPv4")],
      utun3: [i("100.64.0.103", "100.64.0.103/32", "IPv4"), i("2001:db8:0:0:0:0:0:9", "2001:db8::9/128", "IPv6")],
      bridge100: [i("192.168.139.3", "192.168.139.3/24", "IPv4")],
    });
    expect(nets.filter((n) => !/\/(32|128)$/.test(n) || n === "2001:db8::9/128")).toEqual(["2001:db8::9/128", "203.0.113.0/24", "2601:646:8f00:1a0::/64"]);
  });
  // 0.1.4 Local network: with the LAN opened, the RFC 1918 / ULA ranges no longer cover the Mac, so each of its own
  // addresses is denied by name (a /32 or /128), in every state. Loopback isn't (the box never routes it to the Mac).
  it("every address of the Mac's own goes in as a /32 or /128, RFC 1918, ULA, CGNAT and link-local included", () => {
    const nets = macGuardNets({
      lo0: [i("127.0.0.1", "127.0.0.1/8", "IPv4", true), i("::1", "::1/128", "IPv6", true)],
      en0: [i("192.168.1.23", "192.168.1.23/24", "IPv4"), i("fe80::1c2b:3cff:fe4d:5e6f%en0", "fe80::1c2b:3cff:fe4d:5e6f/64", "IPv6"), i("fd00:1:2:3::5", "fd00:1:2:3::5/64", "IPv6")],
      utun3: [i("100.64.0.103", "100.64.0.103/32", "IPv4")],
      bridge100: [i("192.168.139.3", "192.168.139.3/24", "IPv4")],
    });
    expect(nets).toEqual(["100.64.0.103/32", "192.168.1.23/32", "192.168.139.3/32", "fd00:1:2:3::5/128", "fe80::1c2b:3cff:fe4d:5e6f/128"]);
  });
  it("a plain home network: just the Mac's own address", () => {
    expect(macGuardNets({ en0: [i("192.168.1.5", "192.168.1.5/24", "IPv4")] })).toEqual(["192.168.1.5/32"]);
    expect(macNetsEnv([])).toEqual({ SYNAPSE_MAC_NETS: "" });
  });
});

describe("MacNetsWatcher", () => {
  it("applies at once on start, then only after a change has settled; a failed send retries", async () => {
    let nets = ["2001:db8::/64"];
    let now = 0;
    let ok = true;
    const sent: string[][] = [];
    const w = new MacNetsWatcher({ nets: () => nets, now: () => now, debounceMs: 5_000, apply: async (n) => { sent.push(n); return ok; } });
    await w.tick();
    expect(sent).toEqual([["2001:db8::/64"]]);
    await w.tick();
    expect(sent).toHaveLength(1); // no change, no send
    nets = ["2001:db8:1::/64"]; now = 1_000;
    await w.tick();
    expect(sent).toHaveLength(1); // changed, not settled yet
    now = 7_000; ok = false;
    await w.tick();
    expect(sent).toHaveLength(2); // sent, refused
    now = 8_000; ok = true;
    await w.tick();
    expect(sent).toEqual([["2001:db8::/64"], ["2001:db8:1::/64"], ["2001:db8:1::/64"]]);
    await w.tick();
    expect(sent).toHaveLength(3);
  });
});

describe("MacNetsWatcher: every tick runs the Local network tamper check (0.1.4)", () => {
  it("calls everyTick on each tick, changed or not, and a failing check never stops the watcher", async () => {
    let n = 0;
    const w = new MacNetsWatcher({ nets: () => ["2001:db8::/64"], apply: async () => true, everyTick: async () => { n++; if (n === 2) throw new Error("box down"); } });
    await w.tick(); await w.tick(); await w.tick();
    expect(n).toBe(3);
  });
});

describe("macGuardNets clamps prefixes (bug 368)", () => {
  it("drops IPv4 shorter than /16 and IPv6 shorter than /32 (logged), never blocking huge ranges", () => {
    const logged: string[] = [];
    const nets = macGuardNets({
      en0: [i("203.0.113.77", "203.0.113.77/8", "IPv4"), i("198.51.100.7", "198.51.100.7/16", "IPv4"), i("2001:db8::9", "2001:db8::9/16", "IPv6"), i("2001:db8:1::9", "2001:db8:1::9/32", "IPv6")],
    }, (l) => logged.push(l));
    // The networks too short to block are dropped; the addresses themselves are still denied.
    expect(nets).toEqual(["198.51.0.0/16", "198.51.100.7/32", "2001:db8:1::9/128", "2001:db8::/32", "2001:db8::9/128", "203.0.113.77/32"]);
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toMatch(/203\.0\.113\.77\/8[\s\S]*2001:db8::9\/16/);
  });
});
