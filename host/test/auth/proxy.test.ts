import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProxy } from "../../auth/proxy";
import { AuthProxyDownError, applyAuthEnv, prepareAuthEnv, requireAuthProxy, setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { classifyThrown } from "../../brain/errors";
import { STR_AUTH } from "@synapse/shared";
import { meteredQuery, type QueryFn } from "../../usage/metered-query";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

const KEY = "sk-ant-api03-" + "Q".repeat(80) + "real";
const OAUTH = "sk-ant-oat01-" + "O".repeat(80) + "real";
let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; setAuthProxy(null); setAuthSource(null); requireAuthProxy(false); });

async function setup(o: { now?: () => number; idleTtlMs?: number; port?: number } = {}) {
  api = await startFakeAnthropic({ apiKey: KEY, bearer: OAUTH, script: [[{ text: "hello from upstream" }]] });
  proxy = new AuthProxy({ upstream: api.url, port: o.port ?? 0, credential: () => KEY, ...(o.now ? { now: o.now } : {}), ...(o.idleTtlMs ? { idleTtlMs: o.idleTtlMs } : {}) });
  await proxy.start();
  return { api, proxy };
}

const post = (url: string, headers: Record<string, string>, body: unknown = { model: "claude-haiku-4-5-20251001", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", input_schema: { type: "object" } }] }) =>
  fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body) });

describe("the auth proxy swaps a per-spawn proxy token for the real credential", () => {
  it("API key: the proxy token is checked and stripped, the real key goes upstream as x-api-key; SSE streams through unchanged", async () => {
    const { api, proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    expect(tok).not.toContain(KEY.slice(13, 40));
    const direct = await (await post(api.url, { "x-api-key": KEY })).text();
    const r = await post(proxy.url, { "x-api-key": tok, "anthropic-beta": "prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const viaProxy = await r.text();
    // Byte-identical apart from the per-request ids.
    expect(viaProxy.replace(/(msg_fake_|toolu_fake_)\d+/g, "$1N").replace(/req_fake_\d+/g, "req")).toBe(direct.replace(/(msg_fake_|toolu_fake_)\d+/g, "$1N").replace(/req_fake_\d+/g, "req"));
    const up = api.requests.at(-1)!;
    expect(up.apiKey).toBe(KEY);
    expect(up.authorization).toBeNull();
    // Headers the CLI relies on (prompt caching, betas, version) arrive untouched, and the body is the same bytes.
    expect(up.beta).toBe("prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11");
    expect(up.version).toBe("2023-06-01");
    expect(JSON.stringify(up.body)).toBe(JSON.stringify(api.requests.at(-2)!.body));
    expect(JSON.stringify(up.headers)).not.toContain(tok);
  });

  it("api-key-only: a proxy token presented as an OAuth bearer is refused; nothing goes upstream as a Claude login", async () => {
    const { api, proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    const before = api.requests.length;
    const r = await post(proxy.url, { authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" });
    expect(r.status).toBe(401);
    expect(api.requests.length).toBe(before);
    expect(tok).toMatch(/^sk-ant-api03-synproxy-/);
  });

  it("a missing, unknown, revoked or expired proxy token is refused with the API's 401 body, and nothing goes upstream", async () => {
    let t = 1_000;
    const { api, proxy } = await setup({ now: () => t, idleTtlMs: 60_000 });
    const before = api.requests.length;
    for (const h of [{}, { "x-api-key": "sk-ant-api03-guess" }, { "x-api-key": KEY }] as Record<string, string>[]) {
      const r = await post(proxy.url, h);
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    }
    const revoked = proxy.issue({ botId: "b1" });
    proxy.revoke(revoked);
    expect((await post(proxy.url, { "x-api-key": revoked })).status).toBe(401);
    const idle = proxy.issue({ botId: "b1" });
    expect((await post(proxy.url, { "x-api-key": idle })).status).toBe(200);
    t += 59_000;
    expect((await post(proxy.url, { "x-api-key": idle })).status).toBe(200); // use keeps it alive
    t += 61_000;
    expect((await post(proxy.url, { "x-api-key": idle })).status).toBe(401);
    expect(api.requests.length - before).toBe(2); // only the two good calls reached upstream
  });

  it("only the API is forwarded: other paths are refused", async () => {
    const { proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    const r = await fetch(`${proxy.url}/api/oauth/profile`, { headers: { "x-api-key": tok } });
    expect(r.status).toBe(404);
    expect((await fetch(`${proxy.url}/api/hello`, { method: "HEAD" })).status).toBe(200); // the CLI's reachability check
  });

  it("records usage per Bot from the stream (cache tokens included)", async () => {
    const { proxy } = await setup();
    const a = proxy.issue({ botId: "b1" });
    const b = proxy.issue({ botId: null });
    await (await post(proxy.url, { "x-api-key": a })).text();
    await (await post(proxy.url, { "x-api-key": a })).text();
    await (await post(proxy.url, { "x-api-key": b })).text();
    expect(proxy.usage("b1")).toEqual({ requests: 2, inputTokens: 24, outputTokens: 14, cacheReadTokens: 600, cacheWriteTokens: 80 });
    expect(proxy.usage(null)).toMatchObject({ requests: 1, inputTokens: 12 });
  });

  it("the upstream being down is a 502 in the API's error shape (the CLI retries it)", async () => {
    const { api, proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    await api.close();
    const r = await post(proxy.url, { "x-api-key": tok });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("a restart on the same port keeps the grants: a live token works again", async () => {
    const { proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    const port = new URL(proxy.url).port;
    await proxy.stop();
    await expect(post(`http://127.0.0.1:${port}`, { "x-api-key": tok })).rejects.toThrow();
    await proxy.start();
    expect(new URL(proxy.url).port).toBe(port);
    expect((await post(proxy.url, { "x-api-key": tok })).status).toBe(200);
  });

  it("if its server dies it comes back by itself on the same port", async () => {
    const { proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    proxy.crashForTest();
    await new Promise((r) => setTimeout(r, 400));
    expect((await post(proxy.url, { "x-api-key": tok })).status).toBe(200);
  });

  it("adds under 5 ms per request (median over 200 streamed requests, keep-alive both ways)", async () => {
    const { api, proxy } = await setup();
    const tok = proxy.issue({ botId: "b1" });
    const agent = new http.Agent({ keepAlive: true });
    const once = (url: string, key: string) => new Promise<number>((resolve, reject) => {
      const t0 = performance.now();
      const body = JSON.stringify({ model: "m", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }] });
      const req = http.request(`${url}/v1/messages`, { method: "POST", agent, headers: { "x-api-key": key, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on("end", () => resolve(performance.now() - t0));
      });
      req.on("error", reject);
      req.end(body);
    });
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    for (let i = 0; i < 20; i++) { await once(api.url, KEY); await once(proxy.url, tok); } // warm up
    const d: number[] = [];
    const p: number[] = [];
    for (let i = 0; i < 200; i++) { d.push(await once(api.url, KEY)); p.push(await once(proxy.url, tok)); }
    const overhead = median(p) - median(d);
    process.stdout.write(`auth proxy overhead: median direct ${median(d).toFixed(2)} ms, via proxy ${median(p).toFixed(2)} ms, overhead ${overhead.toFixed(2)} ms\n`);
    expect(overhead).toBeLessThan(5);
    agent.destroy();
  }, 60_000);
});

describe("the env a Claude process gets when the proxy is on", () => {
  const base: Record<string, string> = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAUTH, BOT_ID: "b1" };

  it("API key: ANTHROPIC_BASE_URL = the proxy, ANTHROPIC_API_KEY = a fresh proxy token, no real credential", async () => {
    const { proxy } = await setup();
    setAuthSource({ apiKey: () => KEY });
    setAuthProxy(proxy);
    const a = prepareAuthEnv(base, { botId: "b1" });
    const b = prepareAuthEnv(base, { botId: "b1" });
    expect(a.env!.ANTHROPIC_BASE_URL).toBe(proxy.url);
    expect(a.env!.ANTHROPIC_API_KEY).not.toBe(b.env!.ANTHROPIC_API_KEY); // per spawn
    expect(a.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(a.env)).not.toContain(KEY.slice(13, 40));
    expect(JSON.stringify(a.env)).not.toContain(OAUTH.slice(13, 40));
    expect((await post(proxy.url, { "x-api-key": a.env!.ANTHROPIC_API_KEY! })).status).toBe(200);
    a.release();
    expect((await post(proxy.url, { "x-api-key": a.env!.ANTHROPIC_API_KEY! })).status).toBe(401);
  });

  it("no host source builds a Claude env from applyAuthEnv (it can't revoke): only prepareAuthEnv, via meteredQuery", () => {
    const host = path.resolve(__dirname, "../..");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (["node_modules", "dist", "test"].includes(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
    const users = walk(host).filter((f) => !f.endsWith(path.join("auth", "auth-env.ts")) && /\bapplyAuthEnv\b/.test(fs.readFileSync(f, "utf8")));
    expect(users).toEqual([]);
    expect(typeof applyAuthEnv).toBe("function");
  });

  it("fail closed (security review, minor 2): the proxy required but not running refuses the spawn; the key never goes in the env", () => {
    setAuthSource({ apiKey: () => KEY });
    requireAuthProxy(true);
    expect(() => prepareAuthEnv(base, { botId: "b1" })).toThrow(AuthProxyDownError);
    const fake = (() => { throw new Error("must not spawn"); }) as unknown as QueryFn;
    expect(() => meteredQuery({ purpose: "turn", botId: "b1" }, { prompt: "x", options: { env: base } }, fake)).toThrow(AuthProxyDownError);
    expect(classifyThrown(new AuthProxyDownError())).toMatchObject({ trayTitle: STR_AUTH.proxyDownTitle, retryable: true });
    requireAuthProxy(false); // a test run with the proxy off: the env path
    expect(prepareAuthEnv(base, { botId: "b1" }).env!.ANTHROPIC_API_KEY).toBe(KEY);
  });

  it("no key saved: no proxy token is issued and the spawn fails (no Claude login to fall back to)", async () => {
    const { proxy } = await setup();
    setAuthSource({ apiKey: () => null });
    setAuthProxy(proxy);
    expect(() => prepareAuthEnv(base, { botId: "b1" })).toThrow(/API key/);
  });

  it("meteredQuery revokes the spawn's token when the query ends", async () => {
    const { proxy } = await setup();
    setAuthSource({ apiKey: () => KEY });
    setAuthProxy(proxy);
    let tok = "";
    const fake = ((p: { options: { env: Record<string, string> } }) => { tok = p.options.env.ANTHROPIC_API_KEY!; return (async function* () { yield { type: "result", subtype: "success" }; })(); }) as unknown as QueryFn;
    const q = meteredQuery({ purpose: "review", botId: null }, { prompt: "x", options: { env: base } }, fake);
    expect((await post(proxy.url, { "x-api-key": tok })).status).toBe(200);
    for await (const _m of q) { /* drain */ }
    expect((await post(proxy.url, { "x-api-key": tok })).status).toBe(401);
    const q2 = meteredQuery({ purpose: "review", botId: null }, { prompt: "x", options: { env: base } }, fake);
    q2.close();
    expect((await post(proxy.url, { "x-api-key": tok })).status).toBe(401);
  });
});
