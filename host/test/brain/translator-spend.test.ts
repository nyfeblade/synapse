import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventTranslator } from "../../brain/event-translator";
import type { TurnEvent } from "../../brain/types";
import { listCostUsd } from "../../usage/list-price";

// 5.7: the Claude brain's live spend for the header meter and the loop guard, from the stream's own usage.
const m = (x: Record<string, unknown>) => x as unknown as SDKMessage;
const spends = (evs: TurnEvent[]) => evs.filter((e): e is Extract<TurnEvent, { kind: "spend" }> => e.kind === "spend").map((e) => e.turnUsd);

describe("EventTranslator spend events", () => {
  it("prices each model call once (repeated usage of the same message never double-counts), cumulative per turn", () => {
    const t = new EventTranslator();
    t.resetTurn();
    const model = "claude-sonnet-5";
    const out: TurnEvent[] = [];
    const call = (id: string, input: number, read: number, write: number, output: number) => {
      out.push(...t.translate(m({ type: "stream_event", event: { type: "message_start", message: { id, model, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1 } } } })));
      out.push(...t.translate(m({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } })));
      // The assistant message repeats the usage (once per content block): it must not add again.
      for (let k = 0; k < 2; k++) out.push(...t.translate(m({ type: "assistant", message: { id, model, content: [], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } } })));
    };
    call("msg_1", 2000, 30_000, 1000, 400);
    call("msg_2", 500, 32_000, 0, 900);
    const want = listCostUsd(model, { inputTokens: 2500, outputTokens: 1300, cacheReadTokens: 62_000, cacheWriteTokens: 1000 });
    const s = spends(out);
    expect(s.at(-1)).toBeCloseTo(want, 5);
    expect(s).toEqual([...s].sort((a, b) => a - b)); // only ever rises
    // A new turn starts from zero.
    t.resetTurn();
    const next = spends(t.translate(m({ type: "assistant", message: { id: "msg_3", model, content: [], usage: { input_tokens: 10_000, output_tokens: 10 } } })));
    expect(next[0]).toBeCloseTo(listCostUsd(model, { inputTokens: 10_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }), 6);
  });

  it("moves in steps of at least a tenth of a cent (no event flood from token-by-token deltas)", () => {
    const t = new EventTranslator();
    t.resetTurn();
    const out: TurnEvent[] = [];
    out.push(...t.translate(m({ type: "stream_event", event: { type: "message_start", message: { id: "a", model: "claude-haiku-4-5", usage: { input_tokens: 10 } } } })));
    for (let i = 1; i <= 500; i++) out.push(...t.translate(m({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: i } } })));
    expect(spends(out).length).toBeLessThanOrEqual(3);
  });
});
