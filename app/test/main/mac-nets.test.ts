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
    expect(nets).toEqual(["2001:db8::9/128", "203.0.113.0/24", "2601:646:8f00:1a0::/64"]);
  });
  it("nothing extra on a plain home network", () => {
    expect(macGuardNets({ en0: [i("192.168.1.5", "192.168.1.5/24", "IPv4")] })).toEqual([]);
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

describe("macGuardNets clamps prefixes (bug 368)", () => {
  it("drops IPv4 shorter than /16 and IPv6 shorter than /32 (logged), never blocking huge ranges", () => {
    const logged: string[] = [];
    const nets = macGuardNets({
      en0: [i("203.0.113.77", "203.0.113.77/8", "IPv4"), i("198.51.100.7", "198.51.100.7/16", "IPv4"), i("2001:db8::9", "2001:db8::9/16", "IPv6"), i("2001:db8:1::9", "2001:db8:1::9/32", "IPv6")],
    }, (l) => logged.push(l));
    expect(nets).toEqual(["198.51.0.0/16", "2001:db8::/32"]);
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toMatch(/203\.0\.113\.77\/8[\s\S]*2001:db8::9\/16/);
  });
});
