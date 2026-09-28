import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { AuthProxy } from "../../auth/proxy";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { meteredQuery } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type FakeAnthropic, type SeenRequest } from "./fake-anthropic";

/**
 * Review round 2 (P3): does `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` make the real bundled CLI, behind the key proxy,
 * send what it sends to api.anthropic.com directly (fine-grained tool streaming, the stall check, the native 1M path)?
 * A record, run by hand against the local fake (no real network, no real key):
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/auth/first-party-flag.cli.integration.test.ts --silent=false
 *
 * It prints what differs with and without the flag. Finding (2026-09-25): not proven, so not adopted (docs/api-key-auth.md).
 */
const KEY = "sk-ant-api03-" + "F".repeat(80) + "flag";
let api: FakeAnthropic | null = null;
let proxy: AuthProxy | null = null;
const dirs: string[] = [];
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; setAuthProxy(null); setAuthSource(null); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function record(model: string, flag: boolean): Promise<SeenRequest[]> {
  api = await startFakeAnthropic({ apiKey: KEY, script: [[{ tool: "Bash", input: { command: "echo hi", description: "say hi" } }], [{ text: "done" }]] });
  proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY });
  await proxy.start();
  setAuthSource({ apiKey: () => KEY });
  setAuthProxy(proxy);
  const cfg = tmpConfig();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fpflag-")));
  dirs.push(home);
  const env = { ...buildBotEnv({ cfg, botId: "b1" }), PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...(flag ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}) };
  const opts = buildBotQueryOptions({
    cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model,
    env, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
  });
  Object.assign(opts, { cwd: home, persistSession: false, pathToClaudeCodeExecutable: undefined, tools: ["Bash"] });
  const q = meteredQuery({ purpose: "turn", botId: "b1" }, { prompt: "run the probe", options: opts });
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) if ((m as { type: string }).type === "result") break;
  } finally { q.close(); }
  const seen = [...api.requests];
  await proxy.stop(); proxy = null; await api.close(); api = null;
  return seen;
}

const summary = (rs: SeenRequest[]) => {
  const conv = rs.filter((r) => r.conversational);
  const tools = (conv[0]?.body.tools ?? []) as { name?: string; eager_input_streaming?: boolean }[];
  return {
    paths: [...new Set(rs.map((r) => `${r.method} ${r.path.split("?")[0]}`))].sort(),
    betas: [...new Set(conv.flatMap((r) => (r.beta ?? "").split(",").map((b) => b.trim()).filter(Boolean)))].sort(),
    models: [...new Set(conv.map((r) => String(r.body.model)))],
    eagerTools: tools.filter((t) => t.eager_input_streaming).map((t) => t.name),
  };
};

describe.runIf(process.env.RUN_CLAUDE === "1")("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL behind the key proxy (a record)", () => {
  it("haiku and sonnet [1m], with and without the flag", async () => {
    const out: Record<string, ReturnType<typeof summary>> = {};
    for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-5[1m]"]) {
      for (const flag of [false, true]) out[`${model} flag=${flag}`] = summary(await record(model, flag));
    }
    if (process.env.FP_OUT) fs.writeFileSync(process.env.FP_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    for (const v of Object.values(out)) expect(v.models.length).toBeGreaterThan(0);
    // Recorded 2026-09-25 (CLI 2.1.277): the flag does NOT bring what it was for. No tool is sent with eager (fine-grained)
    // input streaming either way, and [1m] takes the same context-1m beta path either way; it only adds internal betas
    // (cache-diagnosis, thinking-binding-controls, thinking-display-updates) that a Console key may refuse. Not adopted.
    const on = (m: string) => out[`${m} flag=true`]!, off = (m: string) => out[`${m} flag=false`]!;
    expect(on("claude-haiku-4-5-20251001").eagerTools).toEqual(off("claude-haiku-4-5-20251001").eagerTools);
    expect(on("claude-sonnet-5[1m]").models).toEqual(off("claude-sonnet-5[1m]").models);
    expect(on("claude-sonnet-5[1m]").betas).toContain("context-1m-2025-08-07");
  }, 240_000);
});
