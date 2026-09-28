import { describe, expect, it } from "vitest";
import { CANARY, judgeCt01, judgeCt02, judgeCt03, judgeCt04, judgeCt05, judgeCt06 } from "../../../brain/conformance/checks/group-a";

describe("judges CT-01…CT-06", () => {
  it("CT-01 needs deltas before the tool call", () => {
    expect(judgeCt01({ deltaTimes: [1, 2, 3], toolCalledAt: 10 }).status).toBe("pass");
    expect(judgeCt01({ deltaTimes: [11], toolCalledAt: 10 })).toMatchObject({ status: "fail", flags: { sendStreaming: false } });
    expect(judgeCt01({ deltaTimes: [], toolCalledAt: null }).flags).toEqual({ sendStreaming: false });
  });
  it("CT-02 needs canUseTool for every surface present", () => {
    expect(judgeCt02({ asked: ["Bash", "mcp__probe__ping"], connectorTool: null }).status).toBe("pass");
    expect(judgeCt02({ asked: ["Bash"], connectorTool: null })).toMatchObject({ status: "fail", flags: { approvalPath: "hook" } });
    expect(judgeCt02({ asked: ["Bash", "mcp__probe__ping"], connectorTool: "mcp__claude_ai_Gmail__search" }).status).toBe("fail");
  });
  it("CT-03 needs a continued turn and a fast interrupt", () => {
    expect(judgeCt03({ continuedAfterBlock: true, interruptMs: 900 }).status).toBe("pass");
    expect(judgeCt03({ continuedAfterBlock: false, interruptMs: 900 })).toMatchObject({ status: "fail", flags: { stopNudge: false } });
    expect(judgeCt03({ continuedAfterBlock: true, interruptMs: null }).status).toBe("fail");
  });
  it("CT-04 reads rate_limit_event windows", () => {
    expect(judgeCt04({ windows: { seven_day: { utilization: 0.4, resetsAt: 5 } } })).toMatchObject({ status: "pass", flags: { usageSource: "rate_limit_event" } });
    expect(judgeCt04({ windows: {} })).toMatchObject({ status: "n/a", flags: { usageSource: "metering" } }); // an API key has no plan windows
  });
  it("CT-05 rejects canaries, memory writes and colliding built-ins", () => {
    expect(judgeCt05({ reply: "NONE", memoryFiles: [], tools: ["Bash", "mcp__bot__SendMessage"] }).status).toBe("pass");
    expect(judgeCt05({ reply: `code ${CANARY}`, memoryFiles: [], tools: [] }).status).toBe("fail");
    expect(judgeCt05({ reply: "NONE", memoryFiles: ["MEMORY.md"], tools: [] }).status).toBe("fail");
    expect(judgeCt05({ reply: "NONE", memoryFiles: [], tools: ["SendMessage"] }).status).toBe("fail");
    // Lazy tools: ToolSearch is now a Bot's own built-in (connector tools are deferred behind it), so
    // it is neither a collision nor an unknown tool to disallow. The other two still collide.
    expect(judgeCt05({ reply: "NONE", memoryFiles: [], tools: ["Bash", "ToolSearch", "mcp__bot__SendMessage"] })).toMatchObject({ status: "pass", flags: undefined });
    expect(judgeCt05({ reply: "NONE", memoryFiles: [], tools: ["ListAgents"] }).status).toBe("fail");
    expect(judgeCt05({ reply: "NONE", memoryFiles: [], tools: ["Bash", "NewThing"] }).flags).toEqual({ extraDisallowed: ["NewThing"] });
  });
  it("CT-06 needs a successful API-key query (no login fallback flag)", () => {
    expect(judgeCt06({ text: "OK", isError: false }).status).toBe("pass");
    const f = judgeCt06({ text: "", isError: true });
    expect(f.status).toBe("fail");
    expect(f.flags).toBeUndefined();
  });
});
