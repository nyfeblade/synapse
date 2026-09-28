import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { startFakeMessagesApi, type FakeMessagesApi } from "../brain/fake-messages-api";
import { tmpConfig } from "../helpers";
import { startClaudeQuery } from "../../claude/spawn";

/**
 * The wire, not the accounting. context-budget.probe reads the CLI's /context categories; this reads
 * the REQUEST BODY the real CLI sends on the first model call of a turn (a scripted fake Messages API,
 * so no model, no key, no tokens), and splits it: system blocks, loaded tool schemas, deferred tool
 * names, and messages (the user turn plus whatever the CLI injects: reminders, the deferred-tool list,
 * MCP server instructions). Built for the coding-bench gap (cost-diet-2): the lean profile's /context
 * said 14.2k a call, the bench saw ~23k average; this is the instrument that can tell them apart.
 *
 *   RUN_CLAUDE=1 BUDGET_OUT=/tmp/wire.txt [WIRE_CONNECTORS=1] npx vitest run --project host host/test/perf/wire-prefix.probe.test.ts
 */
const OUT = process.env.BUDGET_OUT ?? "/tmp/wire.txt";
const w = (...a: unknown[]) => fs.appendFileSync(OUT, a.join(" ") + "\n");
let app: HostApp | null = null;
let api: FakeMessagesApi | null = null;
afterEach(async () => { await api?.close(); api = null; await app?.close(); app = null; });

interface Body { system?: string | { text?: string }[]; tools?: { name: string; defer_loading?: boolean; [k: string]: unknown }[]; messages?: { role: string; content: unknown }[] }

function split(label: string, raw: string): void {
  const b = JSON.parse(raw) as Body;
  const sys = typeof b.system === "string" ? b.system.length : (b.system ?? []).reduce((s, x) => s + (x.text ?? "").length, 0);
  const tools = b.tools ?? [];
  const loaded = tools.filter((t) => !t.defer_loading);
  const deferred = tools.filter((t) => t.defer_loading);
  const loadedChars = loaded.reduce((s, t) => s + JSON.stringify(t).length, 0);
  const deferredChars = deferred.reduce((s, t) => s + JSON.stringify(t).length, 0);
  const msgs = JSON.stringify(b.messages ?? []).length;
  w(`\n##### ${label}  body=${raw.length} chars`);
  w("  system chars", sys);
  w("  tools loaded", loaded.length, "chars", loadedChars, "| deferred (not sent as schemas)", deferred.length, "chars", deferredChars);
  w("  messages chars", msgs);
  for (const t of [...loaded].sort((x, y) => JSON.stringify(y).length - JSON.stringify(x).length)) w("  TOOL", String(JSON.stringify(t).length).padStart(6), t.name);
  for (const m of b.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content as { type: string; text?: string }[] : [{ type: "text", text: String(m.content) }];
    for (const x of blocks) w("  MSG", m.role, x.type, String((x.text ?? JSON.stringify(x)).length).padStart(6), JSON.stringify((x.text ?? "").slice(0, 160)));
  }
}

async function firstCall(label: string, o: Options): Promise<void> {
  const q = startClaudeQuery({ prompt: "hi", options: o }, query);
  try {
    for await (const m of q) if (m.type === "result") break;
  } catch (e) {
    w(`##### ${label} ERR`, String(e).slice(0, 300));
  } finally {
    q.close();
  }
  if (api!.bodies[0]) split(label, api!.bodies[0]);
  else w(`##### ${label}: no conversational call captured`);
}

describe.runIf(process.env.RUN_CLAUDE === "1")("the first model call's request body, by section", () => {
  it("engineering Bot, everyday Bot and the vanilla CLI on the wire", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wire-")));
    const connectors = (): Options["mcpServers"] => (process.env.WIRE_CONNECTORS === "1" ? {
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "aws-knowledge": { type: "http", url: "https://knowledge-mcp.global.api.aws" },
      "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
    } : {});
    const model = process.env.PROBE_MODEL || "claude-sonnet-5";
    for (const engineering of [true, false]) {
      api = await startFakeMessagesApi([[{ text: "ok" }]]);
      const { id } = await a.handlers.createAgent!({ name: engineering ? "WireEng" : "WireStd", isKickstartRequested: false });
      if (engineering) await a.handlers.setAgentEngineeringMode!({ id, enabled: true });
      const sc = a.services.spawnConfig(id);
      const wiring = a.services.runner.wiring(id);
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode, model, effort: sc.effort,
        env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, ENABLE_TOOL_SEARCH: sc.env.ENABLE_TOOL_SEARCH!, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        mcpServers: { ...connectors(), bot: toSdkMcpServer(wiring, sc.upFrontBotTools) },
        botToolNames: wiring.botTools().map((t) => t.name), extraDisallowed: sc.extraDisallowed, plugins: sc.plugins,
        skillOverrides: sc.skillOverrides, builtinTools: sc.builtinTools,
        hooks: {}, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }), abortController: new AbortController(),
      });
      o.cwd = home;
      o.persistSession = false;
      delete (o as { hooks?: unknown }).hooks;
      await firstCall(`${engineering ? "engineering" : "everyday"} Bot (${model}${process.env.WIRE_CONNECTORS === "1" ? ", 3 remote connectors" : ""})`, o);
      await api.close(); api = null;
    }
    api = await startFakeMessagesApi([[{ text: "ok" }]]);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wire-cli-"));
    execFileSync("git", ["init", "-q"], { env: scrubClaudeLogin(process.env), cwd: repo });
    await firstCall(`vanilla CLI (${model})`, {
      cwd: repo, model, settingSources: [], persistSession: false, systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: "default",
      env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude-cli"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    fs.rmSync(home, { recursive: true, force: true });
  }, 600_000);
});
