import { describe, expect, it } from "vitest";
import { FakeBrain } from "../../brain/fake-brain";
import type { TurnEvent } from "../../brain/types";
import { input, testWiring } from "./helpers";

describe("FakeBrain", () => {
  it("spawns once, runs tools through the wiring and settles warm", async () => {
    const states: string[] = [];
    const events: TurnEvent[] = [];
    const b = new FakeBrain("bot1", testWiring(), () => [
      { tool: "Bash", input: { command: "ls" } },
      { tool: "mcp__bot__SendMessage", input: { content: "done" } },
      { text: "private" },
    ]);
    b.onStateChange((s) => states.push(s));
    const r = await b.runTurn(input(), (e) => events.push(e));
    expect(states).toEqual(["spawning", "running", "warm_idle"]);
    expect(events.filter((e) => e.kind === "session")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "tool_start").map((e) => (e as { name: string }).name)).toEqual(["Bash", "mcp__bot__SendMessage"]);
    expect(r).toMatchObject({ sentMessageCount: 1, toolCallCount: 2, finalText: "private", aborted: false });
    await b.runTurn(input(), () => {});
    expect(states.slice(3)).toEqual(["running", "warm_idle"]);
  });

  it("routes ask to canUseTool and reports the deny text as the tool error", async () => {
    const ends: TurnEvent[] = [];
    const b = new FakeBrain("bot1", testWiring({
      preToolUse: async () => ({ decision: "ask", reason: "needs you" }),
      canUseTool: async () => ({ behavior: "deny", message: "Auto-review stopped this action: x." }),
    }), () => [{ tool: "Bash", input: { command: "rm -rf /tmp/x" } }]);
    await b.runTurn(input(), (e) => e.kind === "tool_end" && ends.push(e));
    expect(ends[0]).toMatchObject({ isError: true, output: "Auto-review stopped this action: x." });
  });

  it("keeps going when the Stop hook blocks, feeding the nudge back to the script", async () => {
    let stops = 0;
    const counters = { sentMessageCount: 0 };
    const b = new FakeBrain("bot1", testWiring({
      stop: async () => (++stops === 1 ? { block: true, reason: "send it" } : { block: false }),
    }, counters), (_i, ctx) => (ctx.nudge ? [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }] : [{ text: "forgot to send" }]));
    const r = await b.runTurn(input(), () => {});
    expect(r.sentMessageCount).toBe(1);
    expect(stops).toBe(2);
  });

  it("aborts on interrupt and returns to warm_idle; cool goes cold", async () => {
    const b = new FakeBrain("bot1", testWiring(), () => [{ wait: 5000 }, { tool: "Bash", input: { command: "ls" } }]);
    const p = b.runTurn(input(), () => {});
    await new Promise((r) => setTimeout(r, 20));
    await b.interrupt("user message");
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.toolCallCount).toBe(0);
    expect(b.procState).toBe("warm_idle");
    await b.cool("idle");
    expect(b.procState).toBe("cold");
  });

  it("emits all tool_starts of a parallel step with one messageId before running them", async () => {
    const events: TurnEvent[] = [];
    const b = new FakeBrain("bot1", testWiring(), () => [{ parallel: [
      { tool: "mcp__claude_ai_Gmail__send_message", input: { to: "a@x.com" } },
      { tool: "mcp__claude_ai_Gmail__send_message", input: { to: "b@x.com" } },
    ] }]);
    await b.runTurn(input(), (e) => events.push(e));
    const kinds = events.filter((e) => e.kind === "tool_start" || e.kind === "tool_end").map((e) => e.kind);
    expect(kinds).toEqual(["tool_start", "tool_start", "tool_end", "tool_end"]);
    const ids = events.filter((e) => e.kind === "tool_start").map((e) => (e as { messageId: string }).messageId);
    expect(new Set(ids).size).toBe(1);
  });

  it("goes crashed then cold on a crash step and reports a retryable error", async () => {
    const states: string[] = [];
    const b = new FakeBrain("bot1", testWiring(), () => [{ crash: true }]);
    b.onStateChange((s) => states.push(s));
    const r = await b.runTurn(input(), () => {});
    expect(states.slice(-2)).toEqual(["crashed", "cold"]);
    expect(r.error).toMatchObject({ code: "BOT-E0403", retryable: true });
  });
});
