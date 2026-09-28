import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type HookCallbackMatcher, type Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { loadConfig } from "../../config";

/**
 * Final secfix round 4 (ruling 1), on the Mac with the SDK's bundled CLI (RUN_CLAUDE=1, but no model request: a bogus
 * key and a dead ANTHROPIC_BASE_URL, in a throwaway HOME). A box-written ~/.claude/settings.json declares a
 * UserPromptSubmit command hook that appends to a marker file. The round-3 options (settingSources ["user"] plus the
 * additive `hooks: {}` flag settings) let it run; the Bot's real options don't, and the host's own SDK callback hooks
 * still fire under disableAllHooks.
 */
const ROUND3_FLAG_SETTINGS = { autoMemoryEnabled: false, enabledPlugins: {}, extraKnownMarketplaces: {}, hooks: {} };

async function run(opts: (home: string, cfgDir: string) => Partial<Options>): Promise<{ commandHook: boolean; callbackHook: boolean }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secfix4-hooks-")));
  const cfgDir = path.join(home, ".claude");
  fs.mkdirSync(cfgDir);
  const marker = path.join(home, "HOOK-FIRED");
  fs.writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo x >> ${marker}` }] }] } }));
  let callbackHook = false;
  const hooks: Partial<Record<"UserPromptSubmit", HookCallbackMatcher[]>> = { UserPromptSubmit: [{ hooks: [async () => { callbackHook = true; return {}; }] }] };
  const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: cfgDir, ANTHROPIC_API_KEY: "sk-ant-api03-invalid-probe", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
  const q = query({ prompt: "hi", options: { ...opts(home, cfgDir), cwd: home, env, hooks, tools: [], maxTurns: 1, persistSession: false, pathToClaudeCodeExecutable: undefined } });
  const drain = (async () => { try { for await (const m of q) if (m.type === "result") return; } catch { /* dead endpoint */ } })();
  const end = Date.now() + 30_000;
  while (!callbackHook && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 2_000)); // a command hook for the same event has had time to append
  q.close();
  await drain;
  const commandHook = fs.existsSync(marker);
  fs.rmSync(home, { recursive: true, force: true });
  return { commandHook, callbackHook };
}

describe.runIf(process.env.RUN_CLAUDE === "1")("a box-written ~/.claude/settings.json hook never runs in a Bot CLI", () => {
  it("control: the round-3 options (user source + hooks: {}) let the hostile hook run", async () => {
    expect(await run(() => ({ settingSources: ["user"], settings: ROUND3_FLAG_SETTINGS as never }))).toEqual({ commandHook: true, callbackHook: true });
  }, 60_000);

  it("the Bot's options: no hostile hook, the host's SDK callback hook still fires", async () => {
    const cfg = loadConfig({});
    const o = buildBotQueryOptions({
      cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "claude-haiku-4-5-20251001",
      env: {}, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async () => ({ behavior: "deny", message: "probe" }), abortController: new AbortController(),
    });
    expect(await run(() => ({ settingSources: o.settingSources, settings: o.settings, managedSettings: o.managedSettings }))).toEqual({ commandHook: false, callbackHook: true });
  }, 60_000);

  it("defense in depth: even with the user source on, the flag-tier disableAllHooks stops it", async () => {
    const cfg = loadConfig({});
    const o = buildBotQueryOptions({
      cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "m",
      env: {}, mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async () => ({ behavior: "deny", message: "probe" }), abortController: new AbortController(),
    });
    expect(await run(() => ({ settingSources: ["user"], settings: o.settings, managedSettings: o.managedSettings }))).toEqual({ commandHook: false, callbackHook: true });
  }, 60_000);
});
