import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { requireAuthProxy, setAuthProxy } from "../../auth/auth-env";
import { AuthProxy } from "../../auth/proxy";
import { sealTo } from "../../secrets/crypto";
import { meteredQuery, type QueryFn } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

/**
 * synapse-public end to end with fakes: one host app, a real key proxy in front of a fake Anthropic, and a fake CLI
 * spawn (the query function) that makes the model call the CLI would. The API key is the only sign-in; an install
 * that had the Claude subscription saved (its token file and mode) is routed to the API-key sign-in.
 */
const KEY = "sk-ant-api03-" + "E".repeat(80) + "e2e1";
const OAT = "sk-ant-oat01-" + "o".repeat(60);
let app: HostApp | null = null;
let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
afterEach(async () => {
  setAuthProxy(null);
  requireAuthProxy(false);
  await proxy?.stop(); proxy = null;
  await app?.close(); app = null;
  await api?.close(); api = null;
});

/** What one Claude process would do with its env: call the Messages API at its base URL with its credential. */
async function turn(): Promise<{ env: Record<string, string | undefined>; status: number }> {
  let env: Record<string, string | undefined> = {};
  let status = 0;
  const fake = ((p: { options: { env: Record<string, string | undefined> } }) => {
    env = p.options.env;
    return (async function* () {
      const base = env.ANTHROPIC_BASE_URL ?? api!.url;
      const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
      else if (env.CLAUDE_CODE_OAUTH_TOKEN) { headers.authorization = `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`; headers["anthropic-beta"] = "oauth-2025-04-20"; }
      const r = await fetch(`${base}/v1/messages?beta=true`, { method: "POST", headers, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] }) });
      await r.text();
      status = r.status;
    })();
  }) as unknown as QueryFn;
  const q = meteredQuery({ purpose: "review", botId: "b1" }, { prompt: "x", options: { env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: OAT } } }, fake) as AsyncIterable<unknown>;
  for await (const _ of q) { /* drain */ }
  return { env, status };
}

describe("the API key is the only sign-in, end to end with fakes", () => {
  it("an old subscription install: its token and mode are ignored (and the box's token file removed), the API key is asked for and used", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(path.join(cfg.hostPrivate, "anthropic-auth"), { recursive: true });
    fs.writeFileSync(path.join(cfg.hostPrivate, "claude-oauth-token"), OAT);
    fs.writeFileSync(path.join(cfg.hostPrivate, "anthropic-auth", "auth.json"), JSON.stringify({ mode: "subscription" }));
    app = await createHostApp(cfg);
    api = await startFakeAnthropic({ apiKey: KEY, bearer: OAT, script: [[{ text: "a" }], [{ text: "b" }]] });
    let saved: string | null = null;
    proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => saved });
    await proxy.start();
    setAuthProxy(proxy);
    requireAuthProxy(true);
    const h = app.handlers;

    // 1. The old subscription is gone: nothing is ready, turns are refused, no login is ever sent.
    expect(fs.existsSync(path.join(cfg.hostPrivate, "claude-oauth-token"))).toBe(false);
    expect((await h.getOnboarding!({})).tokenConfigured).toBe(false);
    const v = await h.getAuth!({});
    expect(v).not.toHaveProperty("mode");
    expect(v).not.toHaveProperty("subscriptionConfigured");
    expect((h as Record<string, unknown>).setAuthMode).toBeUndefined();
    await expect(turn()).rejects.toThrow(/API key/);
    expect(api.requests.filter((r) => r.authorization)).toEqual([]);

    // 2. The API key is saved: every call goes through the proxy with a per-spawn token.
    await h.setApiKey!({ sealed: await sealTo(v.boxPublicKey, KEY) });
    saved = KEY;
    const t = await turn();
    expect(t.status).toBe(200);
    expect((await h.getOnboarding!({})).tokenConfigured).toBe(true);
    expect(t.env.ANTHROPIC_BASE_URL).toBe(proxy.url);
    expect(t.env.ANTHROPIC_API_KEY).toMatch(/-synproxy-/);
    expect(t.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(t.env)).not.toContain(KEY.slice(13, 40));
    expect(api.requests.at(-1)!.apiKey).toBe(KEY); // the proxy added the real key upstream
    expect(api.requests.at(-1)!.authorization).toBeNull();
    expect(await h.getBudgetPrompt!({})).toMatchObject({ show: true });
    expect(await h.getUsageDashboard!({ range: "week" })).not.toHaveProperty("subscription");

    // 3. Removing the key leaves no sign-in: turns are refused until a new one is saved (nothing falls back).
    await h.clearApiKey!({});
    saved = null;
    await expect(turn()).rejects.toThrow(/API key/);
  });

  it("the proxy down: the turn is refused before any process starts (fail closed)", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const h = app.handlers;
    const v = await h.getAuth!({});
    await h.setApiKey!({ sealed: await sealTo(v.boxPublicKey, KEY) });
    requireAuthProxy(true);
    await expect(turn()).rejects.toThrow(/key proxy|never reaches/);
  });
});
