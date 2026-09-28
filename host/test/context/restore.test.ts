import { describe, expect, it } from "vitest";
import { patchCtx } from "../../context/context-meter";
import { buildRestoreBlock, createRestoreHooks } from "../../context/restore";
import { makeRunnerHarness } from "../runner/harness";

describe("context-restore block (ORIG-07 §07.4)", () => {
  it("lists waiting items, unacked messages, todos, the last said and sent, and the history path", async () => {
    const h = await makeRunnerHarness({
      hooksFactory: (bots, cfg) => createRestoreHooks({ bots, dataRoot: cfg.dataRoot }),
      script: (input) => (input.prompt.some((p) => "text" in p && p.text.includes("plan")) ? [{ tool: "TodoWrite", input: { todos: [{ content: "Email Dana", status: "pending" }, { content: "Book hotel", status: "completed" }] } }, { tool: "mcp__bot__SendMessage", input: { content: "Planned." } }] : [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }]),
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "plan the trip", "n1");
    await h.untilIdle(id);
    h.bots.setAwaiting(id, { tabId: "auto-review", reason: "Approval needed: send 5 emails", since: 1 });
    const block = buildRestoreBlock({ bots: h.bots, botId: id, dataRoot: h.cfg.dataRoot });
    expect(block.startsWith("<system_reminder><context_restore>\nYour conversation was just summarized. Facts from the app (authoritative):")).toBe(true);
    expect(block).toContain("- Waiting on the user: Approval needed: send 5 emails");
    expect(block).toContain("- Unacknowledged user messages: none");
    expect(block).toContain("- Your open todo list: Email Dana");
    expect(block).not.toContain("Book hotel");
    expect(block).toContain('- Last 3 things the user said (newest last): t1u "plan the trip"');
    expect(block).toContain('- Last 3 things you sent the user (newest last): "Planned."');
    // Bug #61: the mirror is host-private; the Bot searches its history through the host.
    expect(block).toContain("Full history: search it with SearchHistory");
    expect(block).not.toContain(h.cfg.dataRoot);
    expect(block.length).toBeLessThanOrEqual(6000);
  });

  it("is added once, on the first turn after a compaction", async () => {
    const h = await makeRunnerHarness({ hooksFactory: (bots, cfg) => createRestoreHooks({ bots, dataRoot: cfg.dataRoot }), script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    patchCtx(h.bots, id, { restorePending: true });
    h.runner.sendPrompt(id, "a", "n1");
    await h.untilIdle(id);
    h.runner.sendPrompt(id, "b", "n2");
    await h.untilIdle(id);
    const has = (i: number) => JSON.stringify(h.brain(id).inputs[i]!.prompt).includes("<context_restore>");
    expect([has(0), has(1)]).toEqual([true, false]);
  });
});
