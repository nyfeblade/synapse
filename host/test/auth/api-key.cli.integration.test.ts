import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { SDKAssistantMessageError, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_MODEL, STR_AUTH } from "@synapse/shared";
import { AuthStore } from "../../auth/auth-store";
import { setAuthSource } from "../../auth/auth-env";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { classifyResult } from "../../brain/errors";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { meteredQuery, runUsageOf, setUsageSink, type MeteredRun } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type Block, type FakeAnthropic, type Failure } from "./fake-anthropic";

/**
 * API-key sign-in, end to end with no real key: the REAL bundled Claude Code CLI runs a Bot turn with the Bot's real
 * spawn options and env (buildBotEnv, which still carries a subscription token) through meteredQuery, where the
 * sign-in mode is applied. The model is fake-anthropic.ts, a local Messages API that checks x-api-key.
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/auth/api-key.cli.integration.test.ts
 */
const KEY = "sk-ant-api03-" + "F".repeat(80) + "k3y9";
const OAUTH = "sk-ant-oat01-" + "S".repeat(60);
let api: FakeAnthropic | null = null;
const cleanup: string[] = [];
afterEach(async () => { await api?.close(); api = null; setAuthSource(null); setUsageSink(null); for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

interface Turn { result: SDKResultMessage | null; lastError: SDKAssistantMessageError | null; retries: { status: number | null; delayMs: number }[]; texts: string[] }

async function turn(o: { script: Block[][]; failures?: Failure[]; storedKey?: string; purpose?: string; extraEnv?: Record<string, string> }): Promise<Turn & { api: FakeAnthropic }> {
  api = await startFakeAnthropic({ apiKey: KEY, script: o.script, failures: o.failures });
  const cfg = tmpConfig();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apikey-")));
  cleanup.push(home);
  const store = new AuthStore({ dir: path.join(cfg.hostPrivate, "anthropic-auth"), key: randomBytes(32) });
  store.setApiKey(o.storedKey ?? KEY);
  setAuthSource(store);
  // api-key-only: a stray Claude login everywhere the CLI could find one — a stored claude.ai login in its config dir
  // and a login token in the env it is handed — and still only the API key may be used.
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: OAUTH, refreshToken: OAUTH + "-refresh", expiresAt: Date.now() + 86_400_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }), { mode: 0o600 });
  const env = { ...buildBotEnv({ cfg, botId: "b1" }), CLAUDE_CODE_OAUTH_TOKEN: OAUTH, PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: claudeDir, ANTHROPIC_BASE_URL: api.url, ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...(o.extraEnv ?? {}) };
  const opts = buildBotQueryOptions({
    cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model: HELPER_MODEL,
    env, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
  });
  Object.assign(opts, { cwd: home, persistSession: false, pathToClaudeCodeExecutable: undefined, tools: ["Bash"] });
  const out: Turn = { result: null, lastError: null, retries: [], texts: [] };
  const q = meteredQuery({ purpose: o.purpose ?? "turn", botId: "b1" }, { prompt: "run the probe", options: opts });
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const a = m as { type: string; subtype?: string; error?: SDKAssistantMessageError; retry_delay_ms?: number; error_status?: number | null; message?: { content?: { type: string; text?: string }[] } };
      if (a.type === "assistant" && a.error) out.lastError = a.error;
      if (a.type === "assistant") for (const c of a.message?.content ?? []) if (c.type === "text" && c.text) out.texts.push(c.text);
      if (a.type === "system" && a.subtype === "api_retry") out.retries.push({ status: a.error_status ?? null, delayMs: a.retry_delay_ms ?? 0 });
      if (a.type === "result") { out.result = m as SDKResultMessage; break; }
    }
  } finally {
    q.close();
  }
  return { ...out, api };
}

const classify = (t: Turn) => classifyResult(t.result!, t.lastError, false, t.retries.length ? { retryAfterMs: t.retries.at(-1)!.delayMs } : {});

describe.runIf(process.env.RUN_CLAUDE === "1")("API-key sign-in through the real CLI (fake Messages API)", () => {
  it("the key goes as x-api-key (never the OAuth token), the reply streams, a tool call round-trips, usage is recorded", async () => {
    const recorded: MeteredRun[] = [];
    setUsageSink({ record: (r) => recorded.push(r), lastTotals: () => null, noteTotals: () => {} });
    const t = await turn({ script: [[{ tool: "Bash", input: { command: "echo tool-ran-$((6*7))", description: "probe" } }], [{ text: "All done, the probe said 42." }]] });
    expect(t.result?.subtype).toBe("success");
    expect(t.result?.is_error).toBe(false);
    const conv = t.api.requests.filter((r) => r.conversational);
    expect(conv.length).toBe(2);
    // Every API call carries the key; nothing (the CLI's unauthenticated /api/hello included) carries the OAuth token.
    expect(t.api.requests.filter((r) => r.path.startsWith("/v1/")).every((r) => r.apiKey === KEY)).toBe(true);
    for (const r of t.api.requests) expect(r.authorization ?? "").not.toContain(OAUTH);
    for (const r of t.api.requests) expect(r.authorization).toBeNull(); // no bearer at all: the stored login was never used
    expect(JSON.stringify(t.api.requests.map((r) => r.body))).not.toContain(OAUTH);
    expect(conv.every((r) => r.stream)).toBe(true);
    // The tool ran on this machine and its result went back as a tool_result for the scripted tool_use id.
    const second = JSON.stringify(conv[1]!.body.messages);
    expect(second).toContain("tool_result");
    expect(second).toContain("\"tool_use_id\":\"toolu_fake_1_0\""); // the id the first streamed reply gave
    expect(second).toContain("tool-ran-42");
    expect(t.texts.join("")).toContain("All done, the probe said 42.");
    // Usage: the run's own tokens, cache reads and writes included (2 calls × the fake's usage).
    const u = runUsageOf(t.result)!;
    expect(u.inputTokens).toBeGreaterThanOrEqual(24);
    expect(u.outputTokens).toBeGreaterThanOrEqual(14);
    expect(u.cacheReadTokens).toBeGreaterThanOrEqual(600);
    expect(u.cacheWriteTokens).toBeGreaterThanOrEqual(80);
    expect(recorded).toEqual([]); // a "turn" is recorded at settle (usage store), not here
  }, 90_000);

  it("a helper call (memory extraction) signs in the same way and is recorded by purpose", async () => {
    const recorded: MeteredRun[] = [];
    setUsageSink({ record: (r) => recorded.push(r), lastTotals: () => null, noteTotals: () => {} });
    const t = await turn({ script: [[{ text: "fact: likes tea" }]], purpose: "extraction" });
    expect(t.result?.subtype).toBe("success");
    expect(t.api.requests.filter((r) => r.path.startsWith("/v1/")).every((r) => r.apiKey === KEY)).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ purpose: "extraction", botId: "b1" });
    expect(recorded[0]!.usage.cacheReadTokens).toBeGreaterThan(0);
  }, 90_000);

  it("a wrong key: 401 authentication_error → \"key rejected\"", async () => {
    const t = await turn({ script: [[{ text: "never" }]], storedKey: "sk-ant-api03-" + "W".repeat(80) });
    expect(t.result?.is_error).toBe(true);
    expect(classify(t)).toMatchObject({ code: "BOT-E0421", trayTitle: STR_AUTH.keyRejected, retryable: false });
  }, 90_000);

  it("no credits: 402 billing_error → \"No API credits\"", async () => {
    const t = await turn({ script: [[{ text: "never" }]], failures: [{ status: 402, type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." }] });
    expect(t.result?.is_error).toBe(true);
    expect(classify(t)).toMatchObject({ trayTitle: STR_AUTH.billing, retryable: false });
  }, 90_000);

  it("overloaded: a 529 is retried by the CLI with backoff and the turn succeeds", async () => {
    const t = await turn({ script: [[{ text: "made it" }]], failures: [{ status: 529, type: "overloaded_error", message: "Overloaded" }] });
    expect(t.retries[0]?.status).toBe(529);
    expect(t.retries[0]!.delayMs).toBeGreaterThan(0);
    expect(t.result?.subtype).toBe("success");
    expect(t.result?.is_error).toBe(false);
    expect(t.texts.join("")).toContain("made it");
  }, 90_000);

  it("rate limited: the CLI waits the server's retry-after, and when it gives up the error says how long to wait", async () => {
    const f: Failure = { status: 429, type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit", retryAfterSec: 2 };
    const t = await turn({ script: [[{ text: "never" }]], failures: [f, f, f], extraEnv: { CLAUDE_CODE_MAX_RETRIES: "1" } });
    expect(t.retries[0]).toMatchObject({ status: 429 });
    expect(t.retries[0]!.delayMs).toBeGreaterThanOrEqual(2000);
    expect(t.result?.is_error).toBe(true);
    const e = classify(t)!;
    expect(e.trayTitle).toBe(STR_AUTH.rateLimited);
    expect(e.message).toMatch(/Try again in \d+ s/);
  }, 90_000);

  it("permission: 403 permission_error → \"Key can't use this\"", async () => {
    const t = await turn({ script: [[{ text: "never" }]], failures: [{ status: 403, type: "permission_error", message: "Your API key does not have permission to use the specified resource." }] });
    expect(t.result?.is_error).toBe(true);
    expect(classify(t)).toMatchObject({ trayTitle: STR_AUTH.permission });
  }, 90_000);

  it("model not available: 404 not_found_error → \"Model not available to this key\"", async () => {
    const t = await turn({ script: [[{ text: "never" }]], failures: Array(5).fill({ status: 404, type: "not_found_error", message: "model: claude-haiku-4-5-20251001" }) });
    expect(t.result?.is_error).toBe(true);
    expect(classify(t)).toMatchObject({ code: "BOT-MODEL", trayTitle: STR_AUTH.modelUnavailable });
  }, 90_000);
});
