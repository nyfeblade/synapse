import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuth, OAUTH_REDIRECT } from "../../mcp/oauth";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

// Stands in for @modelcontextprotocol/sdk's auth(): REDIRECT without a code, AUTHORIZED with one.
const fakeAuth = async (p: OAuthClientProvider, o: { serverUrl: string | URL; authorizationCode?: string }) => {
  if (!o.authorizationCode) {
    await p.saveClientInformation?.({ client_id: "cid", redirect_uris: [OAUTH_REDIRECT] } as never);
    await p.saveCodeVerifier("verifier-1");
    await p.redirectToAuthorization(new URL(`https://auth.example/authorize?client_id=cid&state=${await p.state!()}`));
    return "REDIRECT" as const;
  }
  expect(await p.codeVerifier()).toBe("verifier-1");
  await p.saveTokens({ access_token: "tok", token_type: "bearer", refresh_token: "r" });
  return "AUTHORIZED" as const;
};

let dir: string;
let now = 0;
let oauth: McpOAuth;
const events: string[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-"));
  events.length = 0;
  now = 1_000;
  const registry = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => now });
  registry.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
  oauth = new McpOAuth({ dir: path.join(dir, "mcp"), registry, now: () => now, authFn: fakeAuth as never, onWaiting: (s) => events.push(`waiting:${s}`), onAuthorized: async (s) => void events.push(`ok:${s}`) });
});

describe("McpOAuth (PLG-04)", () => {
  it("start returns the browser URL; complete exchanges the code and stores tokens 0600", async () => {
    const url = await oauth.start("linear");
    const state = new URL(url).searchParams.get("state")!;
    expect(url).toMatch(/^https:\/\/auth\.example\/authorize/);
    expect(oauth.pendingFor("linear")).toBe(true);
    expect(events).toEqual(["waiting:linear"]);
    const r = await oauth.complete({ state, code: "abc" });
    expect(r).toEqual({ serverId: "linear", status: "connected" });
    expect(events).toEqual(["waiting:linear", "ok:linear"]);
    const file = path.join(dir, "mcp", "oauth", "linear.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(oauth.providerFor("linear").hasTokens()).toBe(true);
    expect(oauth.pendingFor("linear")).toBe(false);
  });

  it("expires pending flows after 11 minutes and rejects unknown states", async () => {
    const url = await oauth.start("linear");
    const state = new URL(url).searchParams.get("state")!;
    now += 11 * 60_000 + 1;
    await expect(oauth.complete({ state, code: "abc" })).rejects.toThrow(/expired/);
    await expect(oauth.complete({ state: "nope", code: "abc" })).rejects.toThrow(/expired/);
  });

  it("a DCR refusal tells the user to paste a token instead of looping Authorize", async () => {
    const broken = new McpOAuth({
      dir: path.join(dir, "mcp-dcr"),
      registry: (() => {
        const r = new McpRegistry({ dir: path.join(dir, "mcp-dcr"), settings: new HostSettingsStore(path.join(dir, "s-dcr.json")), now: () => now });
        r.add({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/" }, "curated", "curated:github");
        return r;
      })(),
      now: () => now,
      authFn: async () => { throw new Error("Dynamic client registration failed: incompatible auth server"); },
      onWaiting: () => {},
      onAuthorized: async () => {},
    });
    await expect(broken.start("github")).rejects.toThrow(/paste/i);
  });

  it("a denied authorization returns needs-auth", async () => {
    const url = await oauth.start("linear");
    const state = new URL(url).searchParams.get("state")!;
    expect(await oauth.complete({ state, error: "access_denied" })).toEqual({ serverId: "linear", status: "needs-auth" });
  });
});

// Final integration ruling: connector OAuth credentials live sealed under the host vault key, in host-private
// storage (0600), never readable as plain JSON and never in a Bot-readable location.
import { FileOAuthProvider } from "../../mcp/oauth";
import { vaultKeySync } from "../../secrets/crypto";
describe("OAuth credentials at rest (integration)", () => {
  it("are sealed with the vault key, 0600, and still round-trip", () => {
    const hostPrivate = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
    const file = path.join(hostPrivate, "mcp", "oauth", "linear.json");
    const p = new FileOAuthProvider(file, "linear", vaultKeySync(hostPrivate));
    p.saveTokens({ access_token: "at_super_secret_123", token_type: "bearer", refresh_token: "rt_secret_456" });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("at_super_secret_123");
    expect(raw).not.toContain("rt_secret_456");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new FileOAuthProvider(file, "linear", vaultKeySync(hostPrivate)).tokens()?.access_token).toBe("at_super_secret_123");
    expect(fs.statSync(path.join(hostPrivate, "vault.key")).mode & 0o777).toBe(0o400);
  });
});

// P5 review minor: the OAuth loopback falls back to another listed port; the redirect follows the port in use.
import { OAUTH_LOOPBACK_PORTS } from "../../mcp/oauth";
describe("OAuth loopback port fallback (host side)", () => {
  it("registers every fallback redirect and redirects to the port the Mac reported", () => {
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "lb-"));
    const p = new FileOAuthProvider(path.join(hp, "o.json"), "linear");
    expect(p.clientMetadata.redirect_uris).toEqual(OAUTH_LOOPBACK_PORTS.map((n) => `http://127.0.0.1:${n}/mcp/oauth/callback`));
    p.setLoopbackPort(OAUTH_LOOPBACK_PORTS[1]!);
    expect(p.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_LOOPBACK_PORTS[1]}/mcp/oauth/callback`);
    expect(() => p.setLoopbackPort(8080)).toThrow();
  });
});
