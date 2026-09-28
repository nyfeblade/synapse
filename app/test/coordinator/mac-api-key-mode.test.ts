/**
 * synapse-public on the Mac: the Bots' claude signs in only with the Anthropic API key. A wrapped claude run never holds
 * the key: the coordinator's loopback key proxy hands each run a token of its own, revoked when the run ends, and claude
 * runs are refused if the proxy can't start. No Claude login ever reaches a run, and an old install's Bots-only login
 * token file (in the app's data folder only) is removed. HOME is a temp dir; claude is a stub.
 */
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAC_CLAUDE_API_KEY_MSG, MAC_CLAUDE_AUTH_UNKNOWN_MSG, MAC_CLAUDE_PROXY_DOWN_MSG } from "@synapse/shared";
import { LEGACY_MAC_CLAUDE_TOKEN_FILE, retireMacClaudeLogin } from "../../src/coordinator/local-exec/login-scrub";
import { MAC_API_KEY_FILE, clearMacApiKey, loadMacApiKey, saveMacApiKey } from "../../src/coordinator/local-exec/mac-api-key";
import { MAC_PROXY_TOKEN_PREFIX, MacKeyProxy } from "../../src/coordinator/local-exec/mac-key-proxy";
import { MacUsageQueue } from "../../src/coordinator/local-exec/mac-usage-queue";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { POLICY_KEY_FILE, loadPolicyKey } from "../../src/coordinator/local-exec/policy-key";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";
import { createLocalDaemon, disposeScratchPolicy, hostClaudeAuth } from "../../src/coordinator/local-exec/wiring";

let home: string;
let userData: string;
let bin: string;
let key: Buffer;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mak-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  const k = loadPolicyKey(userData);
  if (!k.ok) throw new Error("no key");
  key = k.key;
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${FIXED_PATH}`;
});
afterEach(() => {
  disposeScratchPolicy();
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const API_KEY = "sk-ant-api03-AbCdEf_123-xyz_0123456789abcdefghijKLMNOP";
const OAT = "sk-ant-oat01-" + "m".repeat(60);
const proxies: MacKeyProxy[] = [];
afterEach(async () => { for (const p of proxies.splice(0)) await p.stop(); });
/** Review fix 7: never the real api.anthropic.com in a test; the default upstream is a closed local port. */
const CLOSED = "http://127.0.0.1:9";
type ProxyOpts = Partial<ConstructorParameters<typeof MacKeyProxy>[0]>;
const proxyFor = (o: ProxyOpts = {}) => {
  const p = new MacKeyProxy({ key: () => loadMacApiKey(userData, key), upstream: CLOSED, ...o });
  proxies.push(p);
  return p;
};
type Auth = { keySaved: boolean; spend: { ok: boolean; message: string | null } };
const answer = (_mode: "api-key", o: Partial<Auth> = {}): Auth => ({ keySaved: true, spend: { ok: true, message: null }, ...o });
const exec = (mode: "api-key" | Auth | null | (() => Promise<Auth | null>), keyProxy: MacKeyProxy = proxyFor()) => new LocalExecutor({
  root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, keyProxy,
  claudeAuth: typeof mode === "function" ? mode : async () => (typeof mode === "string" ? answer(mode) : mode),
});
async function sh(ex: LocalExecutor, command: string): Promise<string> {
  const c: string[] = [];
  await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, x) => c.push(x) });
  return c.join("");
}

describe("the Mac's copy of the API key", () => {
  it("is stored encrypted (never in the clear), 0600, in the data folder; wrong key → null; Remove clears it", () => {
    saveMacApiKey(userData, key, API_KEY);
    const f = path.join(userData, MAC_API_KEY_FILE);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f).includes(Buffer.from(API_KEY.slice(13, 40)))).toBe(false);
    expect(loadMacApiKey(userData, key)).toBe(API_KEY);
    expect(loadMacApiKey(userData, Buffer.alloc(32, 7))).toBeNull();
    clearMacApiKey(userData);
    expect(loadMacApiKey(userData, key)).toBeNull();
  });

  it("migration: the coordinator removes an old install's Bots-only login token file from the app's data folder, and no sign-in command is answered", async () => {
    fs.writeFileSync(path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE), "old-sealed-token", { mode: 0o600 });
    const w = createLocalDaemon({ userData, log: () => {}, heartbeatMs: 3_600_000, call: async () => ({}) });
    expect(fs.existsSync(path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE))).toBe(false);
    for (const c of ["getMacClaudeStatus", "macClaudeSignIn", "macClaudeSignOut"]) expect((await w.daemon.intercept(c, {})).handled).toBe(false);
    await w.keyProxy.stop();
  });

  it("migration: a link in userData is removed itself (round 3, D3), never followed; nothing outside (like ~/.claude) is touched", () => {
    const outside = path.join(home, ".claude");
    fs.mkdirSync(outside, { recursive: true });
    const target = path.join(outside, ".credentials.json");
    fs.writeFileSync(target, "user's own login");
    fs.symlinkSync(target, path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE));
    expect(retireMacClaudeLogin(userData)).toBe(true); // the link itself
    expect(fs.existsSync(path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE))).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("user's own login");
    expect(retireMacClaudeLogin(userData)).toBe(false); // none
  });

  it("review fix 3: hostClaudeAuth asks the host for every claude run (no cache); no answer is null", async () => {
    let n = 0;
    let reply: unknown = { keySaved: true, spend: { ok: true, message: null } };
    const ask = hostClaudeAuth(async (c, a) => { n++; expect(c).toBe("macClaudeAuth"); expect(a).toEqual({ botId: "b1" }); if (reply instanceof Error) throw reply; return reply; });
    expect(await ask("b1")).toEqual({ keySaved: true, spend: { ok: true, message: null } });
    reply = { keySaved: false, spend: { ok: true, message: null } };
    expect(await ask("b1")).toMatchObject({ keySaved: false });
    // Review round 3: the Savings cache TTL comes through (anything else is dropped, so the run keeps 1h).
    reply = { keySaved: true, spend: { ok: true, message: null }, promptCacheTtl: "5m" };
    expect((await ask("b1"))?.promptCacheTtl).toBe("5m");
    reply = { keySaved: true, spend: { ok: true, message: null }, promptCacheTtl: "2d" };
    expect((await ask("b1"))?.promptCacheTtl).toBeUndefined();
    n -= 2;
    reply = new Error("offline");
    expect(await ask("b1")).toBeNull();
    reply = null;
    expect(await ask("b1")).toBeNull();
    expect(n).toBe(4);
  });

  it("review fix 4: the coordinator saves the Mac copy, creating the permission key on demand (as the policy store does)", async () => {
    const w = createLocalDaemon({ userData, log: () => {}, heartbeatMs: 3_600_000, call: async () => ({}) });
    fs.rmSync(path.join(userData, POLICY_KEY_FILE));
    expect(await w.macKey.save(API_KEY)).toEqual({ ok: true });
    const k = loadPolicyKey(userData);
    expect(k.ok && loadMacApiKey(userData, k.key)).toBe(API_KEY);
    expect(w.macKey.has()).toBe(true);
    w.macKey.clear();
    expect(w.macKey.has()).toBe(false);
    await w.keyProxy.stop();
  });

  it("review fix 4: a key file that can't be trusted: the save says why instead of failing silently", async () => {
    const w = createLocalDaemon({ userData, log: () => {}, heartbeatMs: 3_600_000, call: async () => ({}) });
    fs.chmodSync(path.join(userData, POLICY_KEY_FILE), 0o644); // readable by others: not trusted
    const r = await w.macKey.save(API_KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    await w.keyProxy.stop();
  });
});

describe("review fixes: the Mac key proxy's limits and metering", () => {
  const upstream = async (handler: http.RequestListener) => {
    const s = http.createServer(handler);
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
    return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
  };

  it("fix 6: grant() is bound to a Bot and refused with no key", async () => {
    const p = proxyFor();
    expect(await p.grant({ botId: "b1" })).toEqual({ refused: "no-key" });
    saveMacApiKey(userData, key, API_KEY);
    const g = await p.grant({ botId: "b1" });
    expect("token" in g).toBe(true);
  });

  it("fix 5: a request body over the cap is refused (413) and nothing goes upstream", async () => {
    saveMacApiKey(userData, key, API_KEY);
    let hit = 0;
    const up = await upstream((q, r) => { hit++; q.resume(); r.end("{}"); });
    try {
      const p = proxyFor({ upstream: up.url, maxBodyBytes: 1024 });
      const g = await p.grant({ botId: "b1" });
      if (!("token" in g)) throw new Error("no grant");
      const r = await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token, "content-type": "application/json" }, body: "x".repeat(4096) });
      expect(r.status).toBe(413);
      expect(hit).toBe(0);
    } finally { await up.close(); }
  });

  it("fix 5: an upstream that never answers times out (504) instead of hanging the run", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const up = await upstream((q) => { q.resume(); /* never answers */ });
    try {
      const p = proxyFor({ upstream: up.url, upstreamTimeoutMs: 150 });
      const g = await p.grant({ botId: "b1" });
      if (!("token" in g)) throw new Error("no grant");
      const r = await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" });
      expect(r.status).toBe(504);
    } finally { await up.close(); }
  });

  it("fix 1: usage is read off streamed and plain /v1/messages answers and reported per Bot", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 1 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const up = await upstream((q, r) => {
      q.resume();
      if (String(q.url).includes("stream")) { r.writeHead(200, { "content-type": "text/event-stream" }); for (const e of sse) r.write(e); r.end(); }
      else r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "claude-haiku-4-5", usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    });
    const seen: unknown[] = [];
    try {
      const p = proxyFor({ upstream: up.url, onUsage: (u) => seen.push(u) });
      const g = await p.grant({ botId: "b1" });
      if (!("token" in g)) throw new Error("no grant");
      await (await fetch(`${g.baseUrl}/v1/messages?stream`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" })).text();
      await (await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" })).text();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([
        { botId: "b1", model: "claude-sonnet-5", usage: { inputTokens: 100, outputTokens: 42, cacheReadTokens: 2000, cacheWriteTokens: 300 } },
        { botId: "b1", model: "claude-haiku-4-5", usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      ]);
    } finally { await up.close(); }
  });
});

describe.runIf(process.platform === "darwin")("live: a Bot can never read the key", () => {
  it("RED probe: `echo claude; printenv ANTHROPIC_API_KEY` prints only this run's proxy token, never the key or a Claude login", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const out = await sh(exec("api-key"), "echo claude; printenv ANTHROPIC_API_KEY; printenv CLAUDE_CODE_OAUTH_TOKEN; env | grep -i anthropic");
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(API_KEY.slice(13, 40));
    expect(out).not.toContain(OAT);
    expect(out).toContain(MAC_PROXY_TOKEN_PREFIX);
    expect(out).toMatch(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
  });

  it("the token works through the proxy during the run and is dead after it; only the CLI's model paths pass", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const seen: { key: string | undefined; path: string | undefined }[] = [];
    const up = http.createServer((q, r) => { seen.push({ key: q.headers["x-api-key"] as string | undefined, path: q.url }); q.resume(); r.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}"); });
    await new Promise<void>((res) => up.listen(0, "127.0.0.1", () => res()));
    try {
      const p = proxyFor({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}` });
      const call = `/usr/bin/curl -s -X POST -H "x-api-key: $ANTHROPIC_API_KEY" -d '{}' "$ANTHROPIC_BASE_URL/v1/messages?beta=true"`;
      const out = await sh(exec("api-key", p), `echo claude >/dev/null; ${call}; echo; printf 'TOK=%s URL=%s' "$ANTHROPIC_API_KEY" "$ANTHROPIC_BASE_URL"`);
      expect(out).toContain("{\"ok\":true}");
      expect(seen).toEqual([{ key: API_KEY, path: "/v1/messages?beta=true" }]);
      const tok = /TOK=(\S+)/.exec(out)![1]!;
      const base = /URL=(\S+)/.exec(out)![1]!;
      expect((await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": tok }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/v1/models`, { headers: { "x-api-key": tok } })).status).toBe(404);
      expect(seen).toHaveLength(1);
    } finally { up.close(); }
  });

  it("the key proxy can't start: claude runs are refused and claude never starts (fail closed)", async () => {
    saveMacApiKey(userData, key, API_KEY);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho CLAUDE-RAN\n", { mode: 0o755 });
    const out = await sh(exec("api-key", proxyFor({ listen: async () => { throw new Error("EADDRNOTAVAIL"); } })), "claude -p hi");
    expect(out).toContain(MAC_CLAUDE_PROXY_DOWN_MSG);
    expect(out).not.toContain("CLAUDE-RAN");
  });

  it("fix 1: over budget the run is refused with the budget's message, before any token is granted; claude never starts", async () => {
    saveMacApiKey(userData, key, API_KEY);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho CLAUDE-RAN\n", { mode: 0o755 });
    const p = proxyFor();
    let granted = 0;
    const grant = p.grant.bind(p);
    p.grant = async (g) => { granted++; return grant(g); };
    const out = await sh(exec(answer("api-key", { spend: { ok: false, message: "Over this month's $10 budget." } }), p), "claude -p hi");
    expect(out).toContain("Over this month's $10 budget.");
    expect(out).not.toContain("CLAUDE-RAN");
    expect(granted).toBe(0);
  });

  it("fix 3: the host can't be asked: the run is refused and no Claude login is ever injected", async () => {
    saveMacApiKey(userData, key, API_KEY);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "RAN TOKEN=[$CLAUDE_CODE_OAUTH_TOKEN]"\n`, { mode: 0o755 });
    const out = await sh(exec(null), "claude -p hi");
    expect(out).toContain(MAC_CLAUDE_AUTH_UNKNOWN_MSG);
    expect(out).not.toContain("RAN");
    expect(out).not.toContain(OAT);
  });

  it("fix 6: the host has no key saved: a stale Mac copy doesn't run claude", async () => {
    saveMacApiKey(userData, key, API_KEY);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho CLAUDE-RAN\n", { mode: 0o755 });
    const out = await sh(exec(answer("api-key", { keySaved: false })), "claude -p hi");
    expect(out).toContain(MAC_CLAUDE_API_KEY_MSG);
    expect(out).not.toContain("CLAUDE-RAN");
  });

  it("no key on this Mac: the run stops and points at Settings → Account; it never falls back to a Claude login", async () => {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "RAN TOKEN=[$CLAUDE_CODE_OAUTH_TOKEN]"\n`, { mode: 0o755 });
    const out = await sh(exec("api-key"), "claude -p hi");
    expect(out).toContain(MAC_CLAUDE_API_KEY_MSG);
    expect(MAC_CLAUDE_API_KEY_MSG).toContain("Settings → Account");
    expect(out).not.toContain("RAN");
  });
});

describe.runIf(process.platform === "darwin")("live: no Claude login ever reaches a wrapped claude", () => {
  beforeEach(() => fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "KEY=[$ANTHROPIC_API_KEY] TOKEN=[$CLAUDE_CODE_OAUTH_TOKEN] BEARER=[$ANTHROPIC_AUTH_TOKEN]"\n`, { mode: 0o755 }));
  it("a stray login in the app's own env and an old token file: claude gets only this run's proxy token", async () => {
    saveMacApiKey(userData, key, API_KEY);
    fs.writeFileSync(path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE), OAT, { mode: 0o600 });
    const prev = { t: process.env.CLAUDE_CODE_OAUTH_TOKEN, b: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = OAT;
    process.env.ANTHROPIC_AUTH_TOKEN = OAT;
    try {
      const out = await sh(exec("api-key"), "claude -p hi");
      expect(out).toContain(`KEY=[${MAC_PROXY_TOKEN_PREFIX}`);
      expect(out).toContain("TOKEN=[] BEARER=[]");
      expect(out).not.toContain(OAT);
    } finally {
      if (prev.t === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.t;
      if (prev.b === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prev.b;
    }
  });
  it("no host answer wiring at all (claudeAuth absent): refused, never run without the key path", async () => {
    const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, keyProxy: proxyFor() });
    const out = await sh(ex, "claude -p hi");
    expect(out).toContain(MAC_CLAUDE_AUTH_UNKNOWN_MSG);
    expect(out).not.toContain("KEY=");
  });
});

describe("re-review fixes: every answer is metered, mid-run budget, a durable usage queue", () => {
  const upstream = async (handler: http.RequestListener) => {
    const s = http.createServer(handler);
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
    return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
  };
  const start = (input: number) => `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: input, output_tokens: 1 } } })}\n\n`;
  const delta = (out: number) => `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: out } })}\n\n`;
  const grantFor = async (p: MacKeyProxy) => { const g = await p.grant({ botId: "b1" }); if (!("token" in g)) throw new Error("no grant"); return g; };

  it("A: a client asking for gzip still gets metered (the proxy asks upstream for identity)", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const seenEnc: (string | undefined)[] = [];
    const up = await upstream((q, r) => {
      q.resume();
      const enc = q.headers["accept-encoding"] as string | undefined;
      seenEnc.push(enc);
      const body = start(50) + delta(9);
      if (enc && /gzip/.test(enc)) { r.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); r.end(zlib.gzipSync(body)); }
      else { r.writeHead(200, { "content-type": "text/event-stream" }); r.end(body); }
    });
    const seen: unknown[] = [];
    try {
      const p = proxyFor({ upstream: up.url, onUsage: (u) => seen.push(u) });
      const g = await grantFor(p);
      await (await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token, "accept-encoding": "gzip, br" }, body: "{}" })).text();
      await new Promise((r) => setTimeout(r, 20));
      expect(seenEnc).toEqual(["identity"]);
      expect(seen).toEqual([{ botId: "b1", model: "claude-sonnet-5", usage: { inputTokens: 50, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 } }]);
    } finally { await up.close(); }
  });

  it("B: a stream aborted after message_start still records its input tokens, exactly once", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const up = await upstream((q, r) => { q.resume(); r.writeHead(200, { "content-type": "text/event-stream" }); r.write(start(777)); /* then hangs */ });
    const seen: unknown[] = [];
    try {
      const p = proxyFor({ upstream: up.url, onUsage: (u) => seen.push(u) });
      const g = await grantFor(p);
      const ac = new AbortController();
      const res = await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}", signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read(); // message_start arrived
      ac.abort();
      await reader.read().catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([{ botId: "b1", model: "claude-sonnet-5", usage: { inputTokens: 777, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }]);
    } finally { await up.close(); }
  });

  it("C: the budget is rechecked per request (cached about 30 s); once over, 429 with the budget message and nothing forwarded", async () => {
    saveMacApiKey(userData, key, API_KEY);
    let hits = 0;
    const up = await upstream((q, r) => { hits++; q.resume(); r.writeHead(200, { "content-type": "application/json" }).end("{}"); });
    let t = 1_000_000;
    let asks = 0;
    let verdict = { ok: true, message: null as string | null };
    try {
      const p = proxyFor({ upstream: up.url, now: () => t, allow: async () => { asks++; return verdict; } });
      const g = await grantFor(p);
      const post = () => fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect(asks).toBe(0); // the answer the run was granted on stands for the cache window
      verdict = { ok: false, message: "Over this month's $10 budget." };
      t += 10_000;
      expect((await post()).status).toBe(200); // still inside the cache window
      t += 25_000;
      const r = await post();
      expect(r.status).toBe(429);
      expect(await r.text()).toContain("Over this month's $10 budget.");
      expect(hits).toBe(3);
      expect(asks).toBe(1);
    } finally { await up.close(); }
  });

  it("C: the host can't be asked mid-run: refused (fail closed), nothing forwarded", async () => {
    saveMacApiKey(userData, key, API_KEY);
    let hits = 0;
    const up = await upstream((q, r) => { hits++; q.resume(); r.end("{}"); });
    try {
      let t = 1_000_000;
      const p = proxyFor({ upstream: up.url, now: () => t, allow: async () => null });
      const g = await grantFor(p);
      t += 31_000;
      const r = await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" });
      expect(r.status).toBe(429);
      expect(hits).toBe(0);
    } finally { await up.close(); }
  });

  it("E: a failed usage report is queued on disk, retried with backoff, survives a restart, and is sent once", async () => {
    const file = path.join(userData, "mac-usage-queue.json");
    const report = { botId: "b1", model: "claude-sonnet-5", usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const timers: { fn: () => void; ms: number }[] = [];
    let fail = true;
    const sent: unknown[] = [];
    const send = async (r: unknown) => { if (fail) throw new Error("offline"); sent.push(r); };
    const q1 = new MacUsageQueue({ file, send, schedule: (fn, ms) => { timers.push({ fn, ms }); } });
    await q1.report(report);
    expect(sent).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await timers.shift()!.fn(); // first retry, still offline
    expect(timers[0]!.ms).toBeGreaterThan(1000); // backoff grows
    // A restart: a new queue reads the file and sends it once the host answers.
    fail = false;
    const q2 = new MacUsageQueue({ file, send, schedule: (fn, ms) => { timers.push({ fn, ms }); } });
    await q2.flush();
    expect(sent).toEqual([report]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items).toHaveLength(0);
    await q2.flush();
    expect(sent).toHaveLength(1);
  });

  it("E: the queue is bounded", async () => {
    const file = path.join(userData, "mac-usage-queue.json");
    const q = new MacUsageQueue({ file, send: async () => { throw new Error("offline"); }, schedule: () => {}, max: 3 });
    for (let i = 0; i < 5; i++) await q.report({ botId: `b${i}`, model: "m", usage: { inputTokens: i, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items.map((x: { report: { botId: string } }) => x.report.botId)).toEqual(["b2", "b3", "b4"]);
  });
});
