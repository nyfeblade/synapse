/**
 * synapse-public, security review S2/S4/P5 on the Mac: no wrapped run can ever fall back to a stored Claude login (a dead
 * sentinel key and a closed base URL unless this run's proxy grant replaces them), Claude login commands are refused, the
 * app-owned claude config dir loses any login file, and the key proxy meters 1-hour cache writes and web searches.
 * HOME is a temp dir; claude is a stub; nothing reaches the network (closed and local upstreams only).
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAC_CLAUDE_AUTH_UNKNOWN_MSG, MAC_CLAUDE_CONFIG_DIR } from "@synapse/shared";
import {
  LEGACY_MAC_CLAUDE_TOKEN_FILE, MAC_CLAUDE_LOGIN_REFUSED_MSG, MAC_LOGIN_SCRUB, MAC_SENTINEL_BASE_URL, MAC_SENTINEL_KEY, retireMacClaudeLogin,
} from "../../src/coordinator/local-exec/login-scrub";
import { saveMacApiKey, loadMacApiKey } from "../../src/coordinator/local-exec/mac-api-key";
import { MAC_PROXY_TOKEN_PREFIX, MacKeyProxy } from "../../src/coordinator/local-exec/mac-key-proxy";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { loadPolicyKey } from "../../src/coordinator/local-exec/policy-key";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";
import { disposeScratchPolicy } from "../../src/coordinator/local-exec/wiring";

let home: string;
let userData: string;
let bin: string;
let key: Buffer;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mlh-home-")));
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
const CLOSED = "http://127.0.0.1:9";
const proxies: MacKeyProxy[] = [];
afterEach(async () => { for (const p of proxies.splice(0)) await p.stop(); });
const proxyFor = (o: Partial<ConstructorParameters<typeof MacKeyProxy>[0]> = {}) => {
  const p = new MacKeyProxy({ key: () => loadMacApiKey(userData, key), upstream: CLOSED, ...o });
  proxies.push(p);
  return p;
};
type Auth = { keySaved: boolean; spend: { ok: boolean; message: string | null } };
const ok: Auth = { keySaved: true, spend: { ok: true, message: null } };
const exec = (auth: Auth | null, keyProxy: MacKeyProxy = proxyFor()) => new LocalExecutor({
  root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, keyProxy, claudeAuth: async () => auth,
});
async function sh(ex: LocalExecutor, command: string): Promise<string> {
  const c: string[] = [];
  await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, x) => c.push(x) });
  return c.join("");
}

describe("S4: the Mac's scrub list names every host-managed login form", () => {
  it("includes the entrypoint and host-provider variables", () => {
    for (const k of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_CUSTOM_OAUTH_URL"]) {
      expect(MAC_LOGIN_SCRUB as readonly string[]).toContain(k);
    }
  });
});

describe("S2 migration: login files inside the app's own data go; nothing else is touched", () => {
  it("removes .credentials.json from the Synapse-owned claude config dir and leftover token .tmp files in userData", () => {
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{\"claudeAiOauth\":{}}");
    fs.writeFileSync(path.join(userData, `${LEGACY_MAC_CLAUDE_TOKEN_FILE}.123.tmp`), "partial");
    const users = path.join(home, ".claude");
    fs.mkdirSync(users, { recursive: true });
    fs.writeFileSync(path.join(users, ".credentials.json"), "user's own login");
    expect(retireMacClaudeLogin(userData, home)).toBe(true);
    expect(fs.existsSync(path.join(dir, ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(userData, `${LEGACY_MAC_CLAUDE_TOKEN_FILE}.123.tmp`))).toBe(false);
    expect(fs.readFileSync(path.join(users, ".credentials.json"), "utf8")).toBe("user's own login");
    expect(retireMacClaudeLogin(userData, home)).toBe(false);
  });

  it("a .credentials.json that is a link (to ~/.claude) is never followed or removed", () => {
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const users = path.join(home, ".claude");
    fs.mkdirSync(users, { recursive: true });
    const target = path.join(users, ".credentials.json");
    fs.writeFileSync(target, "user's own login");
    fs.symlinkSync(target, path.join(dir, ".credentials.json"));
    const tmpLink = path.join(userData, `${LEGACY_MAC_CLAUDE_TOKEN_FILE}.9.tmp`);
    fs.symlinkSync(target, tmpLink);
    retireMacClaudeLogin(userData, home);
    expect(fs.readFileSync(target, "utf8")).toBe("user's own login");
  });
});

describe("P5: the Mac key proxy meters 1-hour cache writes and web searches", () => {
  it("reads them off streamed and plain answers", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 }, output_tokens: 1 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9, server_tool_use: { web_search_requests: 2 } } })}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const up = http.createServer((q, r) => {
      q.resume();
      if (String(q.url).includes("stream")) { r.writeHead(200, { "content-type": "text/event-stream" }); for (const e of sse) r.write(e); r.end(); }
      else r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "claude-haiku-4-5", usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 }, server_tool_use: { web_search_requests: 1 } } }));
    });
    await new Promise<void>((res) => up.listen(0, "127.0.0.1", () => res()));
    const seen: unknown[] = [];
    try {
      const p = proxyFor({ upstream: `http://127.0.0.1:${(up.address() as { port: number }).port}`, onUsage: (u) => seen.push(u) });
      const g = await p.grant({ botId: "b1" });
      if (!("token" in g)) throw new Error("no grant");
      await (await fetch(`${g.baseUrl}/v1/messages?stream`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" })).text();
      await (await fetch(`${g.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": g.token }, body: "{}" })).text();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([
        { botId: "b1", model: "claude-sonnet-5", usage: { inputTokens: 10, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 500, cacheWrite1hTokens: 400, webSearchRequests: 2 } },
        { botId: "b1", model: "claude-haiku-4-5", usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 50, cacheWrite1hTokens: 50, webSearchRequests: 1 } },
      ]);
    } finally { up.close(); }
  });
});

describe.runIf(process.platform === "darwin")("S2 live: no wrapped run can reach a stored Claude login", () => {
  const PRINT = `#!/bin/sh\necho "KEY=[$ANTHROPIC_API_KEY] BASE=[$ANTHROPIC_BASE_URL] TTL=[$CLAUDE_CODE_PROMPT_CACHE_TTL] ARGS=[$*]"\n`;
  beforeEach(() => fs.writeFileSync(path.join(bin, "claude"), PRINT, { mode: 0o755 }));

  it("parser bypass `claude --version; sh -c 'claude -p hi'` with no host answer: the inner claude gets the dead sentinel", async () => {
    const out = await sh(exec(null), "claude --version; sh -c 'claude -p hi'");
    // Either refused (the host couldn't be asked) or run with the dead sentinel: never with no key at all.
    expect(out.includes(MAC_CLAUDE_AUTH_UNKNOWN_MSG) || out.includes(`KEY=[${MAC_SENTINEL_KEY}] BASE=[${MAC_SENTINEL_BASE_URL}]`)).toBe(true);
    expect(out).not.toMatch(/KEY=\[\]/);
  });

  it("a claude the parser can't see at all (`c=cla; \"\${c}ude\"`) still gets the dead sentinel", async () => {
    const out = await sh(exec(ok), 'c=cla; "${c}ude" -p hi');
    expect(out).toContain(`KEY=[${MAC_SENTINEL_KEY}] BASE=[${MAC_SENTINEL_BASE_URL}]`);
  });

  it("a granted run gets this run's proxy token (not the sentinel) and the 1-hour prompt-cache pin", async () => {
    saveMacApiKey(userData, key, API_KEY);
    const out = await sh(exec(ok), "claude -p hi");
    expect(out).toContain(`KEY=[${MAC_PROXY_TOKEN_PREFIX}`);
    expect(out).toContain("TTL=[1h]");
    expect(out).not.toContain(MAC_SENTINEL_KEY);
  });

  for (const cmd of ["claude auth login", "claude /login", "claude setup-token", "echo hi && claude auth login --console", "sh -c 'claude setup-token'"]) {
    it(`refuses a Claude login command: ${cmd}`, async () => {
      saveMacApiKey(userData, key, API_KEY);
      const out = await sh(exec(ok), cmd);
      expect(out).toContain(MAC_CLAUDE_LOGIN_REFUSED_MSG);
      expect(out).not.toContain("KEY=");
    });
  }
});
