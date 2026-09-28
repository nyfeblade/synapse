import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { compactQueryOptions, runCompactQuery } from "../../context/compact-query";
import { patchCtx, readCtx } from "../../context/context-meter";
import { Compactor } from "../../context/compactor";
import { makeRunnerHarness } from "../runner/harness";

afterEach(() => vi.useRealTimers());

describe("compact query (CT-07 path)", () => {
  it("sends /compact with the instructions on the resumed session and reports the boundary", async () => {
    let seen: { prompt: string; options: Record<string, unknown> } | null = null;
    const queryFn = ((p: never) => { seen = p; return (async function* () { yield { type: "system", subtype: "compact_boundary" }; yield { type: "result", subtype: "success", result: "" }; })(); }) as never;
    const options = compactQueryOptions({ cwd: "/workspace", tools: ["Bash"], mcpServers: { bot: {} as never } } as never, "sess-1");
    expect(await runCompactQuery({ options, instructions: "<<COMPACT_V1>>…", signal: new AbortController().signal, queryFn })).toBe(true);
    expect(seen!.prompt).toBe("/compact <<COMPACT_V1>>…");
    expect(seen!.options).toMatchObject({ resume: "sess-1", tools: [], mcpServers: {}, persistSession: true });
  });
});

describe("Compactor (ORIG-07 §07.2, §07.7)", () => {
  async function setup(flags = DEFAULT_FLAGS) {
    const compacted: string[] = [];
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }] });
    const c = new Compactor({
      bots: h.bots, runner: h.runner, trays: h.trays, flags: () => flags, now: Date.now, idleMs: 30,
      compact: async (botId) => { compacted.push(botId); return true; }, onOverflowAgain: () => compacted.push("rollover"),
    });
    return { h, c, compacted };
  }

  it("compacts only when over 70% (or 1,000 turns), idle, and nothing is waiting", async () => {
    const { h, c, compacted } = await setup();
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    patchCtx(h.bots, id, { ratio: 0.5, lastTurnEndAt: Date.now() - 60_000 });
    expect(c.shouldCompact(id)).toBe(false);
    patchCtx(h.bots, id, { ratio: 0.72 });
    h.bots.setAwaiting(id, { tabId: "widget", reason: "Q", since: 1 });
    expect(c.shouldCompact(id)).toBe(false);
    h.bots.setAwaiting(id, null);
    expect(c.shouldCompact(id)).toBe(true);
    patchCtx(h.bots, id, { ratio: 0.1, turnsSinceCompact: 1000 });
    expect(c.shouldCompact(id)).toBe(true);
    c.hooks().onIdle!(id);
    await new Promise((r) => setTimeout(r, 200));
    await h.untilIdle(id);
    expect(compacted).toEqual([id]);
    expect(readCtx(h.bots, id)).toMatchObject({ compactions: 1, restorePending: true, turnsSinceCompact: 0 });
  });

  /**
   * Token diet (2). Chief of Staff (4e04d6af, usage.db 2026-09-20/21) runs on the 1M window and
   * re-read 145–190k tokens on every call: at 70% of 1M the ratio trigger would wait for 700k. The
   * absolute trigger compacts at 180k whatever the window (90% of 200k), unless the user
   * chose to keep more history for this Bot.
   */
  it("compacts at idle once history reaches 150k tokens (cost-diet-2 lever 6; was 180k), even on a 1M window", async () => {
    const { h, c } = await setup();
    const id = h.bots.create({ name: "Chief", origin: "user", kickstart: false });
    patchCtx(h.bots, id, { ctxTokens: 145_000, window: 1_000_000, ratio: 0.145, lastTurnEndAt: Date.now() - 60_000 });
    expect(c.shouldCompact(id)).toBe(false);
    patchCtx(h.bots, id, { ctxTokens: 155_000, ratio: 0.155 });
    expect(c.shouldCompact(id)).toBe(true);
    // Straight away once idle, like a 90% self-summary: no 30 s wait on a big context.
    patchCtx(h.bots, id, { lastTurnEndAt: Date.now() });
    expect(c.shouldCompact(id)).toBe(true);
  });

  it("\"Keep more history\" moves the trigger for that Bot only", async () => {
    const { h, c } = await setup();
    const id = h.bots.create({ name: "Chief", origin: "user", kickstart: false });
    h.bots.updateSettings(id, { advanced: { historyKeep: "more" } });
    patchCtx(h.bots, id, { ctxTokens: 185_000, window: 1_000_000, ratio: 0.185, lastTurnEndAt: Date.now() - 60_000 });
    expect(c.shouldCompact(id)).toBe(false);
    patchCtx(h.bots, id, { ctxTokens: 410_000, ratio: 0.41 });
    expect(c.shouldCompact(id)).toBe(true);
    h.bots.updateSettings(id, { advanced: { historyKeep: "full" } });
    expect(c.shouldCompact(id)).toBe(false);
  });

  it("tells the history archive about every finished compaction: the host's /compact and the CLI's own", async () => {
    const seen: [string, string][] = [];
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }] });
    const c = new Compactor({
      bots: h.bots, runner: h.runner, trays: h.trays, flags: () => DEFAULT_FLAGS, now: Date.now, idleMs: 30,
      compact: async () => true, onOverflowAgain: () => {}, onCompacted: (botId, how) => seen.push([botId, how]),
    });
    const id = h.bots.create({ name: "Chief", origin: "user", kickstart: false });
    c.compactNow(id, "user");
    await h.untilIdle(id);
    c.hooks().onEvent!(id, { kind: "compact_boundary" } as never, {} as never);
    expect(seen).toEqual([[id, "user"], [id, "auto"]]);
  });

  it("is off when CT-07 fell back to auto-only", async () => {
    const { h, c } = await setup({ ...DEFAULT_FLAGS, compactPath: "auto-only" });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    patchCtx(h.bots, id, { ratio: 0.9, lastTurnEndAt: 0 });
    expect(c.shouldCompact(id)).toBe(false);
    expect(c.compactNow(id, "user")).toBe(false);
  });

  it("on BOT-E0404 compacts and retries once, then asks for a rollover", async () => {
    const { h, c, compacted } = await setup();
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    const retry = vi.spyOn(h.runner, "retryUserTurn").mockReturnValue(true);
    const overflow = { source: "user" as const, lane: "user" as const, hidden: false, requestId: "r", turnNo: 1, userSeqMax: 1, userTexts: ["x"], sentTexts: [], finalText: "", aborted: false, superseded: false, error: { code: "BOT-E0404" as const, message: "prompt is too long", retryable: false, trayTitle: "Bot failed to respond" }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, startedAt: 0, firstEventAt: null, endedAt: 1 };
    c.hooks().afterSettle!(id, overflow);
    await h.untilIdle(id);
    expect(compacted).toEqual([id]);
    expect(retry).toHaveBeenCalledTimes(1);
    c.hooks().afterSettle!(id, overflow);
    expect(compacted).toEqual([id, "rollover"]);
  });
});
