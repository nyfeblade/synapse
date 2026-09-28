/**
 * The instrument behind every token number in host/test/perf/*.
 *
 * It spawns the real Claude Code CLI with this host's real spawn options and asks it for its own
 * /context breakdown (Query.getContextUsage, a control request — with detail:"summary" it costs no
 * model call and no API tokens). That is the only honest way to see the per-turn floor: the system
 * prompt, the built-in tool schemas, the CLI's skill frontmatter and every MCP tool schema, counted
 * by the thing that actually sends them.
 *
 * Skipped by default because it spawns a CLI process. Run it when you change the prompt or the tool
 * surface, and paste the result into the comments in prompt-budget.test.ts:
 *
 *   PROMPT_BUDGET_PROBE=1 BUDGET_OUT=/tmp/ctx.txt WEBHOOK_PORT=0 npx vitest run host/test/perf/ctx-probe.test.ts
 *
 * Measured 2026-09-19 (fresh Bot, no connectors installed, no local computer, one Bot on the app):
 *   before  System prompt 6,142 · System tools 13,181 · Skills 1,556 · MCP tools 9,868 (42 tools) = 30,747
 *   after   System prompt 5,996 · System tools 13,181 · Skills 1,556 · MCP tools 7,465 (26 tools) = 28,199
 *
 * Measured 2026-09-21, lazy tools (runs C and D: + Google + context7, aws-knowledge, cloudflare-docs):
 *   C tool search off  System prompt 6,083 · System tools 13,181 · Skills 1,556 · MCP tools 17,936 = 38,756
 *   D production       System prompt 6,083 · System tools 11,450 · Skills 1,556 · MCP tools  7,463 = 26,552
 *                      (deferred, not sent: MCP 10,472 · built-ins 1,966)
 *
 * Measured 2026-09-21, S1 lean engineering profile ("measures an engineering-mode Bot against the CLI
 * floor"; ENG_LEAN=0 = before, PROBE_MODEL picks the model; pinned in engineering/lean-profile.ts):
 *   sonnet-5  CLI floor  System prompt 2,156 · System tools 11,557 · Skills 2,074 · MCP 0     = 15,787
 *             before     System prompt 4,928 · System tools  5,219 · Skills 2,074 · MCP 7,810 = 20,031
 *             after      System prompt 4,928 · System tools  6,732 · Skills   561 · MCP 2,022 = 14,243
 *   haiku-4.5 CLI floor  System prompt 7,033 · System tools 20,254 · Skills 1,556 · MCP 0     = 28,843
 *             before     System prompt 6,248 · System tools 11,450 · Skills 1,556 · MCP 7,810 = 27,064
 *             after      System prompt 6,248 · System tools 12,583 · Skills   423 · MCP 2,022 = 21,276
 *   (after: 24 bot tools deferred, 5,788; the System tools row grows ~1.1-1.5k once they are.)
 */
import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, it, vi } from "vitest";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createHostApp, type HostApp } from "../../app";
import path from "node:path";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { GoogleApi } from "../../google/api";
import { REAL_GOOGLE } from "../../google/endpoints";
import { googleMcpServer } from "../../google/module";
import { GoogleAuth } from "../../google/oauth";
import { GoogleStore } from "../../google/store";
import { createGoogleTools } from "../../google/tools";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toNamedMcpServer, toSdkMcpServer } from "../../brain/sdk-wiring";
import { tmpConfig } from "../helpers";
import { explicitKeyEnv } from "../../auth/dev-auth";
import { startClaudeQuery } from "../../claude/spawn";

const OUT = process.env.BUDGET_OUT ?? "/tmp/ctx.txt";
const w = (...a: unknown[]) => fs.appendFileSync(OUT, a.join(" ") + "\n");

/** One /context read of a spawn that never gets a prompt (a control request: no model call, no tokens). */
async function measure(label: string, o: Options): Promise<number> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  async function* input(): AsyncGenerator<never> { await gate; return; }
  const q = startClaudeQuery({ prompt: input() as never, options: o }, query);
  try {
    await new Promise((r) => setTimeout(r, 8000));
    const r = await q.getContextUsage({ detail: "summary" });
    const g = r as unknown as { categories: { name: string; tokens: number; kind: string }[]; systemTools?: { name: string; tokens: number }[]; mcpTools?: { name: string; tokens: number; isLoaded?: boolean }[]; skills?: unknown };
    w(`\n##### ${label}  total=${r.totalTokens}`);
    for (const c of g.categories) if (c.kind !== "free") w("  CAT", c.kind.padEnd(9), String(c.tokens).padStart(7), c.name);
    w("  skills", JSON.stringify(g.skills));
    for (const t of g.systemTools ?? []) w("  SYSTOOL", String(t.tokens).padStart(6), t.name);
    for (const t of [...(g.mcpTools ?? [])].sort((x, y) => y.tokens - x.tokens)) w("  MCPTOOL", String(t.tokens).padStart(6), t.name, t.isLoaded === false ? "deferred" : "loaded");
    return r.totalTokens;
  } catch (e) {
    w(`##### ${label} ERR`, String(e).slice(0, 300));
    return -1;
  } finally {
    release();
    (q as { close?: () => void }).close?.();
  }
}

let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });

describe.skipIf(process.env.PROMPT_BUDGET_PROBE !== "1")("CLI /context accounting for a real Bot spawn", () => {
  it("prints the per-turn floor by category", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Measure", isKickstartRequested: false });
    const runner = a.services.runner;
    const wiring = runner.wiring(id);
    const systemAppend = runner.systemAppend(id);
    const tools = wiring.botTools();

    const base = (mode: "preset" | "standalone" = "preset"): Options => {
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend, systemPromptMode: mode, model: "claude-haiku-4-5-20251001",
        env: { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        mcpServers: { bot: toSdkMcpServer(wiring) },
        botToolNames: tools.map((t) => t.name),
        hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
        abortController: new AbortController(),
      });
      o.cwd = "/tmp";
      delete (o as { hooks?: unknown }).hooks;
      return o;
    };

    const run = async (label: string, patch: (o: Options) => void, mode: "preset" | "standalone" = "preset") => {
      const o = base(mode);
      patch(o);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      async function* input(): AsyncGenerator<never> { await gate; return; }
      const q = startClaudeQuery({ prompt: input() as never, options: o }, query);
      try {
        await new Promise((r) => setTimeout(r, 8000)); // let the sdk and remote mcp servers connect
        const r = await q.getContextUsage({ detail: "summary" });
        const g = r as unknown as {
          categories: { name: string; tokens: number; kind: string }[];
          systemTools?: { name: string; tokens: number }[];
          mcpTools?: { name: string; serverName: string; tokens: number }[];
          skills?: { tokens: number; includedSkills: number };
          slashCommands?: { tokens: number; includedCommands: number };
        };
        w(`\n##### ${label}  total=${r.totalTokens}`);
        for (const c of g.categories) if (c.kind !== "free") w("  CAT", c.kind.padEnd(9), String(c.tokens).padStart(7), c.name);
        w("  skills", JSON.stringify(g.skills), "slash", JSON.stringify(g.slashCommands));
        if (g.systemTools) for (const t of g.systemTools) w("  SYSTOOL", String(t.tokens).padStart(6), t.name);
        if (g.mcpTools) {
          w("  mcpTools n=", g.mcpTools.length, "sum=", g.mcpTools.reduce((s, t) => s + t.tokens, 0), "keys=", Object.keys(g.mcpTools[0] ?? {}).join(","));
          for (const t of [...g.mcpTools].sort((x, y) => y.tokens - x.tokens)) w("  MCPTOOL", String(t.tokens).padStart(6), t.name, (t as { isLoaded?: boolean }).isLoaded === false ? "deferred" : "loaded");
        }
      } catch (e) {
        w(`##### ${label} ERR`, String(e).slice(0, 300));
      } finally {
        release();
        (q as { close?: () => void }).close?.();
      }
    };

    w("systemAppend chars", systemAppend.length, "botTools", tools.length);
    await run("A baseline (production options)", () => {});
    // BRAIN-03: the same Bot, the same tools, the same append — only the prompt the session starts
    // from differs. The "System prompt" category is the whole A/B, and it costs no model call.
    await run("B standalone prompt (SYNAPSE_SYSTEM_PROMPT=standalone)", () => {}, "standalone");
    // Lazy tools: the same Bot with connectors mounted — the built-in Google server plus three public
    // remote servers the user has installed (no sign-in needed, so the CLI can list them here). C is
    // the old spawn (tool search off: every schema on every call); D is production (deferred).
    const googleAuth = new GoogleAuth({ store: new GoogleStore(path.join(cfg.hostPrivate, "google.json"), new Uint8Array(32)), endpoints: () => REAL_GOOGLE, now: () => 0 });
    const connectors = (): Options["mcpServers"] => ({
      google: googleMcpServer(createGoogleTools({ api: new GoogleApi({ auth: googleAuth, endpoints: () => REAL_GOOGLE }), auth: googleAuth, workspace: cfg.workspace, hostPrivate: cfg.hostPrivate })),
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "aws-knowledge": { type: "http", url: "https://knowledge-mcp.global.api.aws" },
      "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
    });
    await run("C connectors, tool search off (before lazy tools)", (o) => {
      o.mcpServers = { ...o.mcpServers, ...connectors() };
      o.env = { ...o.env, ENABLE_TOOL_SEARCH: "false" };
      o.tools = (o.tools as string[]).filter((t) => t !== "ToolSearch");
    });
    await run("D connectors, lazy tools (production)", (o) => {
      o.mcpServers = { ...o.mcpServers, ...connectors() };
      o.env = { ...o.env, ENABLE_TOOL_SEARCH: buildBotEnv({ cfg, botId: id }).ENABLE_TOOL_SEARCH! };
    });
  }, 600_000);

  /**
   * S1 lean engineering profile: an engineering-mode Bot, spawned from the production spawn config
   * (services.spawnConfig, the same fields ClaudeBrain reads), against the CLI floor: the vanilla
   * Claude Code CLI (the SDK's bundled binary, the same version the Bots run) with its own defaults,
   * no setting sources (no user CLAUDE.md, plugins or skills), no MCP servers, in an empty git repo.
   * Both are counted by the CLI's own /context accounting; neither makes a model call.
   */
  it("measures an engineering-mode Bot against the CLI floor", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Measure", isKickstartRequested: false });
    await a.handlers.setAgentEngineeringMode!({ id, enabled: true });
    const sc = a.services.spawnConfig(id);
    const wiring = a.services.runner.wiring(id);
    const env = { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    // ENG_LEAN=0 measures the engineering Bot as it was before S1 (every bot tool loaded, every skill described).
    const lean = process.env.ENG_LEAN !== "0";
    const model = process.env.PROBE_MODEL || sc.model; // both sides on the same model: tool and prompt counts differ by model
    const eng = buildBotQueryOptions({
      cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
      systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode, model, effort: sc.effort,
      env: { ...env, ENABLE_TOOL_SEARCH: sc.env.ENABLE_TOOL_SEARCH! },
      mcpServers: { ...(sc.mcpServers ?? {}), bot: toSdkMcpServer(wiring, lean ? sc.upFrontBotTools : undefined) },
      botToolNames: wiring.botTools().map((t) => t.name), extraDisallowed: sc.extraDisallowed, plugins: sc.plugins,
      skillOverrides: lean ? sc.skillOverrides : undefined,
      hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
    });
    eng.cwd = "/tmp";
    delete (eng as { hooks?: unknown }).hooks;
    w("engineering systemAppend chars", sc.systemAppend.length, "model", model);
    await measure(`E engineering-mode Bot (production spawn config${lean ? "" : ", S1 lean profile OFF"})`, eng);

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cli-floor-"));
    execFileSync("git", ["init", "-q"], { env: scrubClaudeLogin(process.env), cwd: repo });
    await measure("F CLI floor (vanilla CLI, no settings, no MCP)", {
      cwd: repo, model, settingSources: [], env, systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default", persistSession: false,
    });
  }, 600_000);

  /**
   * cost-diet-2 levers 2 + 3: an everyday (engineering mode OFF) Bot from the production spawn config,
   * before (every bot tool up front, built-in Bash) and after (the everyday up-front set, no Bash).
   * Pinned in engineering/lean-profile.ts EVERYDAY_PROFILE_MEASURED. No model call.
   */
  it("measures an everyday Bot before and after", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Everyday", isKickstartRequested: false });
    const sc = a.services.spawnConfig(id);
    const wiring = a.services.runner.wiring(id);
    const env = { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    const model = process.env.PROBE_MODEL || sc.model;
    const opts = (after: boolean) => {
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode, model, effort: sc.effort,
        env: { ...env, ENABLE_TOOL_SEARCH: sc.env.ENABLE_TOOL_SEARCH! },
        mcpServers: { ...(sc.mcpServers ?? {}), bot: toSdkMcpServer(wiring, after ? sc.upFrontBotTools : undefined) },
        botToolNames: wiring.botTools().map((t) => t.name), extraDisallowed: sc.extraDisallowed, plugins: sc.plugins,
        builtinTools: after ? sc.builtinTools : undefined,
        hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
      });
      o.cwd = "/tmp";
      delete (o as { hooks?: unknown }).hooks;
      return o;
    };
    w("everyday systemAppend chars", sc.systemAppend.length, "model", model, "upFront", (sc.upFrontBotTools ?? []).join(","));
    await measure("G everyday Bot BEFORE (all bot tools up front, built-in Bash)", opts(false));
    await measure("H everyday Bot AFTER (everyday up-front set, no Bash)", opts(true));
  }, 600_000);

  /**
   * mac-browser: the one Browser tool is deferred (behind ToolSearch) for an everyday Bot, so with a Mac registered its
   * per-turn cost is its name in the deferred list, not its schema. I = the production spawn without Browser, J = with.
   * No model call. Pinned in prompt-budget.test.ts ("the Mac Browser tool is deferred").
   */
  it("measures the deferred Browser tool on an everyday Bot with a Mac registered", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Everyday", isKickstartRequested: false });
    await a.handlers.registerLocalComputer!({ computer: { computerId: "mac1", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/x" } } as never);
    const sc = a.services.spawnConfig(id);
    const wiring = a.services.runner.wiring(id);
    const env = { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    const model = process.env.PROBE_MODEL || sc.model;
    const opts = (withBrowser: boolean) => {
      const tools = wiring.botTools().filter((t) => withBrowser || t.name !== "Browser");
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend: sc.systemAppend, systemPromptMode: sc.systemPromptMode, model, effort: sc.effort,
        env: { ...env, ENABLE_TOOL_SEARCH: sc.env.ENABLE_TOOL_SEARCH! },
        mcpServers: { ...(sc.mcpServers ?? {}), bot: toNamedMcpServer("bot", tools, { upFront: sc.upFrontBotTools }) },
        botToolNames: tools.map((t) => t.name), extraDisallowed: sc.extraDisallowed, plugins: sc.plugins, builtinTools: sc.builtinTools,
        hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
      });
      o.cwd = "/tmp";
      delete (o as { hooks?: unknown }).hooks;
      return o;
    };
    const i = await measure("I everyday Bot + Mac, without Browser", opts(false));
    const j = await measure("J everyday Bot + Mac, with Browser (deferred)", opts(true));
    w(`Browser per-turn delta: ${j - i} tokens`);
  }, 600_000);

  /**
   * The same measurement the other way round: one real turn on each path, reading the per-turn
   * `result` message's `usage.input_tokens`. This one DOES cost two model calls, which is why it is
   * a separate, gated test. The task is identical and deliberately trivial, so the difference is the
   * prompt and nothing else.
   */
  it("reports usage.input_tokens for one identical turn on each path", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Measure", isKickstartRequested: false });
    const wiring = a.services.runner.wiring(id);
    const systemAppend = a.services.runner.systemAppend(id);
    const tools = wiring.botTools();
    const TASK = "Reply with the single word: ok";

    for (const mode of ["preset", "standalone"] as const) {
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend, systemPromptMode: mode, model: "claude-haiku-4-5-20251001",
        env: { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        mcpServers: { bot: toSdkMcpServer(wiring) },
        botToolNames: tools.map((t) => t.name),
        hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
        abortController: new AbortController(),
      });
      o.cwd = "/tmp";
      o.persistSession = false;
      delete (o as { hooks?: unknown }).hooks;
      const q = startClaudeQuery({ prompt: TASK, options: o }, query);
      try {
        for await (const m of q as AsyncIterable<{ type: string; usage?: Record<string, number>; subtype?: string }>) {
          if (m.type !== "result") continue;
          const u = m.usage ?? {};
          const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          w(`##### turn ${mode}  input_tokens=${u.input_tokens ?? 0} cache_create=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} total_in=${input} subtype=${m.subtype}`);
        }
      } catch (e) {
        w(`##### turn ${mode} ERR`, String(e).slice(0, 300));
      } finally {
        (q as { close?: () => void }).close?.();
      }
    }
  }, 600_000);
});
