import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_IDS, STR_AUTH, type KeyCheckView, type ModelId } from "@synapse/shared";
import { KEY_CHECK_MAX_TOKENS, KeyCheck, type KeyCheckSpend } from "../../auth/key-check";
import { ModelAccess, LONG_CONTEXT_BETA } from "../../auth/model-access";
import { AuthProxy } from "../../auth/proxy";
import { listCostUsd } from "../../usage/list-price";
import { recordedUsage, recording, startReplayAnthropic, type Recording, type ReplayAnthropic, type SeenReplayRequest } from "./replay-anthropic";

/**
 * Bug 281: the API-key check, against the replay upstream only (real recorded answers, plus Anthropic's documented
 * error bodies where nothing was recorded). It runs the free count_tokens probe, sends ONE tiny real message to the
 * cheapest model the key reaches through the box key proxy (the budget asked, the spend metered and recorded once),
 * and says in plain words what works and what failed.
 */
const KEY = "sk-ant-api03-" + "K".repeat(80) + "chck";
let api: ReplayAnthropic | null = null;
let proxy: AuthProxy | null = null;
const dirs: string[] = [];
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** An error body in the API's documented wire format, served like a recording (shape of 0037/0046). */
function documented(status: number, type: string, message: string, headers: Record<string, string> = {}): Recording {
  return {
    file: `documented-${status}-${type}`, scenario: "documented error",
    request: { method: "POST", path: "/v1/messages", auth: "x-api-key", headers: {}, body: {} },
    response: { status, headers: { "content-type": "application/json", "x-should-retry": "false", ...headers }, ttfb_ms: 1, total_ms: 1, kind: "json", body: { type: "error", error: { type, message }, request_id: "req_documented" } },
  };
}
const CREDIT = documented(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
const WEB_OFF = documented(400, "invalid_request_error", "Web search is not enabled for this organization.");

interface Routes {
  /** count_tokens per model (default 0023, a recorded 200). */
  count?(model: ModelId, long: boolean, webSearch: boolean): Recording;
  /** The one message (default 0013: Haiku 4.5, streamed, end_turn). */
  message?: Recording;
}
async function setup(o: { key?: string | null; routes?: Routes; allow?: { ok: boolean; message: string | null }; proxyAllow?: { ok: boolean; message: string | null } } = {}) {
  const routes = o.routes ?? {};
  const pick = (req: SeenReplayRequest): Recording | null => {
    const tools = JSON.stringify(req.body.tools ?? []);
    if (req.path.startsWith("/v1/messages/count_tokens")) return routes.count?.(req.body.model as ModelId, (req.beta ?? "").includes(LONG_CONTEXT_BETA), tools.includes("web_search")) ?? recording("0023");
    if (req.path.startsWith("/v1/messages")) return routes.message ?? recording("0013");
    return null;
  };
  api = await startReplayAnthropic({ apiKey: KEY, pick });
  const unreported: unknown[] = [];
  const asked: string[] = [];
  const key = o.key === undefined ? KEY : o.key;
  const budget = () => o.allow ?? { ok: true, message: null };
  proxy = new AuthProxy({
    upstream: api.url, port: 0, credential: () => key,
    allow: (b) => { asked.push(`proxy:${String(b)}`); return o.proxyAllow ?? budget(); },
    onUnreported: (b, m, u) => unreported.push({ b, m, u }),
  });
  await proxy.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keycheck-"));
  dirs.push(dir);
  const access = new ModelAccess({ dir, key: () => key, baseUrl: api.url });
  const recorded: Array<{ model: string; u: KeyCheckSpend }> = [];
  const published: KeyCheckView[] = [];
  const p = proxy;
  const check = new KeyCheck({
    dir, key: () => key, models: () => access.probe(), proxy: () => p, allow: () => { asked.push("check"); return budget(); }, baseUrl: api.url, now: () => 1_000,
    record: (model, u) => recorded.push({ model, u }), onChange: (v) => published.push(v),
  });
  return { api, proxy, check, access, recorded, unreported, asked, published, dir };
}
const messages = (a: ReplayAnthropic) => a.requests.filter((r) => /^\/v1\/messages(\?|$)/.test(r.path));
const counts = (a: ReplayAnthropic) => a.requests.filter((r) => r.path.startsWith("/v1/messages/count_tokens"));

describe("the API-key check: a key that works", () => {
  it("probes for free, sends ONE tiny message to the cheapest model through the proxy, and says what works", async () => {
    const { api, check, recorded, unreported, asked } = await setup();
    const v = await check.run();
    expect(v).toMatchObject({ checkedAt: 1_000, checking: false, works: true, problem: null, model: "claude-haiku-4-5-20251001", longContext: true, webSearch: true });
    expect([...v.models].sort()).toEqual([...MODEL_IDS].sort());

    const sent = messages(api);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as { model: string; max_tokens: number; stream: boolean; tools: Array<{ type: string }>; tool_choice: { type: string } };
    expect(body.stream).toBe(true); // streamed, as every Bot call is: metered from the stream's own usage
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBeLessThanOrEqual(8);
    expect(KEY_CHECK_MAX_TOKENS).toBeLessThanOrEqual(8);
    expect(body.tools.map((t) => t.type)).toEqual(["web_search_20250305"]);
    expect(body.tool_choice).toEqual({ type: "none" }); // the tool is only declared: no search runs, none is paid for
    // Only the key goes upstream, on the probe and the message alike.
    for (const r of [...sent, ...counts(api)]) {
      expect(r.apiKey).toBe(KEY);
      expect(r.authorization).toBeNull();
      expect(r.beta ?? "").not.toMatch(/oauth-/);
    }
    // The message went through the key proxy: the budget was asked, and the spend is recorded once, as metered.
    expect(asked).toEqual(["check", "proxy:null"]); // the check asks first; the proxy asks again, as for any call
    const want = recordedUsage(recording("0013"));
    expect(recorded).toEqual([{ model: "claude-haiku-4-5-20251001", u: want }]);
    await proxy!.stop();
    expect(unreported).toEqual([]); // recorded by the check: not a second time as unreported
    expect(listCostUsd("claude-haiku-4-5-20251001", want)).toBeGreaterThan(0);
  });

  it("the cheapest model the key REACHES: Haiku refused (the recorded 404), so Sonnet 5", async () => {
    const { api, check } = await setup({ routes: { count: (m) => (m === "claude-haiku-4-5-20251001" ? recording("0037") : recording("0023")) } });
    const v = await check.run();
    expect(v.model).toBe("claude-sonnet-5");
    expect(v.models).not.toContain("claude-haiku-4-5-20251001");
    expect(messages(api)[0]!.body.model).toBe("claude-sonnet-5");
  });

  it("no 1M context: the long-context probes are refused (the recorded 400), so 'Not available'", async () => {
    const { check } = await setup({ routes: { count: (_m, long) => (long ? recording("0046") : recording("0023")) } });
    expect((await check.run()).longContext).toBe(false);
  });

  it("web search off, found by the free probe: the message goes without the tool, the key still works", async () => {
    const { api, check } = await setup({ routes: { count: (_m, _l, web) => (web ? WEB_OFF : recording("0023")) } });
    const v = await check.run();
    expect(v).toMatchObject({ works: true, problem: null, webSearch: false });
    expect(messages(api)[0]!.body.tools).toBeUndefined();
  });

  it("web search off, found only by the message: said plainly", async () => {
    const { check, recorded } = await setup({ routes: { message: WEB_OFF } });
    const v = await check.run();
    expect(v).toMatchObject({ works: false, webSearch: false, problem: { kind: "web-search-disabled", title: STR_AUTH.webSearchDisabled, status: 400 } });
    expect(recorded).toEqual([]);
  });

  it("its own usage row failed: the proxy records the same spend instead (never lost, never twice)", async () => {
    const { api, proxy: p, dir, access, unreported } = await setup();
    const check = new KeyCheck({ dir, key: () => KEY, models: () => access.probe(), proxy: () => p, allow: () => ({ ok: true, message: null }), baseUrl: api.url, record: () => { throw new Error("usage.db is busy"); } });
    expect((await check.run()).works).toBe(true);
    expect(unreported).toEqual([{ b: null, m: "claude-haiku-4-5-20251001", u: recordedUsage(recording("0013")) }]);
  });

  it("the result is kept (no secrets) and published", async () => {
    const { check, dir, published } = await setup();
    await check.run();
    const again = new KeyCheck({ dir, key: () => KEY, models: async () => { throw new Error("not asked"); }, proxy: () => null, allow: () => ({ ok: true, message: null }), record: () => {} });
    expect(again.view()).toMatchObject({ works: true, model: "claude-haiku-4-5-20251001", checking: false });
    expect(fs.readFileSync(path.join(dir, "key-check.json"), "utf8")).not.toContain(KEY.slice(13, 40));
    expect(published.at(0)?.checking).toBe(true);
    expect(published.at(-1)).toMatchObject({ checking: false, works: true });
  });
});

describe("the API-key check: exactly what failed", () => {
  it("a bad key: 'key rejected' (Anthropic's 401), nothing spent", async () => {
    const { api, check, recorded } = await setup({ key: "sk-ant-api03-" + "W".repeat(80) + "bad0" });
    const v = await check.run();
    expect(v).toMatchObject({ works: false, problem: { kind: "invalid-key", title: STR_AUTH.keyRejected, detail: STR_AUTH.keyRejectedDetail, status: 401 } });
    expect(messages(api)).toHaveLength(1); // the probe knows nothing on a 401; the one message says why
    expect(recorded).toEqual([]);
  });

  it.each([
    ["no credit (400, the API's words)", CREDIT, { kind: "billing", title: STR_AUTH.billing }],
    ["no credit (402 billing_error)", documented(402, "billing_error", "Billing issue."), { kind: "billing", title: STR_AUTH.billing }],
    ["rate limited (429 + retry-after)", documented(429, "rate_limit_error", "Number of requests has exceeded your per-minute rate limit.", { "retry-after": "30" }), { kind: "rate-limited", title: STR_AUTH.rateLimited, detail: STR_AUTH.rateLimitedDetail(30), retryAfterSec: 30 }],
    ["overloaded (529)", documented(529, "overloaded_error", "Overloaded"), { kind: "overloaded", title: STR_AUTH.overloaded }],
    ["no permission (403)", documented(403, "permission_error", "Your API key does not have permission to use the specified resource."), { kind: "permission", title: STR_AUTH.permission }],
    ["the model refused (the recorded 404)", recording("0037"), { kind: "model-unavailable", title: STR_AUTH.modelUnavailable }],
    ["a server error (500)", documented(500, "api_error", "Internal server error"), { kind: "server", title: STR_AUTH.server }],
  ] as const)("%s", async (_n, message, problem) => {
    const { check, recorded } = await setup({ routes: { message } });
    const v = await check.run();
    expect(v.works).toBe(false);
    expect(v.problem).toMatchObject({ ...problem, status: message.response.status });
    expect(JSON.stringify(v.problem)).not.toMatch(/request_id|req_documented|\{"type"/);
    expect(recorded).toEqual([]);
  });

  it("over the spend budget: nothing is sent, the budget's own words", async () => {
    const { api, check, asked } = await setup({ allow: { ok: false, message: "This month's budget is used up." } });
    const v = await check.run();
    expect(v).toMatchObject({ works: false, problem: { kind: "over-budget", title: STR_AUTH.overBudget, detail: "This month's budget is used up." } });
    expect(messages(api)).toHaveLength(0);
    expect(asked).toEqual(["check"]);
  });

  it("bug 296: the budget runs out between the check's own ask and the proxy's: over budget, not rate limited", async () => {
    const { api, check, asked } = await setup({ proxyAllow: { ok: false, message: "This month's budget is used up." } });
    const v = await check.run();
    expect(asked[0]).toBe("check");
    expect(asked.some((a) => a.startsWith("proxy:"))).toBe(true);
    expect(v).toMatchObject({ works: false, problem: { kind: "over-budget", title: STR_AUTH.overBudget, detail: "This month's budget is used up." } });
    expect(messages(api)).toHaveLength(0);
  });

  it("no key saved: nothing is sent", async () => {
    const { api, check } = await setup({ key: null });
    expect(await check.run()).toMatchObject({ works: false, problem: { kind: "no-key", title: STR_AUTH.noKeyTitle } });
    expect(api.requests).toHaveLength(0);
  });

  it("every model refused: says so, nothing is sent", async () => {
    const { api, check } = await setup({ routes: { count: () => recording("0037") } });
    expect(await check.run()).toMatchObject({ works: false, models: [], model: null, problem: { kind: "model-unavailable", title: STR_AUTH.noModels } });
    expect(messages(api)).toHaveLength(0);
  });

  it("the key proxy is down: says so, the key never leaves another way", async () => {
    const { api, dir, access } = await setup();
    const check = new KeyCheck({ dir, key: () => KEY, models: () => access.probe(), proxy: () => null, allow: () => ({ ok: true, message: null }), record: () => {}, baseUrl: api.url });
    expect(await check.run()).toMatchObject({ works: false, problem: { kind: "proxy-down", title: STR_AUTH.proxyDownTitle } });
    expect(messages(api)).toHaveLength(0);
  });

  it("Anthropic can't be reached: 'Couldn't reach Anthropic'", async () => {
    const { dir, proxy: p } = await setup();
    await api!.close(); api = null; // the upstream is gone: the probe gets nothing, the proxy answers 502
    const check = new KeyCheck({ dir, key: () => KEY, models: async () => ({ checkedAt: 1, checking: false, models: {}, longContext: {} }), proxy: () => p, allow: () => ({ ok: true, message: null }), record: () => {}, baseUrl: "http://127.0.0.1:9" });
    expect(await check.run()).toMatchObject({ works: false, problem: { kind: "network", title: STR_AUTH.network } });
  });
});

describe("the API-key check: one at a time, for the key it started with", () => {
  it("a second run while one is going joins it (one message)", async () => {
    const { api, check } = await setup();
    const [a, b] = await Promise.all([check.run(), check.run()]);
    expect(a).toEqual(b);
    expect(messages(api)).toHaveLength(1);
  });

  it("a key changed meanwhile: the old key's answer never lands", async () => {
    const { check } = await setup();
    const p = check.run();
    check.clear();
    await p;
    expect(check.view()).toMatchObject({ works: null, checkedAt: null, checking: false });
  });
});
