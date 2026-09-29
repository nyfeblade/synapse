import { describe, expect, it } from "vitest";
import { boxPortEnv, userPorts, WRONG_HOST_MESSAGE } from "../src/user-ports";

const all = (uid: number) => { const p = userPorts(uid); return [p.gateway, p.webhook, p.authProxy]; };

describe("per-user box ports (two macOS accounts on one Mac)", () => {
  it("the account that already uses 47800 keeps it (no migration for an existing single-user install)", () => {
    expect(userPorts(501)).toEqual({ gateway: 47800, webhook: 47801, authProxy: 47802 });
  });

  it("two different users get different ports, with no overlap between their sets", () => {
    const a = all(501), b = all(502);
    expect(b).not.toEqual(a);
    for (const p of b) expect(a).not.toContain(p);
  });

  it("125 consecutive uids never share a port, and each user's three ports differ", () => {
    const seen = new Set<number>();
    for (let uid = 501; uid < 501 + 126; uid++) {
      const ps = all(uid);
      expect(new Set(ps).size).toBe(3);
      for (const p of ps) { expect(seen.has(p)).toBe(false); seen.add(p); }
    }
  });

  it("stays unprivileged, below macOS's ephemeral range, and off the OAuth loopback ports", () => {
    for (const uid of [0, 1, 499, 500, 501, 502, 503, 626, 627, 1000, 65534, 1_234_567, -2]) {
      for (const p of all(uid)) {
        expect(p).toBeGreaterThanOrEqual(1024);
        expect(p).toBeLessThan(49152);
        expect([47823, 47824, 47825]).not.toContain(p);
      }
    }
  });

  it("is deterministic (survives re-provision and updates)", () => {
    expect(userPorts(777)).toEqual(userPorts(777));
  });

  it("names the ports for the box scripts", () => {
    expect(boxPortEnv(502)).toEqual({ SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_WEBHOOK_PORT: "47901", SYNAPSE_AUTH_PROXY_PORT: "47902" });
  });

  it("the wrong-host message is plain", () => {
    expect(WRONG_HOST_MESSAGE).toMatch(/^Synapse is running in another account on this Mac/);
  });
});
