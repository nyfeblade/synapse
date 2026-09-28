import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SdkOneShot as MemoryOneShot } from "../../brain/one-shot";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SdkOneShot as StructuredOneShot } from "../../helper-model/one-shot";
import { SdkDreamLlm } from "../../memory/dreaming/sdk-llm";
import { HostSettingsStore } from "../../store/host-settings";
import { setUsageSink, type MeteredRun, type UsageSink } from "../../usage/metered-query";
import { UsageStore } from "../../usage/usage-store";

/** Background helper calls (memory extraction, episodes, dreaming, …) used to bypass the usage store entirely. */
const resultOnly = (m: Record<string, unknown>) => (() => {
  const msgs = [{ type: "system", subtype: "init", session_id: "h1" }, { type: "result", subtype: "success", is_error: false, session_id: "h1", ...m }];
  let i = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: async () => (i < msgs.length ? { value: msgs[i++], done: false } : { value: undefined, done: true }),
    return: async () => ({ value: undefined, done: true }),
    close: () => {},
  };
}) as never;
const haiku = (cost: number) => ({
  total_cost_usd: cost,
  usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-haiku-4-5": { inputTokens: 900, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost, contextWindow: 200_000, maxOutputTokens: 8_000 } },
});

function captureSink(): UsageSink & { runs: MeteredRun[] } {
  const runs: MeteredRun[] = [];
  return { runs, record: (r) => { runs.push(r); }, lastTotals: () => null, noteTotals: () => {} };
}

afterEach(() => setUsageSink(null));

describe("every host model call is recorded, tagged by purpose and Bot", () => {
  it("memory extraction and episode calls (Haiku one-shots) record their cost for the Bot they served", async () => {
    const sink = captureSink();
    setUsageSink(sink);
    const m = new MemoryOneShot({ env: {}, cwd: "/tmp", queryFn: resultOnly({ ...haiku(0.0021), result: "NONE" }) });
    await m.complete({ system: "s", user: "u", tag: { purpose: "extraction", botId: "b1" } });
    await m.complete({ system: "s", user: "u", tag: { purpose: "episode", botId: "b2" } });
    expect(sink.runs.map((r) => [r.purpose, r.botId, r.usage.costUsd, r.usage.inputTokens])).toEqual([["extraction", "b1", 0.0021, 900], ["episode", "b2", 0.0021, 900]]);
  });

  it("structured helper calls and dreaming are recorded too", async () => {
    const sink = captureSink();
    setUsageSink(sink);
    await new StructuredOneShot({ env: {}, cwd: "/tmp", queryFn: resultOnly({ ...haiku(0.001), structured_output: { ok: true } }) })
      .run({ prompt: "orig/b2b-gate.md", input: {}, schema: {}, timeoutMs: 1000, botId: "b3" });
    await new SdkDreamLlm({ env: {}, cwd: "/tmp", queryFn: resultOnly({ ...haiku(0.003), result: "{\"changes\":[]}" }) }).verify({}, "b4");
    expect(sink.runs.map((r) => [r.purpose, r.botId, r.usage.costUsd])).toEqual([["b2b-gate", "b3", 0.001], ["dreaming", "b4", 0.003]]);
  });

  it("the usage store keeps them as background rows, not turns, and breaks the week down by purpose", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-helpers-"));
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    const now = Date.UTC(2026, 8, 17, 15);
    const bots = { has: () => true, summary: (id: string) => ({ id, profile: { name: id } }) } as never;
    const s = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => now });
    const u = (c: number) => ({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: c });
    s.record({ purpose: "extraction", botId: "b1", model: "claude-haiku-4-5", usage: u(0.002), sessionId: null });
    s.record({ purpose: "episode", botId: "b1", model: "claude-haiku-4-5", usage: u(0.001), sessionId: null });
    s.record({ purpose: "review", botId: null, model: "claude-haiku-4-5", usage: u(0.0005), sessionId: null });
    s.onSettled({ botId: "b1", requestId: "r1", lane: "user", source: "user", hidden: false, startedAt: now, endedAt: now + 1, model: "claude-sonnet-5", userText: "", sentTexts: [],
      result: { sentMessageCount: 1, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false, usage: u(0.05), finalText: "", toolCallCount: 0, model: "claude-sonnet-5" } } as never);
    expect(s.rows()).toEqual([expect.objectContaining({ botId: "b1", turns: 1, costUsd: 0.05 })]);
    expect(s.weekCostUsd()).toBeCloseTo(0.0535, 4);
    expect(s.purposes()).toEqual([
      { group: "conversations", costUsd: 0.05, calls: 1, tokens: 110 },
      { group: "memory", costUsd: 0.003, calls: 2, tokens: 220 },
      { group: "helpers", costUsd: 0.0005, calls: 1, tokens: 110 },
    ]);
    s.close();
  });
});
