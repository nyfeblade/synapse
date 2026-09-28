import { STR_AUTH } from "@synapse/shared";
import { SENTINEL_API_KEY } from "../../auth/auth-env";
import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { classifyAssistantError, classifyResult, classifyThrown } from "../../brain/errors";
import { EventTranslator } from "../../brain/event-translator";
import { BOT_FLAG_SETTINGS, BOT_MANAGED_SETTINGS, buildBotEnv, buildBotQueryOptions, GIT_BUILTIN_DIFF } from "../../brain/spawn-options";
import { DISALLOWED_TOOLS } from "../../brain/tool-policy";
import { loadConfig } from "../../config";
import { loadPrompt } from "../../prompts/index";
import { log } from "../../util/log";

const cfg = loadConfig({});
const base = {
  cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a", systemAppend: "BOT PROMPT",
  model: "claude-sonnet-5", env: { HOME: "/home/box" }, mcpServers: {}, botToolNames: ["SendMessage", "update_state"], hooks: {}, canUseTool: async () => ({ behavior: "allow" as const }),
  abortController: new AbortController(),
};

describe("spawn options (BRAIN-01…07, TOOL-18)", () => {
  it("builds the default Bot options", () => {
    const o = buildBotQueryOptions(base);
    expect(o).toMatchObject({
      cwd: "/workspace", settingSources: [], permissionMode: "default", includePartialMessages: true, persistSession: true,
      model: "claude-sonnet-5", sessionId: base.newSessionId, pathToClaudeCodeExecutable: "/usr/local/bin/bot-claude",
    });
    // 2026-09-21: a Bot's default prompt is the standalone one (our full text, then the Bot prompt).
    expect(o.systemPrompt).toBe(`${loadPrompt("standalone.md").trim()}\n\nBOT PROMPT`);
    expect(buildBotQueryOptions({ ...base, systemPromptMode: "preset" }).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "BOT PROMPT" });
    expect(o.resume).toBeUndefined();
    expect(o.allowedTools).toBeUndefined();
    for (const t of ["SendMessage", "ListAgents", "AskUserQuestion", "Agent", "Task"]) expect(o.disallowedTools).toContain(t);
    // Lazy tools: connector tools are deferred behind the CLI's tool search, so a Bot must be able to
    // reach it. The host's own tools are marked alwaysLoad and never need it (phase0-findings #3).
    expect(o.disallowedTools).not.toContain("ToolSearch");
    expect(o.tools).toContain("ToolSearch");
    // Task 34: the bot's own MCP tool names (namespaced mcp__bot__<name>) must be in the `tools`
    // allowlist too, alongside the CLI built-ins — otherwise the real CLI reports "No such tool
    // available: mcp__bot__SendMessage" and the model can never actually reply.
    expect(o.tools).toEqual(expect.arrayContaining(["Bash", "mcp__bot__SendMessage", "mcp__bot__update_state"]));
    // CT-05: managedSettings is filtered restrictive-only and silently drops autoMemoryEnabled; the
    // "flag settings" tier (Options.settings) is the correct, non-filtered channel for it.
    expect((o.settings as { autoMemoryEnabled?: boolean }).autoMemoryEnabled).toBe(false);
    expect((o.managedSettings as Record<string, unknown>).autoMemoryEnabled).toBeUndefined();
  });

  it("ruling B: managed skills load through the CLI's own --plugin-dir (SDK plugins), MCP discovery off", () => {
    expect(buildBotQueryOptions(base).plugins).toBeUndefined();
    expect(buildBotQueryOptions({ ...base, plugins: ["/var/lib/bots/cc-managed/skills/garden"] }).plugins).toEqual([
      { type: "local", path: "/var/lib/bots/cc-managed/skills/garden", skipMcpDiscovery: true },
    ]);
  });

  it("final secfix round 4 (ruling 1): settingSources is always [], whatever a stale on-disk flags file says", () => {
    const stale = { ...DEFAULT_FLAGS, skillSettingSource: "user" } as unknown as typeof DEFAULT_FLAGS;
    expect(buildBotQueryOptions({ ...base, flags: stale }).settingSources).toEqual([]);
    expect(buildBotQueryOptions(base).settingSources).toEqual([]);
    expect("skillSettingSource" in DEFAULT_FLAGS).toBe(false);
  });

  it("final secfix round 4 (ruling 1): the flag tier pins plugins, marketplaces and hooks and adds disableAllHooks + disableCommandPluginSources", () => {
    const s = buildBotQueryOptions(base).settings as Record<string, unknown>;
    expect(s).toEqual({ autoMemoryEnabled: false, enabledPlugins: {}, extraKnownMarketplaces: {}, hooks: {}, disableAllHooks: true, disableCommandPluginSources: true });
  });

  it("final secfix round 4 (ruling 1): managedSettings carries only disableCommandPluginSources (the CLI reads it from the policy tier only; CT-05: autoMemoryEnabled stays in settings)", () => {
    const m = buildBotQueryOptions(base).managedSettings as Record<string, unknown>;
    expect(m).toEqual({ disableCommandPluginSources: true });
    expect(BOT_MANAGED_SETTINGS).toEqual({ disableCommandPluginSources: true });
    expect(BOT_FLAG_SETTINGS.disableAllHooks).toBe(true);
  });

  it("resumes an existing session and applies fallback flags", () => {
    const o = buildBotQueryOptions({
      ...base, resumeSessionId: "sess-1",
      flags: { ...DEFAULT_FLAGS, isolationLevel: 2, runAs: "bwrap", sessionIdOption: false, extraDisallowed: ["WeirdTool"] },
    });
    expect(o.resume).toBe("sess-1");
    expect(o.sessionId).toBeUndefined();
    expect(o.cwd).toBe("/home/box/.bot-cwd");
    expect(o.additionalDirectories).toEqual(["/workspace"]);
    expect(o.pathToClaudeCodeExecutable).toBe("/usr/local/bin/bot-claude-bwrap");
    expect(o.disallowedTools).toContain("WeirdTool");
    expect(buildBotQueryOptions({ ...base, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" } }).pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("gives the CLI child only box env, no Claude login, and ENABLE_TOOL_SEARCH=true (connector tools load on demand)", () => {
    const env = buildBotEnv({ cfg, botId: "b1" });
    expect(env).toMatchObject({ HOME: "/home/box", CLAUDE_CONFIG_DIR: "/home/box/.claude", BOT_ID: "b1", ENABLE_TOOL_SEARCH: "true", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.keys(env).some((k) => /GATEWAY|HOST_PRIVATE/.test(k))).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe(SENTINEL_API_KEY); // review round 2 (S1): a dead sentinel until a spawn adds a proxy token
    expect(DISALLOWED_TOOLS).not.toContain("ToolSearch");
  });

  it("a child subagent keeps its own tool list: no tool search (its servers are all alwaysLoad)", () => {
    const o = buildBotQueryOptions({ ...base, tools: ["Read"] });
    expect(o.tools).toEqual(["Read"]);
  });

  // Ruling (2): a repo's .git/config can run programs on a fast-path `git status`/`diff` (core.pager,
  // core.fsmonitor, diff.external, core.sshCommand, core.hooksPath). GIT_CONFIG_* overrides in the Bot env
  // neutralize those keys and take precedence over the repo config.
  it("neutralizes repo-config git execution keys via GIT_CONFIG_* overrides", () => {
    const env = buildBotEnv({ cfg, botId: "b1" });
    const n = Number(env.GIT_CONFIG_COUNT);
    expect(n).toBeGreaterThanOrEqual(5);
    const pairs: Record<string, string> = {};
    for (let i = 0; i < n; i++) pairs[env[`GIT_CONFIG_KEY_${i}`] as string] = env[`GIT_CONFIG_VALUE_${i}`] as string;
    expect(pairs).toMatchObject({
      "core.fsmonitor": "false", "core.hooksPath": "/dev/null", "core.pager": "cat", "diff.external": GIT_BUILTIN_DIFF, "core.sshCommand": "ssh",
    });
  });
});

describe("EventTranslator", () => {
  it("maps SDK messages to TurnEvents", () => {
    const t = new EventTranslator();
    const msgs = [
      { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5", tools: ["Bash"], claude_code_version: "2.1.277" },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "mcp__bot__SendMessage" } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"content":"Hel' } } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "thinking out loud" }, { type: "tool_use", id: "tu1", name: "mcp__bot__SendMessage", input: { content: "Hello" } }] } },
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Message sent." }] }] } },
      { type: "system", subtype: "api_retry", attempt: 1, error_status: 529 },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 111 }, seven_day: { utilization: 0.8, resetsAt: 222 } } } },
    ] as unknown as SDKMessage[];
    const kinds = msgs.flatMap((m) => t.translate(m)).map((e) => ("name" in e ? `${e.kind}:${e.name}` : e.kind));
    expect(kinds).toEqual(["session", "dispatched", "thinking", "thinking", "send_message_delta", "tool_start:mcp__bot__SendMessage", "tool_end:mcp__bot__SendMessage", "retry", "rate_limit"]);
    expect(t.lastAssistantText).toBe("thinking out loud");
    const rl = t.translate(msgs[8]!)[0] as { windows: Record<string, { utilization: number }> };
    expect(rl.windows.seven_day!.utilization).toBe(0.8);
  });

  it("ignores subagent traffic", () => {
    const t = new EventTranslator();
    expect(t.translate({ type: "assistant", parent_tool_use_id: "x", message: { id: "m", content: [] } } as unknown as SDKMessage)).toEqual([]);
  });

  it("logs (never swallows) system subtypes it doesn't turn into a TurnEvent", () => {
    const t = new EventTranslator();
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const mirrorError = { type: "system", subtype: "mirror_error", error: "append failed", key: { projectKey: "p", sessionId: "s1" } } as unknown as SDKMessage;
    expect(t.translate(mirrorError)).toEqual([]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![1]).toMatchObject({ subtype: "mirror_error", error: "append failed" });

    const permissionDenied = { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "tu9", message: "denied" } as unknown as SDKMessage;
    expect(t.translate(permissionDenied)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ subtype: "permission_denied", toolName: "Bash" });

    const unknown = { type: "system", subtype: "some_future_subtype", secret: "should never be logged" } as unknown as SDKMessage;
    expect(t.translate(unknown)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const unknownFields = warnSpy.mock.calls[1]![1] as Record<string, unknown>;
    expect(unknownFields).toMatchObject({ subtype: "some_future_subtype" });
    expect(unknownFields.secret).toBeUndefined();

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("error classification (§5.4)", () => {
  it("maps assistant errors, results and thrown errors to BOT-E codes", () => {
    expect(classifyAssistantError("authentication_failed")).toMatchObject({ code: "BOT-E0421", retryable: false, trayTitle: STR_AUTH.keyRejected });
    expect(classifyAssistantError("overloaded")).toMatchObject({ code: "BOT-E0401", retryable: true });
    expect(classifyAssistantError("rate_limit")).toMatchObject({ code: "BOT-E0420", trayTitle: STR_AUTH.rateLimited });
    expect(classifyAssistantError("model_not_found")).toMatchObject({ code: "BOT-MODEL", trayTitle: STR_AUTH.modelUnavailable });
    const ok = { type: "result", subtype: "success", is_error: false, result: "x" } as never;
    expect(classifyResult(ok, null, false)).toBeUndefined();
    const long = { type: "result", subtype: "success", is_error: true, result: "Prompt is too long" } as never;
    expect(classifyResult(long, null, false)).toMatchObject({ code: "BOT-E0404" });
    const exec = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] } as never;
    expect(classifyResult(exec, null, true)).toMatchObject({ code: "BOT-E0420" });
    expect(classifyThrown(new Error("socket hang up"))).toMatchObject({ code: "BOT-E0403", retryable: true });
  });
});
