import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrompt } from "../../prompts";
import { createScreenshotTool } from "../../computer/screenshot-tool";

// Final box verification: told to "start a background subagent with Task", the live model called the CLI's own
// (disabled) Task tool: "No such tool available: Task". Every place that points a Bot at subagents names the exact
// host tool, mcp__bot__Task, as base.md does for mcp__bot__SendMessage.
describe("prompts name the subagent tool exactly (mcp__bot__Task)", () => {
  const texts = {
    "sections/computer.md": loadPrompt("sections/computer.md"),
    "skills/learn-from-demonstration/SKILL.md": fs.readFileSync(path.resolve(__dirname, "../../prompts/skills/learn-from-demonstration/SKILL.md"), "utf8"),
    "Screenshot tool description": createScreenshotTool({ botId: "b", displays: {} as never, workspace: "/workspace", now: () => 0 }).description,
  };
  for (const [where, text] of Object.entries(texts)) {
    it(where, () => {
      expect(text).toContain("mcp__bot__Task");
      expect(text).not.toMatch(/(?<!mcp__bot__)\bTask\b/);
    });
  }
});

// Same run, second symptom: the hand-back wake said "the read-only Screenshot tool"; the model called a bare
// Screenshot ("No such tool"), told the user the tool was unavailable and never looked at the screen.
describe("prompts name the Screenshot tool exactly (mcp__bot__Screenshot)", () => {
  for (const file of ["wakes/box-handback.md", "wakes/box-viewer-closed.md", "sections/computer.md"]) {
    it(file, () => {
      const text = loadPrompt(file);
      expect(text).toContain("mcp__bot__Screenshot");
      expect(text).not.toMatch(/(?<!mcp__bot__)\bScreenshot\b/);
    });
  }
});
