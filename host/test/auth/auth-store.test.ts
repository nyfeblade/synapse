import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore, LEGACY_CLAUDE_TOKEN_FILE, authStoreFor, retireClaudeLogin } from "../../auth/auth-store";
import { tmpConfig } from "../helpers";
import { AuthMissingError, CLAUDE_AUTH_SCRUB, applyAuthEnv, credentialsReady, prepareAuthEnv, requireAuthProxy, setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { meteredQuery, type QueryFn } from "../../usage/metered-query";

const KEY = "sk-ant-api03-" + "A".repeat(80) + "wxyz";
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-")); dirs.push(d); return d; };
const allFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
afterEach(() => { setAuthSource(null); setAuthProxy(null); requireAuthProxy(false); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("AuthStore: the API key is the only sign-in, kept encrypted", () => {
  it("starts with no key", () => {
    const s = new AuthStore({ dir: tmp(), key: randomBytes(32) });
    expect(s.apiKey()).toBeNull();
    expect(s.masked()).toBeNull();
  });

  it("stores the key sealed: no file on disk holds it in plaintext, and a new store (restart) opens it", () => {
    const dir = tmp();
    const key = randomBytes(32);
    const s = new AuthStore({ dir, key, now: () => 1234 });
    s.setApiKey(KEY);
    for (const f of allFiles(dir)) {
      const raw = fs.readFileSync(f, "utf8");
      expect(raw).not.toContain(KEY);
      expect(raw).not.toContain(KEY.slice(13, 40));
      expect(fs.statSync(f).mode & 0o077).toBe(0);
    }
    const again = new AuthStore({ dir, key });
    expect(again.apiKey()).toBe(KEY);
    expect(again.masked()).toEqual({ masked: "sk-ant-…wxyz", savedAt: 1234 });
  });

  it("migration: a file written in the old subscription mode keeps its key (used from now on) and drops the mode", () => {
    const dir = tmp();
    const key = randomBytes(32);
    const s = new AuthStore({ dir, key, now: () => 99 });
    s.setApiKey(KEY);
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), mode: "subscription" }));
    const again = new AuthStore({ dir, key });
    expect(again.apiKey()).toBe(KEY);
    again.setApiKey(KEY); // the next save writes no mode
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mode).toBeUndefined();
  });

  it("migration: an old subscription-mode file with no key means no key (Bots wait for one)", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mode: "subscription" }));
    expect(new AuthStore({ dir, key: randomBytes(32) }).apiKey()).toBeNull();
  });

  it("a different vault key can't open it (treated as no key)", () => {
    const dir = tmp();
    new AuthStore({ dir, key: randomBytes(32) }).setApiKey(KEY);
    expect(new AuthStore({ dir, key: randomBytes(32) }).apiKey()).toBeNull();
  });

  it("refuses what is not an API key, a Claude login token included", () => {
    const s = new AuthStore({ dir: tmp(), key: randomBytes(32) });
    expect(() => s.setApiKey("hello")).toThrow(/API key/);
    expect(() => s.setApiKey("sk-ant-oat01-" + "B".repeat(60))).toThrow(/API key/);
    expect(s.apiKey()).toBeNull();
  });

  it("the spawn-key part changes when the key changes, and never contains the key", () => {
    const s = new AuthStore({ dir: tmp(), key: randomBytes(32) });
    const a = s.spawnKeyPart();
    s.setApiKey(KEY);
    const b = s.spawnKeyPart();
    s.setApiKey(KEY.replace("wxyz", "wxy0"));
    const c = s.spawnKeyPart();
    expect(new Set([a, b, c]).size).toBe(3);
    for (const k of [a, b, c]) expect(k).not.toContain(KEY.slice(13, 30));
  });

  it("clearing the key removes it", () => {
    const dir = tmp();
    const key = randomBytes(32);
    const s = new AuthStore({ dir, key });
    s.setApiKey(KEY);
    s.clearApiKey();
    expect(s.apiKey()).toBeNull();
    expect(new AuthStore({ dir, key }).apiKey()).toBeNull();
  });

  it("migration: the box's old Claude login token file is removed at boot", () => {
    const hostPrivate = tmp();
    fs.writeFileSync(path.join(hostPrivate, LEGACY_CLAUDE_TOKEN_FILE), "sk-ant-oat01-old");
    expect(retireClaudeLogin({ hostPrivate })).toBe(true);
    expect(fs.existsSync(path.join(hostPrivate, LEGACY_CLAUDE_TOKEN_FILE))).toBe(false);
    expect(retireClaudeLogin({ hostPrivate })).toBe(false);
  });
});

describe("applyAuthEnv: every model call gets the API key and nothing else", () => {
  const logins: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-tok", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    ANTHROPIC_AUTH_TOKEN: "bearer", CLAUDE_CODE_REMOTE: "1", ANTHROPIC_UNIX_SOCKET: "/tmp/s", ANTHROPIC_PROFILE: "p", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "4",
  };
  const base: Record<string, string> = { PATH: "/usr/bin", BOT_ID: "b1", ...logins };

  it("with no source (unit tests) the env still loses every Claude login", () => {
    const env = applyAuthEnv<Record<string, string | undefined>>({ ...base, ANTHROPIC_API_KEY: "x" })!;
    for (const k of Object.keys(logins)) expect(env[k]).toBeUndefined();
    expect(env.BOT_ID).toBe("b1");
    expect(credentialsReady()).toBe(false);
  });

  it("ANTHROPIC_API_KEY is the saved key; every other sign-in is scrubbed; the caller's env object is not changed", () => {
    setAuthSource({ apiKey: () => KEY });
    const input: Record<string, string> = { ...base, ANTHROPIC_API_KEY: "stray" };
    const env = applyAuthEnv<Record<string, string | undefined>>(input)!;
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    for (const k of Object.keys(logins)) expect(env[k]).toBeUndefined();
    expect(env.BOT_ID).toBe("b1");
    expect(input.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-tok");
    expect(credentialsReady()).toBe(true);
  });

  it("no key saved fails loudly; nothing falls back to a Claude login", () => {
    setAuthSource({ apiKey: () => null });
    expect(() => applyAuthEnv({ ...base })).toThrow(AuthMissingError);
    expect(credentialsReady()).toBe(false);
  });

  it("the scrub list covers every env the CLI reads a Claude login from", () => {
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_REMOTE"]) {
      expect(CLAUDE_AUTH_SCRUB).toContain(k);
    }
  });

  it("meteredQuery (the one place every host model call goes through) applies the current key to each call's env", () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    const fake = vi.fn((p: { options?: { env?: Record<string, string | undefined> } }) => { seen.push(p.options?.env); return (async function* () {})(); }) as unknown as QueryFn;
    let key = KEY;
    setAuthSource({ apiKey: () => key });
    const env = { ...base }; // a helper built once at startup (reviewer, memory, …) reuses this object for every call
    meteredQuery({ purpose: "review", botId: null }, { prompt: "x", options: { env } }, fake);
    key = KEY.replace("wxyz", "wxy0");
    meteredQuery({ purpose: "extraction", botId: null }, { prompt: "x", options: { env } }, fake);
    expect(seen[0]?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(seen[1]?.ANTHROPIC_API_KEY).toBe(key);
    for (const s of seen) expect(s?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
