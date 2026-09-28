import { describe, expect, it } from "vitest";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBrain } from "../../brain/claude-brain";
import { loadConfig } from "../../config";
import { input, testWiring } from "./helpers";

/**
 * A stand-in SDK Query with two knobs the shared fake in claude-brain.test.ts does not have:
 *  - `exitDelayMs`: how long the CLI takes to finish after its input is ended, i.e. how long
 *    `cool()` stays in the "cooling" state.
 *  - `interruptRejects`: Query.interrupt() rejecting, which the real SDK does whenever the CLI answers
 *    the control request with an error or dies while the request is still pending.
 * A prompt of "HANG" is never answered, so the turn stays in flight until it is interrupted.
 */
function slowFake(o: { exitDelayMs?: number; interruptRejects?: boolean } = {}) {
  const spawned: Options[] = [];
  let closed = 0;
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    spawned.push(params.options);
    const out: unknown[] = [];
    const waiters: ((v: IteratorResult<unknown>) => void)[] = [];
    let done = false;
    let hung = false;
    const emit = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else out.push(m); };
    const finish = () => { done = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }); };
    const result = (isError: boolean) => emit({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result: "", errors: [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: {} });
    (async () => {
      emit({ type: "system", subtype: "init", session_id: params.options.sessionId ?? params.options.resume, model: params.options.model, tools: [], claude_code_version: "2.1.277" });
      for await (const msg of params.prompt) {
        const text = (msg.message.content as { text: string }[])[0]!.text;
        if (text === "HANG") { hung = true; continue; }
        emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: `echo ${text}` }] } });
        result(false);
      }
      if (o.exitDelayMs) await new Promise((r) => setTimeout(r, o.exitDelayMs));
      finish();
    })();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => (out.length ? Promise.resolve({ value: out.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiters.push(r))),
      return: async () => { finish(); return { value: undefined, done: true }; },
      interrupt: async () => {
        if (hung) { hung = false; result(true); }
        if (o.interruptRejects) throw Object.assign(new Error("control request failed"), { errorClass: "control_request_failed" });
      },
      setModel: async () => {},
      close: () => { closed++; finish(); },
    } as unknown as Query;
  }) as never;
  return { queryFn, spawned, closedCount: () => closed };
}

function makeBrain(f: ReturnType<typeof slowFake>) {
  let session: string | null = null;
  return new ClaudeBrain({
    botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn: f.queryFn,
    getSessionId: () => session, setSessionId: (id) => { session = id; },
    spawnConfig: () => ({ model: "claude-sonnet-5", systemAppend: "P", env: {}, spawnKey: "k1" }),
  });
}

describe("ClaudeBrain: a turn admitted during the cooling transition (ENG-01)", () => {
  it("waits out the in-flight cool() and spawns a fresh query instead of pushing into the closed input queue", async () => {
    const f = slowFake({ exitDelayMs: 40 });
    const brain = makeBrain(f);
    await brain.runTurn(input("one"), () => {});
    expect(brain.procState).toBe("warm_idle");

    // Supervisor.tick() starts the idle cool for a brain that holds no lease; the await yields the
    // event loop for as long as the CLI takes to exit. A user message (or a peer wake) admitted
    // inside that window lands here, because tryAdmit's NOT_LIVE list is ["cold", "crashed"] only.
    const cooling = brain.cool("idle");
    expect(brain.procState).toBe("cooling");

    const r = await brain.runTurn(input("two"), () => {});
    await cooling;

    expect(r.finalText).toBe("echo two");
    expect(r.error).toBeUndefined();
    expect(f.spawned).toHaveLength(2); // the cooled query, then a fresh one for the admitted turn
  });

  it("the prompt reaches a live CLI rather than throwing 'AsyncQueue is closed'", async () => {
    const f = slowFake({ exitDelayMs: 40 });
    const brain = makeBrain(f);
    await brain.runTurn(input("one"), () => {});
    const cooling = brain.cool("idle");
    // A rejection here is the user's message (or a peer batch already taken out of the mailbox)
    // vanishing with nothing but one log line.
    await expect(brain.runTurn(input("two"), () => {})).resolves.toMatchObject({ finalText: "echo two" });
    await cooling;
  });
});

describe("ClaudeBrain.interrupt() when the SDK control request rejects (ENG-04)", () => {
  it("swallows the control-request rejection instead of propagating it to its caller", async () => {
    const f = slowFake({ interruptRejects: true });
    const brain = makeBrain(f);
    const turn = brain.runTurn(input("HANG"), () => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(brain.procState).toBe("running");

    await expect(brain.interrupt("bot deleted")).resolves.toBeUndefined();
    await expect(turn).resolves.toMatchObject({ aborted: true });
    expect(brain.procState).not.toBe("interrupted");
  }, 20_000);
});
