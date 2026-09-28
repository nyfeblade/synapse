import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@synapse/shared";
import { loadConfig } from "../../config";

describe("auth proxy config and the box firewall rule", () => {
  it("on by default on its own fixed port; API key only (no OAuth proxying); off only in a test run", () => {
    expect(loadConfig({}).authProxy).toEqual({ enabled: true, port: LIMITS.authProxyPort, upstream: "https://api.anthropic.com" });
    expect(loadConfig({ SYNAPSE_AUTH_PROXY: "off", BOTS_AUTH_PROXY_OAUTH: "1", SYNAPSE_AUTH_PROXY_OAUTH: "1" }).authProxy.enabled).toBe(true); // production: refused
    expect(loadConfig({ SYNAPSE_AUTH_PROXY: "off", VITEST: "true" }).authProxy.enabled).toBe(false);
  });

  it("the nftables rule limits the proxy port to bothost, box and the Bot uid range, and rejects everyone else", () => {
    const nft = fs.readFileSync(path.resolve(__dirname, "../../../box/files/bots-auth-proxy.nft"), "utf8");
    expect(nft).toContain(`tcp dport ${LIMITS.authProxyPort}`);
    expect(nft).toMatch(/meta skuid \{ "bothost", "box" \} accept/);
    expect(nft).toMatch(/meta skuid 60200-61099 accept/);
    expect(nft).toMatch(/ip daddr 127\.0\.0\.1 tcp dport \d+ counter reject/);
    const prov = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");
    expect(prov).toContain("bots-auth-proxy.service");
    expect(prov).toMatch(/nftables/);
  });
});
