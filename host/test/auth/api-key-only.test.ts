import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthMissingError, AuthProxyDownError, CLAUDE_AUTH_SCRUB, applyAuthEnv, credentialsReady, prepareAuthEnv, requireAuthProxy, setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { AuthStore, LEGACY_CLAUDE_TOKEN_FILE, authStoreFor, retireClaudeLogin, useSavedAuth } from "../../auth/auth-store";
import { classifyThrown } from "../../brain/errors";
import { buildBotEnv } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { meteredQuery, type QueryFn } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";

/**
 * synapse-public: the Anthropic API key is the only way Bots reach Claude. There is no sign-in mode, no Claude
 * subscription path, and an install that had one saved is routed to the API-key sign-in (its old mode and token are
 * never used). Every spawned env is scrubbed of every Claude login, and the key proxy always applies (fail closed).
 */
const KEY = "sk-ant-api03-" + "Q".repeat(80) + "d9Zk";
const OAT = "sk-ant-oat01-" + "t".repeat(60);
const stray: Record<string, string> = {
  PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
  ANTHROPIC_AUTH_TOKEN: "bearer", CLAUDE_CODE_REMOTE: "1", ANTHROPIC_UNIX_SOCKET: "/tmp/s", ANTHROPIC_PROFILE: "p", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "4",
  CLAUDE_CODE_SUBSCRIPTION_TYPE: "max", CLAUDE_CODE_RATE_LIMIT_TIER: "t",
};
const proxy = { url: "http://127.0.0.1:47802", issued: [] as string[], issue() { const t = `sk-ant-api03-synproxy-${this.issued.length}`; this.issued.push(t); return t; }, revoke() {} };
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-only-")); dirs.push(d); return d; };

afterEach(() => { setAuthSource(null); setAuthProxy(null); requireAuthProxy(false); proxy.issued = []; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("stray login env vars are always scrubbed", () => {
  it("every other way the CLI could sign in is gone; only our key is left", () => {
    setAuthSource({ apiKey: () => KEY });
    const env = applyAuthEnv<Record<string, string | undefined>>({ ...stray })!;
    for (const k of CLAUDE_AUTH_SCRUB) if (k !== "ANTHROPIC_API_KEY") expect(env[k], k).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("with no source (unit tests) a Claude login is still scrubbed", () => {
    const env = applyAuthEnv<Record<string, string | undefined>>({ ...stray })!;
    for (const k of CLAUDE_AUTH_SCRUB) if (k !== "ANTHROPIC_API_KEY") expect(env[k], k).toBeUndefined();
  });

  it("buildBotEnv never carries a Claude login, even when the host's own env has one", () => {
    const cfg = tmpConfig();
    const saved = { ...process.env };
    Object.assign(process.env, stray);
    try {
      const env = buildBotEnv({ cfg, botId: "b1" });
      for (const k of CLAUDE_AUTH_SCRUB) if (k !== "ANTHROPIC_API_KEY") expect(env[k], k).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toMatch(/-synproxy-none$/); // the dead sentinel (review round 2, S1), never the host's
    } finally {
      for (const k of Object.keys(stray)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("no key saved: the call fails (AuthMissingError), it never falls back to a Claude login", () => {
    setAuthSource({ apiKey: () => null });
    expect(credentialsReady()).toBe(false);
    expect(() => applyAuthEnv({ ...stray })).toThrow(AuthMissingError);
  });
});

describe("the box's key proxy always applies and fails closed", () => {
  it("required and down: a spawn throws AuthProxyDownError and never gets the key", () => {
    setAuthSource({ apiKey: () => KEY });
    requireAuthProxy(true);
    expect(() => prepareAuthEnv({ PATH: "/usr/bin" }, { botId: "b1" })).toThrow(AuthProxyDownError);
    const c = classifyThrown(new AuthProxyDownError());
    expect(c.code).toBe("BOT-E0421");
    expect(c.retryable).toBe(true);
  });

  it("meteredQuery refuses the call before any process starts", () => {
    setAuthSource({ apiKey: () => KEY });
    requireAuthProxy(true);
    const fake = vi.fn(() => (async function* () {})()) as unknown as QueryFn;
    expect(() => meteredQuery({ purpose: "review", botId: null }, { prompt: "x", options: { env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT } } }, fake)).toThrow(AuthProxyDownError);
    expect(fake).not.toHaveBeenCalled();
  });

  it("up: a spawn gets the proxy URL and a per-spawn token, never the key or a login", () => {
    setAuthSource({ apiKey: () => KEY });
    requireAuthProxy(true);
    setAuthProxy(proxy);
    const p = prepareAuthEnv<Record<string, string | undefined>>({ ...stray }, { botId: "b1" });
    expect(p.env!.ANTHROPIC_BASE_URL).toBe(proxy.url);
    expect(p.env!.ANTHROPIC_API_KEY).toBe(proxy.issued[0]);
    expect(p.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(p.env)).not.toContain(KEY.slice(13, 40));
    expect(JSON.stringify(p.env)).not.toContain(OAT);
  });
});

describe("SYNAPSE_AUTH_PROXY=off is a test-only switch", () => {
  it("honoured in a test run (VITEST set), ignored in production; there is no OAuth proxy option", () => {
    expect(loadConfig({ SYNAPSE_AUTH_PROXY: "off", VITEST: "true" }).authProxy.enabled).toBe(false);
    expect(loadConfig({ SYNAPSE_AUTH_PROXY: "off" }).authProxy.enabled).toBe(true);
    expect(loadConfig({}).authProxy.enabled).toBe(true);
    expect(loadConfig({ BOTS_AUTH_PROXY_OAUTH: "1", SYNAPSE_AUTH_PROXY_OAUTH: "1" }).authProxy).not.toHaveProperty("oauth");
    expect(loadConfig({})).not.toHaveProperty("tokenFile");
  });
});

describe("an install that had the Claude subscription saved goes to the API-key sign-in", () => {
  it("an old subscription-mode file with no key: no key, not ready, and no way to use the old mode", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mode: "subscription" }));
    const s = new AuthStore({ dir, key: randomBytes(32) });
    expect(s.apiKey()).toBeNull();
    expect(s).not.toHaveProperty("mode");
    expect(s).not.toHaveProperty("setMode");
    setAuthSource(s);
    expect(credentialsReady()).toBe(false);
    expect(() => applyAuthEnv({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT })).toThrow(AuthMissingError);
  });

  it("an old subscription-mode file with a key: the key is used from now on and the mode is dropped on the next save", () => {
    const dir = tmp();
    const key = randomBytes(32);
    new AuthStore({ dir, key }).setApiKey(KEY);
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), mode: "subscription" }));
    const again = new AuthStore({ dir, key });
    expect(again.apiKey()).toBe(KEY);
    again.setApiKey(KEY);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mode).toBeUndefined();
  });

  it("the box's old Claude login token file (inside hostPrivate) is removed; nothing outside it is touched", () => {
    const hostPrivate = tmp();
    fs.writeFileSync(path.join(hostPrivate, LEGACY_CLAUDE_TOKEN_FILE), OAT);
    const outside = path.join(tmp(), "claude-oauth-token");
    fs.writeFileSync(outside, OAT);
    expect(retireClaudeLogin({ hostPrivate }, { CLAUDE_TOKEN_FILE: outside })).toBe(true);
    expect(fs.existsSync(path.join(hostPrivate, LEGACY_CLAUDE_TOKEN_FILE))).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(retireClaudeLogin({ hostPrivate })).toBe(false);
  });
});

describe("evals and the conformance CLI use the box's saved API key through a proxy of their own", () => {
  it("a Claude process gets a loopback URL and a token, never the key or a login", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    authStoreFor(cfg).setApiKey(KEY);
    const done = await useSavedAuth(cfg);
    try {
      const p = prepareAuthEnv<Record<string, string | undefined>>({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT }, { botId: null });
      expect(p.env!.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(p.env!.ANTHROPIC_API_KEY).toMatch(/-synproxy-/);
      expect(p.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(p.env)).not.toContain(KEY.slice(13, 40));
      p.release();
    } finally { await done.stop(); }
  });

  it("no key saved (an old subscription install): calls are refused, never sent with a login", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    const done = await useSavedAuth(cfg);
    try {
      expect(() => prepareAuthEnv({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT }, { botId: null })).toThrow(AuthMissingError);
    } finally { await done.stop(); }
  });
});
