import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { STR_AUTH } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { credentialsReady } from "../../auth/auth-env";
import { authStoreFor, LEGACY_CLAUDE_TOKEN_FILE } from "../../auth/auth-store";
import { ClaudeBrain } from "../../brain/claude-brain";
import { loadConfig } from "../../config";
import { sealTo } from "../../secrets/crypto";
import { input, testWiring } from "../brain/helpers";
import { tmpConfig } from "../helpers";

const KEY = "sk-ant-api03-" + "A".repeat(80) + "Zq12";
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("the host app: Settings → Account commands and the Bot spawn", () => {
  it("starts with no key (onboarding asks for one); saving one respawns Bots on their next turn; the key never comes back", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const h = app.handlers;
    const v0 = await h.getAuth!({});
    expect(v0).toEqual({ apiKey: null, boxPublicKey: v0.boxPublicKey });
    expect((await h.getOnboarding!({})).tokenConfigured).toBe(false);
    const { id } = await h.createAgent!({ name: "Ada", isKickstartRequested: false } as never);
    const before = app.services.spawnConfig(id).spawnKey;
    expect(app.services.spawnConfig(id).env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const v1 = await h.setApiKey!({ sealed: await sealTo(v0.boxPublicKey, KEY) });
    expect(v1.apiKey?.masked).toBe("sk-ant-…Zq12");
    expect(credentialsReady()).toBe(true);
    expect(app.services.spawnConfig(id).spawnKey).not.toBe(before);
    expect((await h.getOnboarding!({})).tokenConfigured).toBe(true);
    expect(JSON.stringify(await h.getAuth!({}))).not.toContain(KEY.slice(13, 40));
    // At rest: sealed, never plaintext, anywhere in the host's private folder.
    const files = fs.readdirSync(cfg.hostPrivate, { recursive: true }).map(String).map((f) => path.join(cfg.hostPrivate, f)).filter((f) => fs.statSync(f).isFile());
    for (const f of files) expect(fs.readFileSync(f).toString("latin1")).not.toContain(KEY.slice(13, 40));

    await h.clearApiKey!({});
    expect(credentialsReady()).toBe(false);
    expect((await h.getOnboarding!({})).tokenConfigured).toBe(false);
  });

  it("migration: an install from before api-key-only keeps its saved key, loses the Claude login token file, and Bots use the key", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    authStoreFor(cfg).setApiKey(KEY);
    const file = path.join(cfg.hostPrivate, "anthropic-auth", "auth.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), mode: "subscription" }));
    fs.writeFileSync(path.join(cfg.hostPrivate, LEGACY_CLAUDE_TOKEN_FILE), "sk-ant-oat01-" + "o".repeat(60));
    app = await createHostApp(cfg);
    expect(fs.existsSync(path.join(cfg.hostPrivate, LEGACY_CLAUDE_TOKEN_FILE))).toBe(false);
    expect((await app.handlers.getAuth!({})).apiKey?.masked).toBe("sk-ant-…Zq12");
    expect((await app.handlers.getOnboarding!({})).tokenConfigured).toBe(true);
  });

  it("migration: a subscription install with no key saved shows the key prompt (tokenConfigured false)", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(path.join(cfg.hostPrivate, "anthropic-auth"), { recursive: true });
    fs.writeFileSync(path.join(cfg.hostPrivate, "anthropic-auth", "auth.json"), JSON.stringify({ mode: "subscription" }));
    fs.writeFileSync(path.join(cfg.hostPrivate, LEGACY_CLAUDE_TOKEN_FILE), "sk-ant-oat01-" + "o".repeat(60));
    app = await createHostApp(cfg);
    expect((await app.handlers.getOnboarding!({})).tokenConfigured).toBe(false);
    expect(credentialsReady()).toBe(false);
  });
});

describe("ClaudeBrain words the error for the API key, with the CLI's retry-after", () => {
  it("rate limited after the CLI's retries → \"Rate limited by Anthropic · Try again in 3 s\"", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg); // sets the process's auth source
    const v = await app.handlers.getAuth!({});
    await app.handlers.setApiKey!({ sealed: await sealTo(v.boxPublicKey, KEY) });
    const spawnedEnvs: Record<string, string | undefined>[] = [];
    const queryFn = ((p: { prompt: AsyncIterable<SDKUserMessage>; options: { env: Record<string, string | undefined> } }) => {
      spawnedEnvs.push(p.options.env);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1", model: "m", tools: [], claude_code_version: "2.1.277" };
        for await (const _m of p.prompt) {
          yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 1, retry_delay_ms: 2600, error_status: 429, error: "rate_limit" };
          yield { type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { id: "m", content: [{ type: "text", text: "API Error: Rate limit reached" }] } };
          yield { type: "result", subtype: "success", is_error: true, result: "API Error: Rate limit reached", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, modelUsage: {} };
        }
      })();
    }) as never;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => null, setSessionId: () => {},
      spawnConfig: () => ({ model: "claude-sonnet-5", systemAppend: "P", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, spawnKey: "k" }),
    });
    const r = await brain.runTurn(input("hi"), () => {});
    expect(spawnedEnvs[0]?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(spawnedEnvs[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.error).toMatchObject({ code: "BOT-E0420", trayTitle: STR_AUTH.rateLimited, retryable: false });
    expect(r.error?.message).toContain("Try again in 3 s");
    await brain.dispose();
  });
});
