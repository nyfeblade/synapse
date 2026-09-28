import { describe, expect, it } from "vitest";
import { compactInstructions, contextView, createContextMeterHooks, readCtx } from "../../context/context-meter";
import { makeRunnerHarness } from "../runner/harness";

describe("context meter and epochs (ORIG-07 §07.1, §07.3)", () => {
  it("records ctx tokens and ratio from context events, counts turns, and bumps the epoch on compact_boundary", async () => {
    let step = 0;
    const h = await makeRunnerHarness({
      hooksFactory: (bots) => createContextMeterHooks({ bots, modelOf: () => "claude-sonnet-5", now: Date.now }),
      script: () => (step++ === 0 ? [{ context: 150_000 }, { tool: "mcp__bot__SendMessage", input: { content: "a" } }] : [{ compact: true }, { context: 20_000 }, { tool: "mcp__bot__SendMessage", input: { content: "b" } }]),
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "one", "n1");
    await h.untilIdle(id);
    expect(readCtx(h.bots, id)).toMatchObject({ ctxTokens: 150_000, window: 200_000, ratio: 0.75, turnsSinceCompact: 1, compactions: 0, restorePending: false });
    const e0 = h.bots.compactionEpoch(id);
    h.runner.sendPrompt(id, "two", "n2");
    await h.untilIdle(id);
    expect(h.bots.compactionEpoch(id)).toBe(e0 + 1);
    expect(readCtx(h.bots, id)).toMatchObject({ ctxTokens: 20_000, ratio: 0.1, compactions: 1, restorePending: true, turnsSinceCompact: 1 });
    expect(contextView(h.bots, id, 1234)).toMatchObject({ ctxTokens: 20_000, window: 200_000, compactions: 1, sessionBytes: 1234 });
  });

  it("fills the COMPACT_V1 instructions", () => {
    const t = compactInstructions({ botName: "Piper", botId: "b1" });
    expect(t.startsWith("<<COMPACT_V1>>\nSummarize this conversation so you can continue it seamlessly. You are Piper;")).toBe(true);
    // Bug #61: the transcript mirror is host-private; the summary points at SearchHistory, never a path.
    expect(t.trimEnd().endsWith('"Full history: search it with SearchHistory (it has everything summarised away)."')).toBe(true);
  });
});
