import { describe, expect, it } from "vitest";
import { traceLine, traceOf } from "../../../bench/coding/trace";

/**
 * Bug-log 75: the per-call trace, from Claude Code's own events (CLI stream-json lines or a Bot's session
 * JSONL; same shape). Fixture: an engineering Bot that acks as a call of its own, works, sends a progress
 * note as another call, then sends the result.
 */
const u = (read: number, write: number, out: number) => ({ input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });
const asst = (id: string, usage: object, blocks: object[]) => JSON.stringify({ type: "assistant", message: { id, usage, content: blocks } });
const tool = (name: string, input: object = {}) => ({ type: "tool_use", id: `tu-${Math.random()}`, name, input });
const result = (text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: text }] } });
const SEND = "mcp__bot__SendMessage";

const LINES = [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[t1u] fix it" }, { type: "text", text: "<system_reminder>Reply with SendMessage.</system_reminder>" }] } }),
  asst("m1", u(10_000, 5_000, 80), [tool(SEND, { text: "On it." })]),
  result("Sent."),
  asst("m2", u(15_000, 300, 60), [{ type: "thinking", thinking: "" }]),
  asst("m2", u(15_000, 300, 60), [tool("Bash", { command: "npm test" })]), // same message, second line: counted once
  result("x".repeat(1200) + "<system_reminder>Several tool calls have gone by without a SendMessage.</system_reminder>"),
  asst("m3", u(16_000, 900, 40), [tool(SEND, { text: "Found it." })]),
  result("Sent."),
  asst("m4", u(17_000, 200, 500), [tool("Edit", { file_path: "a.ts" }), tool("Bash", { command: "npm test" })]),
  result("ok"),
  result("passed"),
  JSON.stringify({ type: "assistant", parent_tool_use_id: "task-1", message: { id: "sub-1", usage: u(99_000, 0, 9), content: [tool("Read")] } }),
  asst("m5", u(18_000, 100, 120), [tool(SEND, { text: "Fixed.", end_turn: true })]),
];

describe("traceOf", () => {
  it("counts one call per message id, its tools, and the sends that were calls of their own", () => {
    const t = traceOf(LINES);
    expect(t.calls).toBe(5);
    expect(t.perCall.map((r) => r.tools)).toEqual([["SendMessage"], ["Bash"], ["SendMessage"], ["Edit", "Bash"], ["SendMessage"]]);
    expect(t.sendOnlyCalls).toBe(2); // m1 (ack) and m3 (progress); m5 is the result
    expect(t.toolCalls).toEqual({ SendMessage: 3, Bash: 2, Edit: 1 });
    expect(t.usage).toEqual({ fresh: 10, cacheRead: 76_000, cacheWrite: 6_500, output: 800 });
    expect(t.weighted).toBeCloseTo(10 + 7_600 + 8_125);
    expect(t.maxInput).toBe(18_102);
    expect(t.reminders).toBe(2);
    expect(t.commands).toEqual(["npm test", "npm test"]);
    expect(t.toolResultChars).toBeGreaterThan(1200);
  });

  it("leaves out calls an earlier task of the same session already counted, with their results", () => {
    const first = traceOf(LINES.slice(0, 6));
    const t = traceOf(LINES, new Set(first.ids));
    expect(t.calls).toBe(3);
    expect(t.reminders).toBe(0);
    expect(t.toolResultChars).toBe("Sent.".length + "ok".length + "passed".length);
  });

  it("splits wall time into tool waits (hooks, review, the command) and the rest, when lines carry timestamps", () => {
    const ts = (l: string, iso: string) => JSON.stringify({ ...JSON.parse(l), timestamp: iso });
    const t = traceOf([
      ts(asst("a1", u(1, 1, 1), [tool("Bash")]), "2026-09-22T12:00:05.000Z"),
      ts(result("ok"), "2026-09-22T12:00:13.000Z"), // 8 s in the tool (its review included)
      ts(asst("a2", u(1, 1, 1), [tool(SEND)]), "2026-09-22T12:00:16.000Z"),
    ]);
    expect(t.toolWaitMs).toBe(8_000);
    expect(traceOf(LINES).toolWaitMs).toBeNull();
  });

  it("reads nothing from junk and renders a report line", () => {
    const t = traceOf(["", "not json", JSON.stringify({ type: "system" })]);
    expect([t.calls, t.avgInput, t.sendOnlyCalls]).toEqual([0, 0, 0]);
    expect(traceLine(traceOf(LINES))).toBe("5 calls · input/call avg 16.5k max 18.1k · send-only calls 2 · reminders 2 · tool results 1.3k chars · tools SendMessage×3 Bash×2 Edit×1");
  });
});
