import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotQueryOptions, buildSystemPrompt, systemPromptModeFor } from "../../brain/spawn-options";
import { loadPrompt } from "../../prompts/index";
import { tmpConfig } from "../helpers";
import { REFERENCE_NAME } from "../../../scripts/public-scan";

/**
 * BRAIN-03's A/B switch. The standalone prompt replaces the vendor preset with this host's own
 * complete prompt. Since 2026-09-21 the standalone prompt is the default; the preset stays reachable,
 * byte for byte, for engineering mode and for the box owner's SYNAPSE_SYSTEM_PROMPT=preset escape hatch.
 *
 * The content rule these tests enforce is not cosmetic: a Bot's prompt never names the product it
 * was modelled on, or the harness underneath it. A Bot simply is what it is.
 */
const spawn = (systemAppend: string, mode?: "preset" | "standalone") =>
  buildBotQueryOptions({
    cfg: tmpConfig(), flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null,
    systemAppend, model: "m", env: {}, mcpServers: {}, botToolNames: [], hooks: {},
    canUseTool: async (_n, i) => ({ behavior: "allow", updatedInput: i }), abortController: new AbortController(),
    ...(mode ? { systemPromptMode: mode } : {}),
  });

describe("system prompt mode (BRAIN-03 switch)", () => {
  it("defaults to the standalone prompt for every Bot when nothing forces the preset (user decision 2026-09-21)", () => {
    const cfg = loadConfig({});
    expect(cfg.systemPromptMode).toBe("standalone");
    expect(systemPromptModeFor(cfg, "b1")).toBe("standalone");
    expect(systemPromptModeFor(cfg, "b1", false)).toBe("standalone");
    // The builder's own default is the standalone string too, so no caller lands on the preset by omission.
    expect(spawn("APPEND").systemPrompt).toBe(`${loadPrompt("standalone.md").trim()}\n\nAPPEND`);
    expect(loadConfig({ SYNAPSE_SYSTEM_PROMPT: "standalone" }).systemPromptMode).toBe("standalone");
  });

  it("an engineering-mode Bot always runs the preset, whatever the box default", () => {
    expect(systemPromptModeFor(loadConfig({}), "b1", true)).toBe("preset");
    expect(systemPromptModeFor(loadConfig({ SYNAPSE_SYSTEM_PROMPT: "preset" }), "b1", true)).toBe("preset");
    expect(spawn("APPEND", "preset").systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "APPEND" });
  });

  it("the box owner's escape hatch SYNAPSE_SYSTEM_PROMPT=preset puts every Bot back on the preset", () => {
    const cfg = loadConfig({ SYNAPSE_SYSTEM_PROMPT: "preset" });
    expect(cfg.systemPromptMode).toBe("preset");
    expect(systemPromptModeFor(cfg, "b1")).toBe("preset");
    expect(systemPromptModeFor(cfg, "b2", false)).toBe("preset");
  });

  it("under the escape hatch, SYNAPSE_SYSTEM_PROMPT_BOTS still pins the named Bots to standalone, so the two paths can run side by side", () => {
    const cfg = loadConfig({ SYNAPSE_SYSTEM_PROMPT: "preset", SYNAPSE_SYSTEM_PROMPT_BOTS: " b2 , b3 " });
    expect(cfg.standalonePromptBotIds).toEqual(["b2", "b3"]);
    expect(systemPromptModeFor(cfg, "b1")).toBe("preset");
    expect(systemPromptModeFor(cfg, "b2")).toBe("standalone");
    expect(systemPromptModeFor(cfg, "b3")).toBe("standalone");
    expect(systemPromptModeFor(cfg, "b3", true)).toBe("preset");
  });

  it("states its mode in one line, so the Bot can always say which mode it is in", () => {
    const lines = loadPrompt("standalone.md").split("\n").filter((l) => /standard mode/i.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/engineering mode is off/i);
  });

  it("sends one complete prompt — standalone first, then the identical <BotPrompt> — with no preset under it", () => {
    const p = spawn("APPENDED BOT PROMPT", "standalone").systemPrompt;
    expect(typeof p).toBe("string");
    const text = p as string;
    expect(text.startsWith(loadPrompt("standalone.md").trim())).toBe(true);
    expect(text.endsWith("APPENDED BOT PROMPT")).toBe(true);
    // The append is passed through untouched: the frozen snapshot and the spawn key still key on it.
    expect(buildSystemPrompt("standalone", "X")).toBe(`${loadPrompt("standalone.md").trim()}\n\nX`);
    expect(buildSystemPrompt("standalone", "  ")).toBe(loadPrompt("standalone.md").trim());
  });

  it("never names the reference product, its maker, or the harness underneath", () => {
    const text = loadPrompt("standalone.md");
    for (const banned of [REFERENCE_NAME, /cursor/i, /claude/i, /anthropic/i, /openai/i, /chatgpt/i, /\bsand[_-]/i, /clone/i]) {
      expect(text, `standalone.md must not match ${banned}`).not.toMatch(banned);
    }
  });

  it("names the tool surface nothing else explains", () => {
    const text = loadPrompt("standalone.md");
    for (const tool of [
      "SendMessage", "SendToAgent", "CreateAgent", "UpdateAgent", "DeleteAgent", "ArchiveAgent", "DuplicateAgent",
      "CreateChannel", "UpdateChannel", "LeaveChannel", "CodingAgent", "Template", "update_state", "request_box_help",
      "Task", "Shell", "AwaitShell", "Screenshot", "TodoWrite",
    ]) expect(text, `standalone.md must name ${tool}`).toContain(tool);
  });

  it("stays a static, shared prefix: no template holes, and well under the preset it replaces", () => {
    const text = loadPrompt("standalone.md");
    // Any {{VAR}} would make the head of the block per-Bot and cost the cross-session cache hit.
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    // The preset it replaces measured ~3,636 tokens (host/test/perf/prompt-budget.test.ts).
    expect(text.length, `standalone.md (${text.length} chars)`).toBeLessThan(6_000);
  });
});
