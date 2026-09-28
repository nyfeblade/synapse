import { describe, expect, it } from "vitest";
import { mergeExtensions } from "../../tools/registry";
import { makeRunnerHarness } from "../runner/harness";

describe("bot tool registry", () => {
  it("routes SendMessage types and update_state targets to registered handlers", async () => {
    const seen: string[] = [];
    const ext = mergeExtensions([
      { sendTypes: { widget: (c) => { const e = c.deliver({ type: "widget", widget: { question: String(c.args.content), options: [{ label: "A", value: "a" }] } }, { status: "pending" }); seen.push(e.id); return { text: "Asked." }; } } },
      { updateState: { memory: (c) => { seen.push(`mem:${String(c.args.content)}`); return { text: "Remembered." }; } } },
    ]);
    const h = await makeRunnerHarness({
      toolExtensions: ext,
      script: () => [
        { tool: "mcp__bot__SendMessage", input: { type: "widget", content: "Which?" } },
        { tool: "mcp__bot__update_state", input: { target: "memory", action: "add", content: "likes tea" } },
      ],
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "hi", "n1");
    await h.untilIdle(id);
    expect(seen[0]).toMatch(/^t1s1$/);
    expect(seen[1]).toBe("mem:likes tea");
    const widget = h.bots.getEntry(id, "t1s1");
    expect(widget).toMatchObject({ kind: "send-message", status: "pending", message: { type: "widget" } });
  });

  it("auto-threads a text send to the replied entry unless reply_to is set (CHAT-11)", async () => {
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "about that" } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "first", "n1");
    await h.untilIdle(id);
    h.runner.sendPrompt(id, "follow-up", "n2", { replyToId: "t1s1" });
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t2s1")).toMatchObject({ replyToId: "t1s1", branched: true });
  });

  it("rejects unregistered types with the Phase 1 text", async () => {
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { type: "card", card: {} } }, { tool: "mcp__bot__SendMessage", input: { content: "ok" } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "hi", "n1");
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t1s1")).toMatchObject({ message: { type: "text", content: "ok" } });
  });
});
