import { describe, expect, it } from "vitest";
import { BOT_BUILTIN_TOOLS, CODING_BUILTIN_TOOLS, DISALLOWED_TOOLS, SEND_TOOL, STANDARD_BOT_BUILTIN_TOOLS, TOOL_SEARCH } from "../../brain/tool-policy";
import { STEER_READ_ONLY_TOOLS, steerLetsThrough } from "../../runner/steer-policy";
import { makeRunnerHarness } from "./harness";

/** Bug 198, fix round 2: while a steering message is unread, only plainly read-only calls run (fail closed). */

const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, input, toolUseId: "t" });

describe("steer read-only allowlist", () => {
  it("is exactly the plainly read-only tools", () => {
    expect([...STEER_READ_ONLY_TOOLS].sort()).toEqual([
      "Glob", "Grep", "LS", "Read", "TodoWrite", "WebFetch", "WebSearch",
      "mcp__bot__AwaitExternalShell", "mcp__bot__AwaitShell", "mcp__bot__CheckSubagent", "mcp__bot__ExternalRead",
      "mcp__bot__Look", "mcp__bot__Screenshot", "mcp__bot__SearchHistory",
    ].sort());
  });

  it("classifies every tool name the brain can emit: allowlisted ones pass, everything else is held", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
    const botTools = h.runner.wiring(id).botTools();
    const names = new Set<string>([
      ...BOT_BUILTIN_TOOLS, ...STANDARD_BOT_BUILTIN_TOOLS, ...CODING_BUILTIN_TOOLS, ...DISALLOWED_TOOLS, TOOL_SEARCH, "NotebookEdit", "LS",
      ...botTools.map((t) => `mcp__bot__${t.name}`),
    ]);
    for (const n of names) {
      const through = steerLetsThrough(call(n, n === SEND_TOOL ? { content: "hi" } : {}));
      expect(through, n).toBe(n === SEND_TOOL || STEER_READ_ONLY_TOOLS.has(n));
    }
    // Only tools that declare themselves read-only may be on the list.
    for (const t of botTools) if (STEER_READ_ONLY_TOOLS.has(`mcp__bot__${t.name}`)) expect(t.readOnly, t.name).toBe(true);
  });

  it("holds unknown and new tools, writes, subagent control, state updates and connector drafts", () => {
    for (const n of ["Edit", "Write", "NotebookEdit", "Bash", "mcp__bot__update_state", "mcp__bot__MessageSubagent", "mcp__bot__StopSubagent",
      "mcp__bot__Computer", "mcp__bot__browser_tabs", "mcp__google__gmail_create_draft", "mcp__plugin__anything", "BrandNewTool", TOOL_SEARCH]) {
      expect(steerLetsThrough(call(n)), n).toBe(false);
    }
  });

  it("lets a plain text SendMessage through (it is how the Bot answers) but not other send types", () => {
    expect(steerLetsThrough(call(SEND_TOOL, { content: "About a minute." }))).toBe(true);
    expect(steerLetsThrough(call(SEND_TOOL, { type: "text", content: "ok" }))).toBe(true);
    for (const type of ["card", "secret-request", "coding-agent", "attachment", "widget"]) expect(steerLetsThrough(call(SEND_TOOL, { type })), type).toBe(false);
  });
});
