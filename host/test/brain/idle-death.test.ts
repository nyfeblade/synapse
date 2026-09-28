import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeBrain } from "../../brain/claude-brain";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { ProcState } from "../../brain/types";
import { loadConfig } from "../../config";
import { input, testWiring } from "./helpers";

/** A CLI that answers one message, then (while idle, between turns) exits on its own after `dieAfterMs`. */
function dyingCli(dieAfterMs: number) {
  let spawns = 0;
  const queryFn = ((p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    spawns++;
    async function* gen() {
      for await (const m of p.prompt) {
        const text = (m.message.content as { text: string }[])[0]!.text;
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: {} };
        await new Promise((r) => setTimeout(r, dieAfterMs));
        throw new Error("Claude Code process exited with code 137");
      }
    }
    return Object.assign(gen(), { close() {}, interrupt: async () => {}, setModel: async () => {} });
  }) as never;
  return { queryFn, spawns: () => spawns };
}

describe("a warm process dying while idle (review fix round 1)", () => {
  it("goes cold without a crash (no crash backoff), and the next turn spawns fresh", async () => {
    const cli = dyingCli(20);
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring({ flags: () => DEFAULT_FLAGS }), queryFn: cli.queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k" }),
    });
    const states: ProcState[] = [];
    brain.onStateChange((s) => states.push(s));
    const r1 = await brain.runTurn(input("one"), () => {});
    expect(r1.error).toBeUndefined();
    expect(brain.procState).toBe("warm_idle");
    await new Promise((r) => setTimeout(r, 60));
    expect(brain.procState).toBe("cold");
    expect(states).not.toContain("crashed");
    const r2 = await brain.runTurn(input("two"), () => {});
    expect(r2.error).toBeUndefined();
    expect(cli.spawns()).toBe(2);
  });
});
