import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_MODEL } from "@synapse/shared";
import { setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { AuthProxy } from "../../auth/proxy";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { meteredQuery, runUsageOf } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type Block, type FakeAnthropic } from "./fake-anthropic";

/**
 * The auth proxy with the REAL bundled CLI (fake Messages API upstream): the Claude process and its Bash tool never
 * see a real credential, calls still stream and cache the same, and a proxy restart mid-turn is ridden out.
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/auth/proxy.cli.integration.test.ts
 */
// The real credentials: long runs of one letter plus a tail, so a scan can look for them with a regex that
// does not match its own command line (`Q\{60\}real` is not 60 Q's).
const KEY = "sk-ant-api03-" + "Q".repeat(80) + "real";
const OAUTH = "sk-ant-oat01-" + "O".repeat(80) + "real";
const SCAN = "(env; ps -Eww -ax 2>/dev/null; cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n') > /tmp/.scan-$$; "
  + "echo REAL=$(grep -c -e 'Q\\{60\\}real' -e 'O\\{60\\}real' /tmp/.scan-$$) PROXYTOK=$(case \"${ANTHROPIC_API_KEY:-$CLAUDE_CODE_OAUTH_TOKEN}\" in *-synproxy-*) echo 1;; *) echo 0;; esac) BASE=$ANTHROPIC_BASE_URL; rm -f /tmp/.scan-$$";

let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
const dirs: string[] = [];
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; setAuthProxy(null); setAuthSource(null); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function turn(script: Block[][], o: { beforeRun?: () => Promise<void> | void; during?: () => Promise<void> } = {}) {
  api = await startFakeAnthropic({ apiKey: KEY, script });
  proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY });
  await proxy.start();
  setAuthSource({ apiKey: () => KEY });
  setAuthProxy(proxy);
  await o.beforeRun?.();
  const cfg = tmpConfig();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "authproxy-")));
  dirs.push(home);
  // The Bot's real env, plus a stray Claude login token (scrubbed at spawn: api-key-only).
  const env = { ...buildBotEnv({ cfg, botId: "b1" }), CLAUDE_CODE_OAUTH_TOKEN: OAUTH, PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const opts = buildBotQueryOptions({
    cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model: HELPER_MODEL,
    env, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
  });
  Object.assign(opts, { cwd: home, persistSession: false, pathToClaudeCodeExecutable: undefined, tools: ["Bash"] });
  const q = meteredQuery({ purpose: "turn", botId: "b1" }, { prompt: "run the probe", options: opts });
  const during = o.during?.();
  let result: SDKResultMessage | null = null;
  const retries: (number | null)[] = [];
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const a = m as { type: string; subtype?: string; error_status?: number | null };
      if (a.type === "system" && a.subtype === "api_retry") retries.push(a.error_status ?? null);
      if (a.type === "result") { result = m as SDKResultMessage; break; }
    }
  } finally {
    q.close();
  }
  await during;
  const conv = api.requests.filter((r) => r.conversational);
  const scan = conv.map((r) => JSON.stringify(r.body.messages)).join("").match(/REAL=\d+ PROXYTOK=\d+ BASE=[^"\\]*/g)?.at(-1) ?? "";
  return { result, conv, scan, retries, api, proxy };
}

describe.runIf(process.env.RUN_CLAUDE === "1")("the auth proxy with the real CLI", () => {
  {
    it("the Bot's Bash sees no real credential (env, every readable process env and cmdline); the call went through the proxy", async () => {
      const t = await turn([[{ tool: "Bash", input: { command: SCAN, description: "scan" } }], [{ text: "done" }]]);
      expect(t.result?.is_error).toBe(false);
      // REAL counts the real key/token anywhere (checked: without the proxy it finds them); PROXYTOK=1: the Bash env holds a proxy token.
      // (The CLI keeps its OAuth token, here a proxy token, out of its Bash env; its API key it passes on.)
      expect(t.scan).toMatch(/^REAL=0 PROXYTOK=1 BASE=http:\/\/127\.0\.0\.1:\d+$/);
      // Upstream saw only the real credential, never a proxy token; the CLI's betas and cache headers arrived.
      for (const r of t.conv) {
        expect(r.apiKey).toBe(KEY);
        expect(r.authorization).toBeNull();
        expect(JSON.stringify(r.headers)).not.toContain("synproxy");
        expect(r.beta).toContain("prompt-caching-scope");
      }
      // The Bash result went back as a tool_result, and usage (cache included) is recorded both ways.
      expect(runUsageOf(t.result)!.cacheReadTokens).toBeGreaterThanOrEqual(600);
      expect(t.proxy.usage("b1")).toMatchObject({ requests: 2, cacheReadTokens: 600, cacheWriteTokens: 80 });
    }, 120_000);
  }

  it("the cache sees the same request: the body upstream is byte-identical to a direct (no-proxy) run", async () => {
    const viaProxy = await turn([[{ text: "hi" }]]);
    const bodyProxy = viaProxy.conv[0]!.body;
    await proxy!.stop(); proxy = null; await api!.close(); api = null; setAuthProxy(null); setAuthSource(null);
    // Same turn, direct: ANTHROPIC_BASE_URL = the fake, the real key in the env.
    api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "hi" }]] });
    const cfg = tmpConfig();
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "authproxy-")));
    dirs.push(home);
    const opts = buildBotQueryOptions({
      cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model: HELPER_MODEL,
      // The same Bot env (1-hour cache TTL and all), with the real key and the fake as base URL instead of the proxy.
      env: { ...buildBotEnv({ cfg, botId: "b1" }), PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: api.url, ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
    });
    Object.assign(opts, { cwd: home, persistSession: false, pathToClaudeCodeExecutable: undefined, tools: ["Bash"] });
    const q = meteredQuery({ purpose: "turn", botId: "b1" }, { prompt: "run the probe", options: opts });
    for await (const m of q as AsyncIterable<SDKMessage>) if (m.type === "result") break;
    q.close();
    const direct = api.requests.find((r) => r.conversational)!.body;
    // The system prompt, tools and cache_control markers are what the prompt cache keys on.
    const norm = (b: Record<string, unknown>) => JSON.stringify({ system: b.system, tools: b.tools, model: b.model }).replace(/\/[^"]*authproxy-[^"/]*/g, "HOME");
    expect(norm(bodyProxy)).toBe(norm(direct));
    expect(JSON.stringify(bodyProxy)).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}');
  }, 120_000);

  it("a proxy restart mid-turn: the CLI's request fails to connect, it retries, and the turn completes on the same token", async () => {
    const t = await turn([[{ text: "made it" }]], {
      beforeRun: () => proxy!.stop(),
      during: async () => { await new Promise((r) => setTimeout(r, 700)); await proxy!.start(); },
    });
    expect(t.retries.length).toBeGreaterThan(0);
    expect(t.result?.is_error).toBe(false);
    expect(t.conv.length).toBe(1);
  }, 120_000);

  it("the CLI's own token works while its process lives and is refused once the query has closed", async () => {
    const issued: string[] = [];
    let liveStatus = 0;
    const t = await turn([[{ tool: "Bash", input: { command: "sleep 1; echo slept", description: "wait" } }], [{ text: "ok" }]], {
      beforeRun: () => { const p = proxy!; const orig = p.issue.bind(p); p.issue = (g) => { const k = orig(g); issued.push(k); return k; }; },
      during: async () => {
        while (!issued.length) await new Promise((r) => setTimeout(r, 20));
        liveStatus = (await fetch(`${proxy!.url}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": issued[0]!, "content-type": "application/json" }, body: "{}" })).status;
      },
    });
    expect(issued).toHaveLength(1);
    expect(liveStatus).toBe(200);
    const after = await fetch(`${t.proxy.url}/v1/messages`, { method: "POST", headers: { "x-api-key": issued[0]!, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
  }, 120_000);
});
