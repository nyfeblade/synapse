import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runProbe } from "../../../brain/conformance/probe";
import type { ConformanceContext } from "../../../brain/conformance/types";

const POST_INTERRUPT_MESSAGE =
  "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";

const TOOL_USE_MSG = {
  type: "assistant", parent_tool_use_id: null,
  message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 20" } }] },
} as unknown as SDKMessage;

const ERROR_RESULT_MSG = {
  type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools",
  result: "", errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  usage: {}, total_cost_usd: 0,
} as unknown as SDKMessage;

/** A fake Query that yields `beforeThrow` messages, then throws `err` on the following `next()`. */
function makeQuery(beforeThrow: SDKMessage[], err: Error): Query {
  let step = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: async () => {
      if (step < beforeThrow.length) return { value: beforeThrow[step++], done: false };
      throw err;
    },
    return: async () => ({ value: undefined, done: true }),
    interrupt: async () => undefined,
    setModel: async () => undefined,
    close: () => undefined,
  } as unknown as Query;
}

function fakeCtx(q: Query): ConformanceContext {
  return {
    cfg: {} as never, runAs: "setpriv",
    queryFn: (() => q) as never,
    now: () => Date.now(),
    baseOptions: (extra: Partial<Options> = {}) => extra as Options,
    boxUid: async () => null,
    log: () => {},
  };
}

describe("runProbe post-interrupt throw handling (CT-03 conformance fix)", () => {
  it("treats the expected post-interrupt SDK throw as a valid, fast turn-end when interrupt() was recorded", async () => {
    const q = makeQuery([TOOL_USE_MSG, ERROR_RESULT_MSG], new Error(POST_INTERRUPT_MESSAGE));
    const ctx = fakeCtx(q);
    const run = await runProbe(ctx, {
      prompt: "irrelevant",
      onMessage: async (m, probeQ, r) => {
        const msg = m as unknown as { type: string };
        if (msg.type === "assistant" && r.interruptedAt === null) await probeQ.interrupt();
      },
    });
    expect(run.interruptedAt).not.toBeNull();
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.subtype).toBe("error_during_execution");
  });

  it("still propagates the same-shaped throw when interrupt() was never called", async () => {
    const q = makeQuery([TOOL_USE_MSG, ERROR_RESULT_MSG], new Error(POST_INTERRUPT_MESSAGE));
    const ctx = fakeCtx(q);
    await expect(runProbe(ctx, { prompt: "irrelevant" })).rejects.toThrow(POST_INTERRUPT_MESSAGE);
  });

  it("still propagates an unrelated throw even after an interrupt", async () => {
    const q = makeQuery([TOOL_USE_MSG], new Error("ECONNRESET"));
    const ctx = fakeCtx(q);
    await expect(
      runProbe(ctx, {
        prompt: "irrelevant",
        onMessage: async (m, probeQ, r) => {
          const msg = m as unknown as { type: string };
          if (msg.type === "assistant" && r.interruptedAt === null) await probeQ.interrupt();
        },
      }),
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("runProbe post-interrupt throw, stop_reason=null shape (H-3, CT-03 flake)", () => {
  it("treats the stop_reason=null post-interrupt throw as a clean turn-end after interrupt()", async () => {
    const msg = "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";
    const q = makeQuery([TOOL_USE_MSG, ERROR_RESULT_MSG], new Error(msg));
    const run = await runProbe(fakeCtx(q), {
      prompt: "irrelevant",
      onMessage: async (m, probeQ, r) => {
        const x = m as unknown as { type: string };
        if (x.type === "assistant" && r.interruptedAt === null) await probeQ.interrupt();
      },
    });
    expect(run.interruptedAt).not.toBeNull();
    expect(run.results).toHaveLength(1);
  });
});
