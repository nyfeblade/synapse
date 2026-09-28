import { describe, expect, it } from "vitest";
import { StubOneShot } from "../../brain/one-shot";
import { createMemoryEngineHooks } from "../../memory/engine";
import { EpisodeWriter } from "../../memory/episodes";
import { MemoryExtractor } from "../../memory/extractor";
import { MemoryStore } from "../../memory/memory-store";
import { makeRunnerHarness } from "../runner/harness";

describe("memory engine afterSettle (MEM-06, §05.2)", () => {
  // cost-diet-2 lever 4: memorable exchanges are extracted in batches of EXTRACTION_BATCH (one helper call for
  // the three here, all three exchanges in its input), never a trivial one; episodes still come every 6 turns.
  it("extracts memorable visible turns in one batched call, skips trivial ones, and writes an episode every 6 turns", async () => {
    const calls: string[] = [];
    const inputs: string[] = [];
    let hooks: ReturnType<typeof createMemoryEngineHooks> | null = null;
    const h = await makeRunnerHarness({
      script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "Done." } }],
      hooksFactory: (bots, cfg) => {
        const store = new MemoryStore({ cfg });
        const model = new StubOneShot((p) => { calls.push(p.system.includes("journal") ? "episode" : "extract"); if (!p.system.includes("journal")) inputs.push(p.user); return p.system.includes("journal") ? "The user asked for six things and Piper did them." : "NONE"; });
        const opts = { store, model, timeZone: () => "UTC", nameOf: () => "Piper", secrets: () => [] };
        hooks = createMemoryEngineHooks({ extractor: new MemoryExtractor(opts), episodes: new EpisodeWriter({ ...opts, bots }) });
        return hooks;
      },
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const texts = ["thanks", "Can you check the flight prices for Denver next week?", "ok", "Please draft the Q3 update for Dana with the numbers", "cool", "What did we decide about the newsletter?"];
    for (const [i, t] of texts.entries()) { h.runner.sendPrompt(id, t, `n${i}`); await h.untilIdle(id); }
    await hooks!.drain();
    expect(calls.filter((c) => c === "extract")).toHaveLength(1);
    expect(calls.filter((c) => c === "episode")).toHaveLength(1);
    const sent = JSON.parse(inputs[0]!) as { exchanges: { user: string }[] };
    expect(sent.exchanges.map((e) => e.user)).toEqual([texts[1], texts[3], texts[5]]);
  });

  function engine(o: { idleMs?: number; batch?: number; pendingStore?: Map<string, unknown> } = {}) {
    const runs: { botId: string; n: number }[] = [];
    const extractor = { run: async (botId: string, ex: unknown) => { runs.push({ botId, n: Array.isArray(ex) ? ex.length : 1 }); return { added: 0, removed: 0 }; } };
    const episodes = { note: async () => false };
    const store = o.pendingStore ?? new Map<string, unknown>();
    const hooks = createMemoryEngineHooks({
      extractor: extractor as never, episodes: episodes as never, batch: o.batch ?? 3, idleMs: o.idleMs ?? 60_000,
      pending: { get: (b) => (store.get(b) as { user: string; bot: string; at: number }[] | undefined) ?? [], set: (b, v) => { store.set(b, v); } },
    });
    const turn = (botId: string, text: string, at = 0) => hooks.afterSettle!(botId, { source: "user", lane: "user", hidden: false, requestId: "r", turnNo: 1, userSeqMax: 1, userTexts: [text], sentTexts: ["ok"], finalText: "", aborted: false, superseded: false, error: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, startedAt: at, firstEventAt: at, endedAt: at } as never);
    return { hooks, runs, turn, store };
  }
  const Q = (n: number) => `Question number ${n}: what did we decide about the newsletter?`;

  it("flushes a full batch at once, a partial one after the idle delay, and never loses an exchange", async () => {
    const e = engine({ idleMs: 30 });
    for (const n of [1, 2, 3, 4]) e.turn("b", Q(n));
    await new Promise((r) => setTimeout(r, 5));
    expect(e.runs).toEqual([{ botId: "b", n: 3 }]);
    await new Promise((r) => setTimeout(r, 80));
    await e.hooks.drain();
    expect(e.runs).toEqual([{ botId: "b", n: 3 }, { botId: "b", n: 1 }]);
  });

  it("keeps the pending batch where a restart finds it, drains it on shutdown, and drops it with its Bot", async () => {
    const store = new Map<string, unknown>();
    const a = engine({ pendingStore: store });
    a.turn("b", Q(1)); a.turn("c", Q(2));
    const b = engine({ pendingStore: store }); // a restart: the same store, a fresh engine
    b.turn("b", Q(3));
    await b.hooks.dropBot("c");
    await b.hooks.drain();
    expect(b.runs).toEqual([{ botId: "b", n: 2 }]);
    expect(store.get("b")).toEqual([]);
  });
});
