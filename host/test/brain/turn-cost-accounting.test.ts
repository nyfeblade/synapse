import { afterEach, describe, expect, it } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBrain } from "../../brain/claude-brain";
import { loadConfig } from "../../config";
import { setUsageSink, type SessionTotals, type UsageSink } from "../../usage/metered-query";
import { input, testWiring } from "./helpers";

/**
 * The SDK's result carries RUNNING totals: `total_cost_usd` and `modelUsage` are cumulative for the
 * whole query() call (and a resumed session continues from the total its transcript saved). A turn
 * must record only its OWN share. Live evidence: one Bot's recorded cost rose 0.061 → 0.074 → … → 1.807
 * over consecutive messages and the Usage view summed those running totals.
 */
function cumulativeQuery(totals: number[], opts: { sessionId?: string } = {}) {
  const spawned: Options[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    spawned.push(params.options);
    const out: unknown[] = [];
    const waiters: ((v: IteratorResult<unknown>) => void)[] = [];
    let done = false;
    const emit = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else out.push(m); };
    const sid = opts.sessionId ?? params.options.resume ?? params.options.sessionId ?? "s-new";
    let i = 0;
    (async () => {
      emit({ type: "system", subtype: "init", session_id: sid, model: params.options.model, tools: [], claude_code_version: "2.1.277" });
      for await (const _msg of params.prompt) {
        const total = totals[i++] ?? 0;
        // Tokens grow with the running cost so a delta is checkable: 1000 input tokens per cent.
        const t = Math.round(total * 100_000);
        emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "ok" }] } });
        emit({
          type: "result", subtype: "success", is_error: false, result: "", errors: [], session_id: sid,
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          total_cost_usd: total,
          modelUsage: { "claude-sonnet-5": { inputTokens: t, outputTokens: t / 10, cacheReadInputTokens: t * 2, cacheCreationInputTokens: t / 5, webSearchRequests: 0, costUSD: total, contextWindow: 200_000, maxOutputTokens: 32_000 } },
        });
      }
      done = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    })();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => (out.length ? Promise.resolve({ value: out.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiters.push(r))),
      return: async () => ({ value: undefined, done: true }),
      interrupt: async () => {},
      setModel: async () => {},
      close: () => { done = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }); },
    };
  }) as never;
  return { queryFn, spawned };
}

function memorySink(seed: Record<string, SessionTotals> = {}): UsageSink & { recorded: unknown[] } {
  const totals = new Map(Object.entries(seed));
  const recorded: unknown[] = [];
  return {
    recorded,
    record: (r) => { recorded.push(r); },
    lastTotals: (sid) => totals.get(sid) ?? null,
    noteTotals: (sid, t) => { totals.set(sid, t); },
  };
}

function brainOn(queryFn: never, session: string | null) {
  let sid = session;
  return new ClaudeBrain({
    botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
    getSessionId: () => sid, setSessionId: (id) => { sid = id; },
    spawnConfig: () => ({ model: "claude-sonnet-5", systemAppend: "P", env: {}, spawnKey: "k" }),
  });
}

afterEach(() => setUsageSink(null));

describe("per-run turn cost (the SDK reports running totals)", () => {
  it("two consecutive runs of one session each record their OWN cost and tokens", async () => {
    setUsageSink(memorySink());
    const f = cumulativeQuery([0.10, 0.25]);
    const brain = brainOn(f.queryFn, null);
    const r1 = await brain.runTurn(input("one"), () => {});
    const r2 = await brain.runTurn(input("two"), () => {});
    expect(r1.usage.costUsd).toBeCloseTo(0.10, 6);
    expect(r2.usage.costUsd).toBeCloseTo(0.15, 6);
    expect(r2.usage).toMatchObject({ inputTokens: 15_000, outputTokens: 1_500, cacheReadTokens: 30_000, cacheWriteTokens: 3_000 });
    await brain.dispose();
  });

  it("a resumed session subtracts the total its transcript restored (host restart, then the next message)", async () => {
    setUsageSink(memorySink({ s1: { costUsd: 0.25, inputTokens: 25_000, outputTokens: 2_500, cacheReadTokens: 50_000, cacheWriteTokens: 5_000 } }));
    const f = cumulativeQuery([0.40]);
    const brain = brainOn(f.queryFn, "s1");
    const r = await brain.runTurn(input("again"), () => {});
    expect(f.spawned[0]!.resume).toBe("s1");
    expect(r.usage.costUsd).toBeCloseTo(0.15, 6);
    expect(r.usage.inputTokens).toBe(15_000);
    await brain.dispose();
  });

  it("a running total that went DOWN is a fresh count (new session, /clear, or a transcript that restored nothing)", async () => {
    setUsageSink(memorySink({ s1: { costUsd: 0.25, inputTokens: 25_000, outputTokens: 2_500, cacheReadTokens: 50_000, cacheWriteTokens: 5_000 } }));
    const f = cumulativeQuery([0.05, 0.09]);
    const brain = brainOn(f.queryFn, "s1");
    const r1 = await brain.runTurn(input("a"), () => {});
    const r2 = await brain.runTurn(input("b"), () => {});
    expect(r1.usage.costUsd).toBeCloseTo(0.05, 6);
    expect(r2.usage.costUsd).toBeCloseTo(0.04, 6);
    await brain.dispose();
  });

  it("a fork starts from the parent's restored total, and the forked session keeps its own chain", async () => {
    const sink = memorySink({ parent: { costUsd: 1, inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000, cacheWriteTokens: 20_000 } });
    setUsageSink(sink);
    const f = cumulativeQuery([1.2, 1.5], { sessionId: "child" });
    const brain = brainOn(f.queryFn, "parent");
    const r1 = await brain.runTurn(input("a"), () => {});
    const r2 = await brain.runTurn(input("b"), () => {});
    expect(r1.usage.costUsd).toBeCloseTo(0.2, 6);
    expect(r2.usage.costUsd).toBeCloseTo(0.3, 6);
    expect(sink.lastTotals("child")?.costUsd).toBeCloseTo(1.5, 6);
    await brain.dispose();
  });
});
