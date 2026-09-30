import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES } from "@synapse/shared";
import { fakeConsent, startFakeGoogle, type FakeGoogle } from "../../google/fake-google";
import { GoogleAuth, GoogleAuthError } from "../../google/oauth";
import { GoogleStore } from "../../google/store";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-supersecretvalue" };

let g: FakeGoogle;
let dir: string;
let t: number;
let reconnects: number;
let changes: number;
const key = new Uint8Array(randomBytes(32));
const file = () => path.join(dir, "google", "account.json");
const mk = () => new GoogleAuth({ store: new GoogleStore(file(), key), endpoints: () => g.endpoints, now: () => t, onChange: () => { changes++; }, onNeedsReconnect: () => { reconnects++; } });

beforeEach(async () => {
  g = await startFakeGoogle();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-"));
  t = 1_000_000;
  reconnects = 0;
  changes = 0;
});
afterEach(() => g.close());

async function connect(a: GoogleAuth) {
  a.setClient(CLIENT.clientId, CLIENT.clientSecret);
  const url = a.start();
  const { code, state } = fakeConsent(g, url);
  return a.complete({ state, code });
}

describe("GoogleStore (sealed host-private storage)", () => {
  it("seals the client secret and tokens at rest (0600) and reads them back", () => {
    const s = new GoogleStore(file(), key);
    s.write({ client: CLIENT, tokens: { accessToken: "ya29.access-token-xyz", refreshToken: "1//refresh-token-xyz", expiresAt: 5, scope: "s" } });
    const raw = fs.readFileSync(file(), "utf8");
    expect(raw).not.toContain("supersecretvalue");
    expect(raw).not.toContain("access-token-xyz");
    expect(raw).not.toContain("refresh-token-xyz");
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    // 4.3b: a file from before per-account tokens reads back as the one account it was.
    expect(new GoogleStore(file(), key).read().accounts?.[0]?.tokens.refreshToken).toBe("1//refresh-token-xyz");
    expect(new GoogleStore(file(), new Uint8Array(randomBytes(32))).read()).toEqual({});
  });
});

describe("GoogleAuth (authorization code + PKCE on the loopback)", () => {
  it("starts with PKCE S256, offline access, forced consent, the minimal scopes and a random state", () => {
    const a = mk();
    expect(() => a.start()).toThrow(/client/i);
    a.setClient(CLIENT.clientId, CLIENT.clientSecret);
    const u = new URL(a.start());
    const u2 = new URL(a.start());
    expect(u.origin + u.pathname).toBe(g.endpoints.authUrl);
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({ client_id: CLIENT.clientId, redirect_uri: GOOGLE_REDIRECT_URI, response_type: "code", access_type: "offline", prompt: "consent", code_challenge_method: "S256" });
    expect(q.scope!.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(q.state).toMatch(/^[0-9a-f]{32}$/);
    expect(u2.searchParams.get("state")).not.toBe(q.state);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(q)).not.toContain(CLIENT.clientSecret);
    expect(a.status().state).toBe("waiting");
  });

  it("exchanges the code with the verifier, seals the tokens and reports the account and services", async () => {
    const a = mk();
    const url = (a.setClient(CLIENT.clientId, CLIENT.clientSecret), a.start());
    const { code, state } = fakeConsent(g, url);
    expect(a.owns(state)).toBe(true);
    expect(await a.complete({ state, code })).toEqual({ serverId: "google", status: "connected" });
    expect(b64url(createHash("sha256").update(g.state.lastVerifier!).digest())).toBe(new URL(url).searchParams.get("code_challenge"));
    const st = a.status();
    expect(st).toMatchObject({ state: "connected", email: "me@example.com", clientId: CLIENT.clientId, services: ["Gmail", "Calendar", "Drive"], redirectUri: GOOGLE_REDIRECT_URI });
    const view = JSON.stringify(st);
    expect(view).not.toContain(CLIENT.clientSecret);
    expect(view).not.toMatch(/fake-(at|rt)-/);
    expect(fs.readFileSync(file(), "utf8")).not.toMatch(/fake-(at|rt)-/);
    expect(changes).toBeGreaterThan(0);
  });

  it("state is single-use and expires", async () => {
    const a = mk();
    a.setClient(CLIENT.clientId, CLIENT.clientSecret);
    const { code, state } = fakeConsent(g, a.start());
    await a.complete({ state, code });
    expect(a.owns(state)).toBe(false);
    await expect(a.complete({ state, code })).rejects.toThrow(/expired/i);
    const late = fakeConsent(g, a.start());
    t += 12 * 60_000;
    expect(a.owns(late.state)).toBe(false);
    await expect(a.complete(late)).rejects.toThrow(/expired/i);
  });

  it("a cancelled consent leaves the account disconnected", async () => {
    const a = mk();
    a.setClient(CLIENT.clientId, CLIENT.clientSecret);
    const { state } = fakeConsent(g, a.start());
    expect(await a.complete({ state, error: "access_denied" })).toEqual({ serverId: "google", status: "needs-auth" });
    expect(a.status()).toMatchObject({ state: "disconnected", error: expect.stringMatching(/cancel/i) });
  });

  it("refreshes an expired access token automatically", async () => {
    const a = mk();
    await connect(a);
    const first = await a.accessToken();
    expect(await a.accessToken()).toBe(first);
    t += 3600_000;
    const second = await a.accessToken();
    expect(second).not.toBe(first);
    expect(g.state.requests.filter((r) => r === "POST /token")).toHaveLength(2);
  });

  it("invalid_grant marks the account needs-reconnect, notifies once, and fails with a clear error", async () => {
    const a = mk();
    await connect(a);
    g.state.refreshInvalid = true;
    t += 3600_000;
    await expect(a.accessToken()).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(a.accessToken()).rejects.toThrow(/sign-in expired/i);
    expect(a.status().state).toBe("needs-reconnect");
    expect(reconnects).toBe(1);
    // A fresh connect clears it.
    g.state.refreshInvalid = false;
    await connect(a);
    expect(a.status().state).toBe("connected");
  });

  it("disconnect revokes the token at Google and deletes the stored copy", async () => {
    const a = mk();
    await connect(a);
    const rt = [...g.state.refreshTokens][0]!;
    await a.disconnect();
    expect(g.state.revoked).toContain(rt);
    expect(a.status()).toMatchObject({ state: "disconnected", email: null });
    expect(new GoogleStore(file(), key).read().tokens).toBeUndefined();
    await expect(a.accessToken()).rejects.toThrow(/isn't connected/i);
  });

  it("changing the client ID drops tokens that belong to the old client", async () => {
    const a = mk();
    await connect(a);
    a.setClient("999-other.apps.googleusercontent.com", "GOCSPX-other");
    expect(a.status()).toMatchObject({ state: "disconnected", clientId: "999-other.apps.googleusercontent.com" });
    expect(() => a.setClient("  ", "x")).toThrow();
  });
});

describe("final secfix 5: the Google redirect URI follows the actual loopback port", () => {
  it("start() and the token exchange use the port the Mac actually bound (like OAUTH_REDIRECT)", async () => {
    let port = 47823;
    const bodies: string[] = [];
    const a = new GoogleAuth({
      store: new GoogleStore(file(), key), endpoints: () => g.endpoints, now: () => t,
      redirectUri: () => `http://127.0.0.1:${port}/mcp/oauth/callback`,
      fetch: async (u, init) => { if (String(u).endsWith("/token")) bodies.push(String(init?.body ?? "")); return fetch(u, init); },
    });
    a.setClient(CLIENT.clientId, CLIENT.clientSecret);
    port = 47825;
    const url = a.start();
    expect(new URL(url).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47825/mcp/oauth/callback");
    port = 47824; // a later port change doesn't break a sign-in already under way
    const { code, state } = fakeConsent(g, url);
    await a.complete({ state, code });
    expect(new URLSearchParams(bodies[0]!).get("redirect_uri")).toBe("http://127.0.0.1:47825/mcp/oauth/callback");
    expect(a.status().redirectUri).toBe("http://127.0.0.1:47824/mcp/oauth/callback");
  });

  it("McpOAuth exposes the redirect for the port it was told about", async () => {
    const { McpOAuth } = await import("../../mcp/oauth");
    const o = new McpOAuth({ dir, registry: {} as never, now: () => t, onWaiting: () => {}, onAuthorized: async () => {} });
    expect(o.redirectUrl).toBe("http://127.0.0.1:47823/mcp/oauth/callback");
    o.setLoopbackPort(47825);
    expect(o.redirectUrl).toBe("http://127.0.0.1:47825/mcp/oauth/callback");
  });
});

describe("final secfix 6: the Google store is sealed with the HKDF subkey bots/google/v1", () => {
  it("opens a legacy file sealed with the raw vault key, and re-seals it with the subkey on the next write", async () => {
    const { subkey } = await import("../../secrets/crypto");
    const sub = subkey(key, "bots/google/v1");
    new GoogleStore(file(), key).write({ client: CLIENT, publishing: "testing" });
    const s = new GoogleStore(file(), sub, key);
    expect(s.read()).toMatchObject({ client: CLIENT, publishing: "testing" });
    s.write({ publishing: "production" });
    expect(new GoogleStore(file(), key).read()).toEqual({});
    expect(new GoogleStore(file(), sub).read()).toMatchObject({ client: CLIENT, publishing: "production" });
  });

  it("the host app's Google store uses the subkey, not the raw vault key", async () => {
    const { createHostApp } = await import("../../app");
    const { tmpConfig } = await import("../helpers");
    const { subkey, vaultKeySync } = await import("../../secrets/crypto");
    const cfg = tmpConfig();
    const app = await createHostApp(cfg);
    try {
      app.services.phase5.google.auth.setClient(CLIENT.clientId, CLIENT.clientSecret);
      const f = path.join(cfg.hostPrivate, "google", "account.json");
      const vk = vaultKeySync(cfg.hostPrivate);
      expect(new GoogleStore(f, vk).read()).toEqual({});
      expect(new GoogleStore(f, subkey(vk, "bots/google/v1")).read()).toMatchObject({ client: CLIENT });
    } finally { await app.close(); }
  });
});
