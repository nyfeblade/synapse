import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STR_AUTH, classifyAnthropicError } from "@synapse/shared";
import { CLAUDE_AUTH_SCRUB, SENTINEL_API_KEY, SENTINEL_BASE_URL, applyAuthEnv, prepareAuthEnv, setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { retireClaudeLogin } from "../../auth/auth-store";
import { AuthProxy } from "../../auth/proxy";
import { deniedPrivate } from "../../backup/host-backup";
import { classifyResult } from "../../brain/errors";
import { judgeCt04 } from "../../brain/conformance/checks/group-a";
import { buildBotEnv } from "../../brain/spawn-options";
import { UsageLadder } from "../../usage/ladder";
import { listCostUsd } from "../../usage/list-price";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

/** synapse-public, review round 2: the security review (S1–S6) and the API-key parity audit (P1–P5), host side. */
const KEY = "sk-ant-api03-" + "R".repeat(80) + "rnd2";
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "round2-")); dirs.push(d); return d; };
let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
afterEach(async () => {
  setAuthSource(null); setAuthProxy(null);
  await proxy?.stop(); proxy = null;
  await api?.close(); api = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("S4: more ways the CLI could sign in are scrubbed", () => {
  it("names the host-provider and custom-OAuth variables", () => {
    for (const k of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_CUSTOM_OAUTH_URL"]) {
      expect(CLAUDE_AUTH_SCRUB as readonly string[]).toContain(k);
    }
  });
});

describe("S1: an env with no real key carries a dead sentinel pair, so OAuth stays off", () => {
  it("buildBotEnv (a background Shell's env) has the sentinel key and a closed loopback base URL", () => {
    const env = buildBotEnv({ cfg: tmpConfig(), botId: "b1" });
    expect(env.ANTHROPIC_API_KEY).toBe(SENTINEL_API_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe(SENTINEL_BASE_URL);
    expect(SENTINEL_API_KEY).toMatch(/^sk-ant-api03-synproxy-/);
    expect(SENTINEL_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("a CLI spawn replaces the sentinel: the real key with no proxy (the sentinel URL goes), a proxy token with one", () => {
    const base = buildBotEnv({ cfg: tmpConfig(), botId: "b1" });
    setAuthSource({ apiKey: () => KEY });
    const direct = applyAuthEnv<Record<string, string | undefined>>({ ...base })!;
    expect(direct.ANTHROPIC_API_KEY).toBe(KEY);
    expect(direct.ANTHROPIC_BASE_URL).toBeUndefined();
    const withCustom = applyAuthEnv<Record<string, string | undefined>>({ ...base, ANTHROPIC_BASE_URL: "http://127.0.0.1:5555" })!;
    expect(withCustom.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5555"); // a test's own fake stays
    setAuthProxy({ url: "http://127.0.0.1:47802", issue: () => "sk-ant-api03-synproxy-t1", revoke: () => {} });
    const p = prepareAuthEnv<Record<string, string | undefined>>({ ...base }, { botId: "b1" });
    expect(p.env!.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47802");
    expect(p.env!.ANTHROPIC_API_KEY).toBe("sk-ant-api03-synproxy-t1");
  });
});

describe("S5: leftover login temp files go too, and backups never carry them", () => {
  it("retireClaudeLogin removes claude-oauth-token and its .tmp leftovers, only in hostPrivate", () => {
    const hp = tmp();
    for (const f of ["claude-oauth-token", "claude-oauth-token.tmp", "claude-oauth-token.1234.99.tmp"]) fs.writeFileSync(path.join(hp, f), "sk-ant-oat01-x");
    fs.writeFileSync(path.join(hp, "keep.json"), "{}");
    expect(retireClaudeLogin({ hostPrivate: hp })).toBe(true);
    expect(fs.readdirSync(hp)).toEqual(["keep.json"]);
  });

  it("the backup deny list matches the token and its temp files by prefix", () => {
    for (const f of ["claude-oauth-token", "claude-oauth-token.tmp", "claude-oauth-token.77.1.tmp"]) expect(deniedPrivate(f), f).toBe(true);
    expect(deniedPrivate("anthropic-auth")).toBe(false);
  });
});

describe("P1: an API rate limit pauses only as long as it says", () => {
  const trays = () => {
    const added: { title: string }[] = [];
    return { added, svc: { add: (t: { title: string }) => { added.push(t); return { ...t, buttons: [] }; }, list: () => [], dismiss: () => {} } as never };
  };
  const usage = { weekCostUsd: () => 0, budgetUsd: () => null, weekStart: () => 1, ladderState: () => ({ dismissed: {}, resumedWeek: null }), setLadderState: () => {} } as never;

  it("\"Try again in 30 s\": a 30-second pause, no \"Usage limit reached\", no degraded reviewer, no routine offset", () => {
    const now = 1_000_000_000_000;
    const t = trays();
    const degraded: number[] = [];
    const l = new UsageLadder({ usage, trays: t.svc, now: () => now, onReviewerDegraded: (u) => degraded.push(u) });
    l.noteLimitError(STR_AUTH.rateLimitedDetail(30));
    expect(l.limitedUntil()).toBe(now + 30_000);
    expect(l.routinePausedUntil("r1")).toBe(now + 30_000);
    expect(t.added.map((x) => x.title)).not.toContain("Usage limit reached");
    expect(degraded).toEqual([]);
  });

  it("no wait given: a short default pause (a minute), never the 5-hour plan default", () => {
    const now = 2_000_000_000_000;
    const l = new UsageLadder({ usage, trays: trays().svc, now: () => now });
    l.noteLimitError(STR_AUTH.rateLimitedDetail());
    expect(l.limitedUntil()).toBe(now + 60_000);
  });
});

describe("P2: the box key proxy forwards only the Messages API, meters every answer and asks the budget per request", () => {
  const start = async (o: { allow?: (botId: string | null) => { ok: boolean; message: string | null }; onUnreported?: (botId: string | null, model: string, u: Record<string, number>) => void } = {}) => {
    api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "hi" }]] });
    proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, ...o });
    await proxy.start();
    return proxy;
  };
  const call = (p: AuthProxy, tok: string, pathname: string, method = "POST", body: unknown = { model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) =>
    fetch(`${p.url}${pathname}`, { method, headers: { "x-api-key": tok, "content-type": "application/json", "anthropic-version": "2023-06-01" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });

  it("other /v1 paths and methods are refused (404) and never reach Anthropic", async () => {
    const p = await start();
    const tok = p.issue({ botId: "b1" });
    for (const [m, u] of [["GET", "/v1/files"], ["POST", "/v1/messages/batches"], ["GET", "/v1/models"], ["POST", "/v1/skills"], ["GET", "/v1/messages"]] as const) {
      const r = await call(p, tok, u, m);
      expect(r.status, `${m} ${u}`).toBe(404);
      await r.text();
    }
    expect(api!.requests).toEqual([]);
    const ok = await call(p, tok, "/v1/messages/count_tokens");
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("a non-streamed answer is metered too", async () => {
    const p = await start();
    const tok = p.issue({ botId: "b1" });
    const r = await call(p, tok, "/v1/messages?beta=true");
    expect(r.status).toBe(200);
    await r.json();
    expect(p.usage("b1")).toMatchObject({ requests: 1, inputTokens: 5, outputTokens: 1 });
  });

  it("over budget: 429 with the budget's message, not forwarded", async () => {
    let ok = true;
    const p = await start({ allow: () => (ok ? { ok: true, message: null } : { ok: false, message: "Monthly budget reached." }) });
    const tok = p.issue({ botId: "b1" });
    ok = false;
    const r = await call(p, tok, "/v1/messages");
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Monthly budget reached.");
    expect(api!.requests).toEqual([]);
  });

  it("spend the CLI never reported (a Bot's own call with its run token) is reported when the token is released", async () => {
    const seen: { botId: string | null; model: string; u: Record<string, number> }[] = [];
    const p = await start({ onUnreported: (botId, model, u) => seen.push({ botId, model, u }) });
    const tok = p.issue({ botId: "b1" });
    await (await call(p, tok, "/v1/messages")).json();
    p.revoke(tok, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 });
    expect(seen).toEqual([{ botId: "b1", model: "claude-haiku-4-5-20251001", u: expect.objectContaining({ inputTokens: 5, outputTokens: 1 }) }]);
    const tok2 = p.issue({ botId: "b1" });
    await (await call(p, tok2, "/v1/messages")).json();
    p.revoke(tok2, { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 }); // all reported: nothing extra
    expect(seen).toHaveLength(1);
  });
});

describe("P5: web search off, CT-04, and list prices for 1-hour cache writes and web search", () => {
  it("a web-search-disabled error is explained in plain words", () => {
    const c = classifyAnthropicError(400, "invalid_request_error", undefined, "Web search is not enabled for this organization.");
    expect(c.title).toBe(STR_AUTH.webSearchDisabled);
    const r = classifyResult({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 web search is disabled for your organization" } as never, null, false);
    expect(r).toMatchObject({ trayTitle: STR_AUTH.webSearchDisabled, message: STR_AUTH.webSearchDisabledDetail });
  });

  it("CT-04: no plan windows with an API key is n/a (usage is metered), not a failure", () => {
    expect(judgeCt04({ windows: {} })).toMatchObject({ status: "n/a", flags: { usageSource: "metering" } });
  });

  it("1-hour cache writes are 2x input and web searches $10 per 1,000", () => {
    const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(listCostUsd("claude-sonnet-5", base)).toBeCloseTo(2.5, 6); // 5-minute writes: 1.25 x $2
    expect(listCostUsd("claude-sonnet-5", { ...base, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(4, 6); // 1-hour: 2 x $2
    expect(listCostUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 3 })).toBeCloseTo(0.03, 6);
  });
});
