import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKAssistantMessageError, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { STR_AUTH } from "@synapse/shared";
import { setAuthProxy, setAuthSource } from "../../auth/auth-env";
import { AuthProxy } from "../../auth/proxy";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { classifyResult } from "../../brain/errors";
import { EventTranslator } from "../../brain/event-translator";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import type { TurnEvent } from "../../brain/types";
import { meteredQuery, runUsageOf } from "../../usage/metered-query";
import { tmpConfig } from "../helpers";
import { recordedUsage, recording, startReplayAnthropic, type Recording, type ReplayAnthropic } from "./replay-anthropic";

/**
 * Bug 280: the REAL bundled CLI, spawned the way a Bot turn is (buildBotQueryOptions, meteredQuery, the box key
 * proxy), against real recorded Anthropic answers (replay-anthropic.ts). The CLI parses every recorded event, the
 * host's EventTranslator turns them into turn events, and usage/errors come out the host's own way.
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/auth/replay.cli.integration.test.ts
 */
const KEY = "sk-ant-api03-" + "C".repeat(80) + "rply";
let api: ReplayAnthropic | null = null;
let proxy: AuthProxy | null = null;
const dirs: string[] = [];
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; setAuthProxy(null); setAuthSource(null); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

interface Run { result: SDKResultMessage | null; lastError: SDKAssistantMessageError | null; events: TurnEvent[]; unreported: unknown[]; api: ReplayAnthropic; streamTypes: Set<string> }

async function run(queue: Recording[], o: { model?: string; tools?: string[] } = {}): Promise<Run> {
  api = await startReplayAnthropic({ apiKey: KEY, queue });
  const unreported: unknown[] = [];
  proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, onUnreported: (_b, _m, u) => unreported.push(u) });
  await proxy.start();
  setAuthSource({ apiKey: () => KEY });
  setAuthProxy(proxy);
  const cfg = tmpConfig();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "replaycli-")));
  dirs.push(home);
  const env = { ...buildBotEnv({ cfg, botId: "b1" }), PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const opts = buildBotQueryOptions({
    cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model: o.model ?? "claude-sonnet-5",
    env, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
  });
  Object.assign(opts, { cwd: home, persistSession: false, pathToClaudeCodeExecutable: undefined, tools: o.tools ?? ["Bash"] });
  const tr = new EventTranslator();
  const out: Run = { result: null, lastError: null, events: [], unreported, api, streamTypes: new Set() };
  const q = meteredQuery({ purpose: "turn", botId: "b1" }, { prompt: "go", options: opts });
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const a = m as { type: string; error?: SDKAssistantMessageError; event?: { type?: string; delta?: { type?: string }; content_block?: { type?: string } } };
      if (a.type === "stream_event") out.streamTypes.add([a.event?.type, a.event?.delta?.type ?? a.event?.content_block?.type].filter(Boolean).join(":"));
      if (a.type === "assistant" && a.error) out.lastError = a.error;
      out.events.push(...tr.translate(m));
      if (a.type === "result") { out.result = m as SDKResultMessage; break; }
    }
  } finally {
    q.close();
  }
  return out;
}

const sum = (rs: Recording[]) => rs.map(recordedUsage).reduce((a, u) => ({ inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens, cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + u.cacheWriteTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
function upstreamIsKeyOnly(api: ReplayAnthropic) {
  for (const r of api.requests.filter((x) => x.path.startsWith("/v1/"))) {
    expect(r.apiKey).toBe(KEY);
    expect(r.authorization).toBeNull();
    expect(r.beta ?? "").not.toMatch(/oauth-/);
  }
}

describe.runIf(process.env.RUN_CLAUDE === "1")("the real CLI against recorded Anthropic answers", () => {
  it("text (0002): the turn streams, ends on end_turn, usage is what Anthropic said, nothing left unreported", async () => {
    const recs = [recording("0002")];
    const t = await run(recs);
    expect(t.result?.subtype).toBe("success");
    expect(t.result?.is_error).toBe(false);
    expect((t.result as { stop_reason?: string }).stop_reason).toBe("end_turn");
    expect(t.events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(runUsageOf(t.result)).toMatchObject(sum(recs));
    upstreamIsKeyOnly(t.api);
    await proxy!.stop();
    expect(t.unreported).toEqual([]);
  }, 90_000);

  // Every single-turn recording, each on the model it was recorded with: the CLI parses every event Anthropic sent,
  // the result's stop reason is the recorded one, the usage is what Anthropic said, and only the key goes upstream.
  // 0017 is the 1M-context path: a [1m] model sends the context-1m beta and the model id without the suffix.
  it.each(["0002", "0009", "0011", "0013", "0015", "0017", "0040", "0042", "0044"])("%s: parses, stop reason and usage as recorded, key only", async (id) => {
    const r = recording(id);
    const long = id === "0017";
    const t = await run([r], { model: `${String(r.request.body.model)}${long ? "[1m]" : ""}` });
    expect(t.result?.is_error).toBe(false);
    expect(t.api.requests.filter((x) => x.served).map((x) => x.served)).toEqual([r.file]);
    expect((t.result as { stop_reason?: string }).stop_reason).toBe("end_turn");
    expect(runUsageOf(t.result)).toMatchObject(sum([r]));
    const up = t.api.requests.find((x) => x.served)!;
    expect(up.body.model).toBe(r.request.body.model);
    if (long) expect(up.beta).toContain("context-1m-2025-08-07");
    else expect(up.beta ?? "").not.toContain("context-1m-2025-08-07");
    for (const k of t.streamTypes) expect(k).toMatch(/^(message_start|message_delta|message_stop|content_block_stop|content_block_start:(text|thinking|tool_use)|content_block_delta:(text_delta|thinking_delta|signature_delta|input_json_delta))$/);
    upstreamIsKeyOnly(t.api);
  }, 90_000);

  it("tool use (0005 → 0006): thinking opens and closes, the Bash call round-trips, stop_reason tool_use then end_turn", async () => {
    const recs = [recording("0005"), recording("0006")];
    const t = await run(recs);
    expect(t.result?.is_error).toBe(false);
    expect(t.api.requests.filter((r) => r.served).map((r) => r.served)).toEqual(recs.map((r) => r.file));
    const thinking = t.events.filter((e) => e.kind === "thinking").map((e) => (e as { active: boolean }).active);
    expect(thinking).toEqual([true, false]);
    expect(t.events.find((e) => e.kind === "tool_start")).toMatchObject({ name: "Bash", toolUseId: "toolu_0000000000000000000fake1" });
    expect(t.events.find((e) => e.kind === "tool_end")).toMatchObject({ toolUseId: "toolu_0000000000000000000fake1" });
    expect(JSON.stringify(t.api.requests.at(-1)!.body.messages)).toContain("toolu_0000000000000000000fake1");
    expect(runUsageOf(t.result)).toMatchObject(sum(recs));
    upstreamIsKeyOnly(t.api);
  }, 90_000);

  it("web search (0019 → 0020 → 0021): the CLI's own server-tool call streams server_tool_use, results and citations; the search and every token are reported once", async () => {
    const recs = [recording("0019"), recording("0020"), recording("0021")];
    const t = await run(recs, { tools: ["WebSearch"] });
    expect(t.result?.is_error).toBe(false);
    expect(t.api.requests.filter((r) => r.served).map((r) => r.served)).toEqual(recs.map((r) => r.file));
    expect(t.events.find((e) => e.kind === "tool_start")).toMatchObject({ name: "WebSearch" });
    // The CLI's inner call carried the server tool, as recorded.
    expect(JSON.stringify(t.api.requests.find((r) => r.served === recs[1]!.file)!.body.tools)).toContain("web_search");
    const u = runUsageOf(t.result)!;
    expect(u).toMatchObject(sum(recs)); // 0020's input is its final 13,025, not message_start's 2,984
    upstreamIsKeyOnly(t.api);
    await proxy!.stop();
    expect(t.unreported).toEqual([]); // the CLI reported the search itself: not counted a second time
  }, 90_000);

  it("thinking with a budget (0013, Haiku) and Opus adaptive thinking (0011) parse", async () => {
    for (const [id, model] of [["0013", "claude-haiku-4-5-20251001"], ["0011", "claude-opus-5-5"]] as const) {
      const t = await run([recording(id)], { model });
      expect(t.result?.is_error).toBe(false);
      expect(t.streamTypes).toContain("content_block_delta:thinking_delta");
      expect(t.streamTypes).toContain("content_block_delta:signature_delta");
      expect(runUsageOf(t.result)).toMatchObject(sum([recording(id)]));
      await proxy!.stop(); proxy = null; await api!.close(); api = null;
    }
  }, 120_000);

  it("unknown model (0037 streamed, then the CLI's non-streamed retry 0038): a plain message", async () => {
    const t = await run([recording("0037"), recording("0038")], { model: "claude-sonnet-5" });
    expect(t.result?.is_error).toBe(true);
    const c = classifyResult(t.result!, t.lastError, false);
    expect(c).toMatchObject({ trayTitle: STR_AUTH.modelUnavailable, message: STR_AUTH.modelUnavailableDetail, retryable: false });
    upstreamIsKeyOnly(t.api);
  }, 90_000);

  // The CLI reports it as an invalid_request assistant error with its own text ("Prompt is too long · the request is
  // ~207706 tokens (limit 200000) but … reduce attached files/tools …") and terminal_reason prompt_too_long. It has to
  // be BOT-E0404 (the compactor's compact-and-retry keys on it) with the host's own plain words.
  it("prompt too long (0046): BOT-E0404 (compact and retry) with a plain message, not the API's or the CLI's text", async () => {
    const t = await run([recording("0046")]);
    expect(t.result?.is_error).toBe(true);
    expect(t.lastError).toBe("invalid_request");
    const c = classifyResult(t.result!, t.lastError, false);
    expect(c?.code).toBe("BOT-E0404");
    expect(c?.message).toBe(STR_AUTH.promptTooLongDetail(207706, 200000));
    expect(c?.message).not.toMatch(/API Error|invalid_request_error|\{/);
  }, 90_000);
});
