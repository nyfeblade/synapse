import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_LOGIN_VARS, ClaudeLoginEnvError, assertNoClaudeLogin } from "@synapse/shared";
import { CLAUDE_AUTH_SCRUB, applyAuthEnv, prepareAuthEnv, setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { explicitKeyEnv } from "../../auth/dev-auth";
import { ModelAccess } from "../../auth/model-access";
import { AuthProxy } from "../../auth/proxy";
import { buildBotEnv } from "../../brain/spawn-options";
import { claudeSpawnEnv, spawnClaudeProcess } from "../../claude/spawn";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

/** synapse-public, review round 3 (host side): S6 structure, D1, D2, the P2 follow-ups. */
const KEY = "sk-ant-api03-" + "T".repeat(80) + "rnd3";
const everyLogin = Object.fromEntries(CLAUDE_LOGIN_VARS.map((k) => [k, `stray-${k.length}`]));
const dirs: string[] = [];
let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
afterEach(async () => {
  setAuthSource(null); setAuthProxy(null);
  await proxy?.stop(); proxy = null; await api?.close(); api = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("S6: one env helper for every claude spawn, checked at runtime", () => {
  it("the box scrub list is the shared one, with Bedrock, Vertex and custom headers", () => {
    expect([...CLAUDE_AUTH_SCRUB]).toEqual([...CLAUDE_LOGIN_VARS]);
    for (const k of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_CUSTOM_HEADERS"]) expect(CLAUDE_LOGIN_VARS as readonly string[]).toContain(k);
  });

  it("claudeSpawnEnv refuses an env that still holds a login var (names it, never its value)", () => {
    expect(() => claudeSpawnEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_USE_BEDROCK: "1" }, { apiKey: KEY })).toThrow(ClaudeLoginEnvError);
    try { claudeSpawnEnv({ ANTHROPIC_AUTH_TOKEN: "secret-bearer-value" }, { apiKey: null }); } catch (e) {
      expect(String(e)).toContain("ANTHROPIC_AUTH_TOKEN");
      expect(String(e)).not.toContain("secret-bearer-value");
    }
    expect(claudeSpawnEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY }, { apiKey: KEY })).toMatchObject({ ANTHROPIC_API_KEY: KEY });
  });

  it("the spawn hook scrubs and checks what the SDK hands it (its own sdk entrypoint allowed)", () => {
    const seen: Record<string, string | undefined>[] = [];
    const spawnFn = ((_c: string, _a: string[], o: { env: Record<string, string | undefined> }) => { seen.push(o.env); return { pid: 1 }; }) as never;
    spawnClaudeProcess({ command: "claude", args: [], cwd: "/", env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, signal: new AbortController().signal } as never, { apiKey: KEY, spawnFn });
    expect(seen[0]).toMatchObject({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
    expect(() => spawnClaudeProcess({ command: "claude", args: [], cwd: "/", env: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: "x" }, signal: new AbortController().signal } as never, { apiKey: KEY, spawnFn })).toThrow(ClaudeLoginEnvError);
  });

  it("(d) every env the declared host files build holds no login var", () => {
    const cfg = tmpConfig();
    const shell = buildBotEnv({ cfg, botId: "b1", secrets: {} });
    assertNoClaudeLogin(shell, { apiKey: shell.ANTHROPIC_API_KEY });
    setAuthSource({ apiKey: () => KEY });
    const direct = applyAuthEnv<Record<string, string | undefined>>({ ...everyLogin, PATH: "/usr/bin" })!;
    assertNoClaudeLogin(direct, { apiKey: KEY });
    setAuthProxy({ url: "http://127.0.0.1:47802", issue: () => "sk-ant-api03-synproxy-t", revoke: () => {} });
    const p = prepareAuthEnv<Record<string, string | undefined>>({ ...everyLogin, PATH: "/usr/bin" }, { botId: "b1" });
    assertNoClaudeLogin(p.env!, { apiKey: "sk-ant-api03-synproxy-t" });
    const dev = explicitKeyEnv({ ...everyLogin, SYNAPSE_API_KEY: KEY });
    assertNoClaudeLogin(dev, { apiKey: KEY });
  });
});

describe("D1: retire-claude-login removes a Bot's stored login as that Bot, and unlinks a planted link", () => {
  it("runs rm as the owning user (runuser) for a Bot home, and unlinks a symlinked .credentials.json (never its target)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retire3-")); dirs.push(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "retire3-out-")); dirs.push(outside);
    const target = path.join(outside, "target.json");
    fs.writeFileSync(target, "{}");
    fs.mkdirSync(path.join(root, "home/bots/bot-a/.claude"), { recursive: true });
    fs.writeFileSync(path.join(root, "home/bots/bot-a/.claude/.credentials.json"), "x");
    fs.mkdirSync(path.join(root, "home/bots/bot-b/.claude"), { recursive: true });
    fs.symlinkSync(target, path.join(root, "home/bots/bot-b/.claude/.credentials.json"));
    // A stand-in runuser records who it would run as, then runs the command (the test can't switch users).
    const bin = path.join(root, "fakebin"); fs.mkdirSync(bin);
    const log = path.join(root, "runuser.log");
    fs.writeFileSync(path.join(bin, "runuser"), `#!/bin/sh\necho "$@" >> "${log}"\nshift 2; [ "$1" = "--" ] && shift; exec "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "stat"), `#!/bin/sh\necho botowner\n`, { mode: 0o755 });
    const r = spawnSync("bash", [path.resolve(__dirname, "../../../box/files/retire-claude-login"), root], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RETIRE_STAT: `${bin}/stat` } });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "home/bots/bot-a/.claude/.credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "home/bots/bot-b/.claude/.credentials.json"))).toBe(false); // the link went
    expect(fs.readFileSync(target, "utf8")).toBe("{}"); // its target stayed
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).toMatch(/-u botowner -- rm -f -- .*bot-a\/\.claude\/\.credentials\.json/);
  });
});

describe("D2: model access follows the key's generation", () => {
  it("clear() drops a probe in flight: its stale results never land", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma3-")); dirs.push(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = (async () => { await gate; return new Response("{}", { status: 404 }); }) as unknown as typeof fetch;
    const a = new ModelAccess({ dir, key: () => KEY, fetchFn });
    const stale = a.probe();
    expect(a.view().checking).toBe(true);
    a.clear(); // the key changed while the old probe ran
    expect(a.view().checking).toBe(false);
    release();
    await stale;
    expect(a.view()).toMatchObject({ checkedAt: null, models: {} });
  });
});

describe("P2 follow-ups: web searches metered; a key reset flushes unreported spend", () => {
  it("records web searches per grant and reports them with the unreported spend", async () => {
    api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "hi" }]], usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }, webSearches: 2 });
    const seen: { u: Record<string, number> }[] = [];
    proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, onUnreported: (_b, _m, u) => seen.push({ u }) });
    await proxy.start();
    const tok = proxy.issue({ botId: "b1" });
    const r = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) });
    await r.json();
    proxy.revoke(tok, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 });
    expect(seen[0]!.u.webSearchRequests).toBe(2);
  });

  it("revokeAll (a key reset) ends every grant but still reconciles each one when its process ends", async () => {
    api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "hi" }]] });
    const seen: string[] = [];
    proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, onUnreported: (b) => seen.push(String(b)) });
    await proxy.start();
    const tok = proxy.issue({ botId: "b1" });
    await (await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) })).json();
    proxy.revokeAll();
    const after = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401); // the grant is gone for requests
    await after.text();
    proxy.revoke(tok, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 });
    expect(seen).toEqual(["b1"]); // but its spend was still reported
  });
});

/**
 * Review round 3 re-review (P2 double counting). The SDK's total_cost_usd already includes web searches, so the CLI's
 * own reported web searches are subtracted like its tokens; a grant that ended with no report still records its web
 * searches; and grants a key reset retired are cleaned up (TTL and a bound) if their process never releases them.
 */
describe("P2 re-review: web searches reconciled like tokens; retired grants never pile up", () => {
  const ZERO_REPORT = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };
  const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  const call = async (tok: string) => (await fetch(`${proxy!.url}/v1/messages`, { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body })).json();
  type Seen = { b: string | null; u: Record<string, number> };
  const start = async (extra: Partial<ConstructorParameters<typeof AuthProxy>[0]> = {}) => {
    api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "hi" }]], usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }, webSearches: 2 });
    const seen: Seen[] = [];
    proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, onUnreported: (b, _m, u) => seen.push({ b, u: { ...u } }), ...extra });
    await proxy.start();
    return seen;
  };

  it("web searches the CLI reported (its total_cost_usd has them) are not reported again", async () => {
    const seen = await start();
    const tok = proxy!.issue({ botId: "b1" });
    await call(tok);
    proxy!.revoke(tok, { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 2 }); // a JSON answer: 5 in, 1 out
    expect(seen).toEqual([]);
  });

  it("only the web searches beyond the CLI's report are reported", async () => {
    const seen = await start();
    const tok = proxy!.issue({ botId: "b1" });
    await call(tok);
    await call(tok);
    proxy!.revoke(tok, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 2 });
    expect(seen.map((s) => s.u.webSearchRequests)).toEqual([2]);
    expect(seen[0]!.u.inputTokens).toBe(0);
  });

  it("a grant that ended with no report still records its web searches", async () => {
    const seen = await start();
    const tok = proxy!.issue({ botId: "b1" });
    await call(tok);
    proxy!.revoke(tok);
    expect(seen).toEqual([{ b: "b1", u: expect.objectContaining({ webSearchRequests: 2 }) }]);
  });

  it("a retired grant whose process never releases it is dropped after the TTL, its web searches recorded once", async () => {
    let now = 1_000_000;
    const seen = await start({ now: () => now, idleTtlMs: 60_000 });
    const tok = proxy!.issue({ botId: "b1" });
    await call(tok);
    proxy!.revokeAll();
    now += 61_000;
    proxy!.issue({ botId: "b2" }); // any later grant sweeps
    expect(proxy!.retiredCount).toBe(0);
    expect(seen.map((s) => s.u.webSearchRequests)).toEqual([2]);
    proxy!.revoke(tok, ZERO_REPORT); // a late release finds nothing: no double count
    expect(seen).toHaveLength(1);
  });

  it("retired grants are bounded", async () => {
    await start({ retiredMax: 5 });
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) proxy!.issue({ botId: `b${j}` });
      proxy!.revokeAll();
    }
    expect(proxy!.retiredCount).toBe(5);
  });

  it("meteredQuery reports the CLI's web searches (from modelUsage) with its tokens when the query ends", async () => {
    const { meteredQuery } = await import("../../usage/metered-query");
    const released: unknown[] = [];
    setAuthSource({ apiKey: () => KEY });
    setAuthProxy({ url: "http://127.0.0.1:47802", issue: () => "sk-ant-api03-synproxy-w", revoke: (_t, r) => released.push(r) });
    const result = { type: "result", session_id: "s", total_cost_usd: 0.05, modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 4, costUSD: 0.05 } } };
    const fake = (() => (async function* () { yield result; })()) as never;
    for await (const _m of meteredQuery({ purpose: "review", botId: "b1" }, { prompt: "x", options: { env: {} } }, fake)) { /* drain */ }
    expect(released).toEqual([{ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 4 }]);
  });
});
