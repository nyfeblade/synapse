import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHostApp, type HostApp } from "../../app";
import { BOT_BUILTIN_TOOLS, STANDARD_BOT_BUILTIN_TOOLS } from "../../brain/tool-policy";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { McpProxyPool } from "../../mcp/proxy";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";
import path from "node:path";
import { ENGINEERING_MODE_EXTRA_TOKENS, PROMPT_MEASURED } from "@synapse/shared";
import { loadPrompt } from "../../prompts/index";
import { ENGINEERING_UP_FRONT_TOOLS, EVERYDAY_PROFILE_MEASURED, EVERYDAY_UP_FRONT_TOOLS, LEAN_PROFILE_MEASURED, LEAN_TARGET_OVER_CLI_TOKENS } from "../../engineering/lean-profile";
import { tmpConfig } from "../helpers";
import { createComputerTool } from "../../computer/computer-tool";
import type { DisplayManager } from "../../computer/displays";
import { LIVE_TOOLS_CHARS_CEILING, createPerceptionTools } from "../../computer/perception/tools";
import { SseHub } from "../../gateway/sse-hub";

/**
 * The per-turn floor.
 *
 * Everything below is re-sent on EVERY model call of a session, not once per turn and not once per
 * use. Measured on 2026-09-19 by asking the CLI for its own /context accounting (Query.getContextUsage,
 * which is a control request and costs no model call), for a freshly created Bot with no connectors:
 *
 *                          before    after
 *   System prompt      6,142    5,996   (Claude Code's preset ~3,636 + this host's append)
 *   System tools      13,181   13,181   (the 10 built-ins in BOT_BUILTIN_TOOLS — not ours to shrink)
 *   Skills             1,556    1,556   (the CLI's own built-in skill frontmatter)
 *   MCP tools          9,868    7,465   (42 -> 26 mcp__bot__* tools, capability-gated)
 *   ---------------------------------
 *   total             30,747   28,199   before a single word of conversation (-8.3%)
 *
 * Only two of those rows are this codebase's to control, and this test is the ratchet on both. The
 * ceilings are the measured numbers plus headroom, in the units the test can measure cheaply and
 * deterministically (characters). Raising one is a decision, not an accident: the CLI's accounting
 * put the bot tool schemas at ~2.0 chars per token on the wire, so 1,000 chars here is ~500 tokens
 * on every call of every session of every Bot.
 */
let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });

/** What the CLI puts on the wire for one MCP tool: prefixed name, description, JSON schema. */
function wireBytes(t: { name: string; description: string; schema: Record<string, unknown> }): number {
  let schema: unknown = {};
  try {
    schema = JSON.parse(JSON.stringify(z.toJSONSchema(z.object(t.schema as never), { io: "input" })));
  } catch {
    schema = {};
  }
  return JSON.stringify({ name: `mcp__bot__${t.name}`, description: t.description, input_schema: schema }).length;
}

describe("per-turn prompt budget", () => {
  it("holds the appended system prompt and the bot tool surface under their measured ceilings", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Budget", isKickstartRequested: false });

    const systemAppend = a.services.runner.systemAppend(id);
    const tools = a.services.runner.wiring(id).botTools();
    const toolBytes = tools.reduce((s, t) => s + wireBytes(t as never), 0);

    // Measured 2026-09-19: 9,440 chars -> 2,360 tokens by the CLI's own count.
    // 2026-09-24, bug 199: a voice call told the user a non-Chrome browser was "outside my reach" instead of
    // delegating — base.md's Browser line said only Chrome, with no pointer to MacApp for anything else. One
    // sentence added (93 chars, ~46 tokens a call), 10,375 -> 10,468. The ceiling moved by that and no more.
    expect(systemAppend.length, `appended system prompt (${systemAppend.length} chars)`).toBeLessThan(10_470);
    // A fresh Bot on a one-Bot app with nothing installed and no Mac connected: 26 tools / 7,465
    // tokens. It was 42 tools / 9,868 tokens before the capability gates. The ceilings sit just above
    // the gated numbers, so re-mounting a group by accident fails here instead of on the bill.
    expect(tools.length, `tool count (${tools.length})`).toBeLessThanOrEqual(28);
    // 2026-09-21, a decision (decisions.md): SearchHistory added 446 chars (~220 tokens a call at the
    // measured ~2.0 chars/token), 14,475 -> 14,921. The ceiling moved by that and no more.
    // 2026-09-22, bug 158 (decisions.md): a Bot on a call can take another Bot off it. Deliberately the
    // cheapest possible shape — no new tool (the count below stays at 28) and no new schema field:
    // SendMessage's `call` parameter already exists for "why" and "look", so only its sentence grew,
    // by 35 chars (~18 tokens a call), 14,997 -> 15,032. The ceiling moved by that and no more.
    expect(toolBytes, `bot tool schemas (${toolBytes} chars)`).toBeLessThan(15_035);

    // The built-ins are the single biggest row. Token diet (4), measured 2026-09-21 by
    // builtin-tools.probe.test.ts (CLI 2.1.277, each tool alone minus the ~627-token fixed row):
    // Bash 5,806 · Grep 1,708 · Read 1,182 · Edit 740 · ToolSearch 609 · Write 400 · Glob 379
    // loaded; WebFetch, WebSearch and TodoWrite deferred. Glob and Grep went: System tools 11,450 -> 9,228 (-2,222 a call);
    // Bash's find/grep/rg cover them. The list must not grow back by accident.
    expect(BOT_BUILTIN_TOOLS).toHaveLength(8);
    expect(BOT_BUILTIN_TOOLS).not.toContain("Glob");
    expect(BOT_BUILTIN_TOOLS).not.toContain("Grep");
    // cost-diet-2 lever 2: an everyday Bot also drops Bash (5,806 tokens a call); its shell is the host's
    // Shell. Engineering Bots keep the full list above. Nothing else differs between the two lists.
    expect(STANDARD_BOT_BUILTIN_TOOLS).toEqual(BOT_BUILTIN_TOOLS.filter((t) => t !== "Bash"));
    expect(BOT_BUILTIN_TOOLS).toContain("Bash");
  });

  /**
   * Lazy tools. Measured 2026-09-21 with context-budget.probe.test.ts, same Bot plus the built-in
   * Google server and three installed public connectors (context7, aws-knowledge, cloudflare-docs;
   * 20 connector tools), CLI 2.1.277:
   *
   *                       before (ENABLE_TOOL_SEARCH=false)   after (true, bot tools alwaysLoad)
   *   System prompt        6,083                                6,083
   *   System tools        13,181                               11,450   (+ToolSearch; WebFetch/WebSearch/TodoWrite deferred: 1,966)
   *   MCP tools           17,936                                7,463   (27 mcp__bot__* loaded; 20 connector tools deferred: 10,472)
   *   Skills               1,556                                1,556
   *   ---------------------------------
   *   total               38,756                               26,552   (-12,204 per call, -31%)
   *
   * Every connector adds to the "before" column and nothing to the "after" one, so the saving grows
   * with what the user installs. This is the ratchet on the mechanism: the env turns tool search on,
   * a Bot can reach ToolSearch, its own tools opt out (alwaysLoad), and connector servers do not.
   */
  it("keeps connector tool schemas behind tool search and the Bot's own tools loaded", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Lazy", isKickstartRequested: false });
    expect(buildBotEnv({ cfg, botId: id }).ENABLE_TOOL_SEARCH).toBe("true");
    const o = buildBotQueryOptions({
      cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "m", env: {},
      mcpServers: {}, botToolNames: ["SendMessage"], hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
    });
    expect(o.tools).toContain("ToolSearch");
    expect(o.disallowedTools).not.toContain("ToolSearch");

    const listed = async (cfg: McpSdkServerConfigWithInstance) => {
      const [s, c] = InMemoryTransport.createLinkedPair();
      await (cfg.instance as unknown as { connect(t: unknown): Promise<void> }).connect(s);
      const client = new Client({ name: "budget", version: "1" });
      await client.connect(c);
      try { return (await client.listTools()).tools; } finally { await client.close(); }
    };
    const alwaysLoad = (t: { _meta?: Record<string, unknown> }) => t._meta?.["anthropic/alwaysLoad"] === true;
    const bot = await listed(toSdkMcpServer(a.services.runner.wiring(id)));
    expect(bot.length).toBeGreaterThan(0);
    expect(bot.filter((t) => !alwaysLoad(t)).map((t) => t.name), "every mcp__bot__ tool loads up front").toEqual([]);

    // A connector the user installed, served through the host's proxy pool (the path every curated,
    // custom and header-auth remote server takes), stays deferred.
    const reg = new McpRegistry({ dir: path.join(cfg.hostPrivate, "budget-mcp"), settings: new HostSettingsStore(path.join(cfg.hostPrivate, "budget-settings.json")), now: () => 1 });
    const s = reg.add({ name: "Budget Remote", url: "https://budget.example/mcp" }, "custom");
    const remote = new McpServer({ name: "r", version: "1" });
    remote.tool("lookup", "Look something up", { q: z.string() }, async () => ({ content: [] }));
    const [ra, rb] = InMemoryTransport.createLinkedPair();
    await remote.connect(ra);
    const rc = new Client({ name: "pool", version: "1" });
    await rc.connect(rb);
    const pool = new McpProxyPool({ registry: reg, workspace: cfg.workspace, now: () => 1,
      connect: async () => ({ listTools: async () => (await rc.listTools()).tools, callTool: async () => ({ content: [] }), close: () => rc.close() }) });
    const conn = await listed(pool.sdkServers(id)[s.id]!);
    expect(conn.map((t) => t.name)).toEqual(["lookup"]);
    expect(conn.filter(alwaysLoad), "a connector tool never loads up front").toEqual([]);
    await pool.closeAll();
  });

  /**
   * The two prompt modes (user decision 2026-09-21). OFF = standalone.md + the Bot prompt, one string;
   * ON = the vendor preset + the Bot prompt + the ENGINEERING MODE section. The preset's own text is
   * not in this repo, so its size comes from the measurement (decisions.md 2026-09-20: the same Bot,
   * CLI /context, preset 6,022 vs standalone 3,552 tokens, so the preset is 2,470 tokens longer than
   * standalone.md was then). Our own text is converted at 4.0 chars per token, the ratio the CLI's
   * count gave this append (9,440 chars -> 2,360 tokens). The settings switch shows the difference.
   */
  it("reports both prompt modes' sizes, and the settings switch's token cost is derived from them", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Modes", isKickstartRequested: false });
    a.services.bots.updateSettings(id, { engineeringOffered: true }); // compare like with like: no offer hint on either side
    const offAppend = a.services.runner.systemAppend(id);
    await a.handlers.setAgentEngineeringMode!({ id, enabled: true });
    const onAppend = a.services.runner.systemAppend(id);

    const { charsPerToken, presetOverStandaloneTokens } = PROMPT_MEASURED;
    const standalone = loadPrompt("standalone.md").trim();
    const modeLine = standalone.split("\n").find((l) => /standard mode/i.test(l)) ?? "";
    const presetTokens = (standalone.length - modeLine.length) / charsPerToken + presetOverStandaloneTokens;
    const off = Math.round((standalone.length + 2 + offAppend.length) / charsPerToken);
    const on = Math.round(presetTokens + onAppend.length / charsPerToken);
    process.stdout.write(`system prompt per call — standard (standalone): ~${off} tokens; engineering (preset + append): ~${on} tokens; difference ~${on - off}\n`);

    expect(onAppend).toContain("# ENGINEERING MODE");
    expect(on - off, "engineering costs more than standard").toBeGreaterThan(2_000);
    expect(ENGINEERING_MODE_EXTRA_TOKENS, "the number the settings switch shows").toBe(Math.round((on - off) / 100) * 100);
    // The section itself stays small: it explains the mode, it does not re-teach coding.
    expect(onAppend.length - offAppend.length).toBeLessThan(1_400);
  });

  /**
   * S1 lean engineering profile (decisions.md 2026-09-21). The pinned numbers are the CLI's own /context
   * accounting (context-budget.probe.test.ts, no model call); this test holds the property they show and
   * ratchets the one part it can measure cheaply: the bot tool schemas an engineering Bot loads up front.
   */
  it("lean engineering profile: engineering per-call tokens before and after, against the measured CLI floor", async () => {
    for (const [model, m] of Object.entries({ sonnet: LEAN_PROFILE_MEASURED.sonnet, haiku: LEAN_PROFILE_MEASURED.haiku })) {
      for (const row of [m.cliFloor, m.before, m.after]) expect(row.systemPrompt + row.systemTools + row.skills + row.mcpTools, `${model} rows add up`).toBe(row.total);
      process.stdout.write(`${model}: CLI floor ${m.cliFloor.total} · engineering before ${m.before.total} · after ${m.after.total} (${m.after.total - m.cliFloor.total >= 0 ? "+" : ""}${m.after.total - m.cliFloor.total} vs the CLI)\n`);
      // On the Bots' default model (sonnet) the engineering Bot was over target before S1. On haiku the
      // vanilla CLI's own floor is 28.8k (its preset and 20k of built-in tool schemas), so it never was.
      if (model === "sonnet") expect(m.before.total - m.cliFloor.total, "sonnet: before S1 the engineering Bot was over target").toBeGreaterThan(LEAN_TARGET_OVER_CLI_TOKENS);
      expect(m.before.total - m.after.total, `${model}: S1 saves at least the deferred bot schemas net of ToolSearch's growth`).toBeGreaterThan(5_000);
      expect(m.after.total, `${model}: engineering per call <= CLI floor + ${LEAN_TARGET_OVER_CLI_TOKENS}`).toBeLessThanOrEqual(m.cliFloor.total + LEAN_TARGET_OVER_CLI_TOKENS);
      expect(m.after.systemPrompt, "S1 does not touch the system prompt").toBe(m.before.systemPrompt);
    }

    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Lean", isKickstartRequested: false });
    const all = a.services.runner.wiring(id).botTools();
    // cost-diet-2 levers 2 + 3: a standard (everyday) Bot loads the evidence-picked set and no Bash.
    expect(a.services.spawnConfig(id).upFrontBotTools, "an everyday Bot loads the everyday set up front").toEqual([...EVERYDAY_UP_FRONT_TOOLS]);
    expect(a.services.spawnConfig(id).builtinTools, "an everyday Bot has no built-in Bash").toEqual([...STANDARD_BOT_BUILTIN_TOOLS]);
    await a.handlers.setAgentEngineeringMode!({ id, enabled: true });
    const upFront = a.services.spawnConfig(id).upFrontBotTools!;
    expect(upFront).toEqual([...ENGINEERING_UP_FRONT_TOOLS]);
    const tools = a.services.runner.wiring(id).botTools();
    const upBytes = tools.filter((t) => upFront.includes(t.name)).reduce((s, t) => s + wireBytes(t as never), 0);
    const allBytes = all.reduce((s, t) => s + wireBytes(t as never), 0);
    process.stdout.write(`engineering up-front bot schemas ${upBytes} chars (every bot tool: ${allBytes})\n`);
    // Measured 2026-09-21: 3,849 chars -> 2,022 tokens (MCP tools, loaded; 14,921 for every bot tool). A 5th up-front tool fails here.
    expect(upBytes, `engineering up-front bot schemas (${upBytes} chars)`).toBeLessThan(4_100);
    expect(tools.filter((t) => upFront.includes(t.name))).toHaveLength(ENGINEERING_UP_FRONT_TOOLS.length);
    expect(a.services.spawnConfig(id).builtinTools ?? [...BOT_BUILTIN_TOOLS], "engineering keeps Bash").toContain("Bash");
  });

  /**
   * cost-diet-2 levers 2 + 3, the everyday profile. Measured with the CLI's own /context accounting
   * (context-budget.probe.test.ts "measures an everyday Bot before and after", no model call), pinned in
   * engineering/lean-profile.ts EVERYDAY_PROFILE_MEASURED. The ratchet here: the rows add up, the saving
   * holds, and the up-front bot schemas stay under their measured ceiling.
   */
  it("everyday profile: per-call tokens before and after, and the up-front schema ceiling", async () => {
    for (const [model, m] of Object.entries(EVERYDAY_PROFILE_MEASURED.models)) {
      for (const row of [m.before, m.after]) expect(row.systemPrompt + row.systemTools + row.skills + row.mcpTools, `${model} rows add up`).toBe(row.total);
      process.stdout.write(`${model}: everyday before ${m.before.total} · after ${m.after.total} (${m.after.total - m.before.total})\n`);
      expect(m.before.total - m.after.total, `${model}: no Bash + deferred bot tools save at least 7k a call`).toBeGreaterThan(7_000);
      expect(m.after.systemPrompt, "the profile does not touch the system prompt").toBe(m.before.systemPrompt);
    }
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Everyday", isKickstartRequested: false });
    const tools = a.services.runner.wiring(id).botTools();
    const upBytes = tools.filter((t) => EVERYDAY_UP_FRONT_TOOLS.includes(t.name)).reduce((s, t) => s + wireBytes(t as never), 0);
    process.stdout.write(`everyday up-front bot schemas ${upBytes} chars\n`);
    expect(tools.map((t) => t.name), "Shell is always registered, so dropping Bash loses no shell").toContain("Shell");
    expect(upBytes, `everyday up-front bot schemas (${upBytes} chars)`).toBeLessThan(EVERYDAY_PROFILE_MEASURED.upFrontCharsCeiling);
  });

  /**
   * "Computer perception" (decisions.md 2026-09-21). A computerUse child's `computer` server is re-sent on every one
   * of the child's model calls: Screenshots mode = the Computer tool; Live (beta) = Look + Act + Screenshot. Live must
   * stay cheaper per call than what it replaces, and under its own ceiling. (Observation savings are the bench's job.)
   */
  it("computerUse child: Live's Look/Act/Screenshot schemas cost less per call than the Computer tool", () => {
    const wire = (t: { name: string; description: string; schema: Record<string, unknown> }) =>
      JSON.stringify({ name: `mcp__computer__${t.name}`, description: t.description, input_schema: JSON.parse(JSON.stringify(z.toJSONSchema(z.object(t.schema as never), { io: "input" }))) }).length;
    const computer = wire(createComputerTool({ botId: "b", displays: {} as DisplayManager, hub: new SseHub(), workspace: "/tmp", enforce: () => true, now: () => 1 }) as never);
    const live = createPerceptionTools({ service: async () => { throw new Error("unused"); }, botId: "b", hub: new SseHub(), now: () => 1 }).reduce((s, t) => s + wire(t as never), 0);
    process.stdout.write(`computerUse child schemas: Screenshots (Computer) ${computer} chars ~${Math.round(computer / 2)} tokens · Live (Look+Act+Screenshot) ${live} chars ~${Math.round(live / 2)} tokens\n`);
    expect(live, `live tool schemas (${live} chars)`).toBeLessThan(LIVE_TOOLS_CHARS_CEILING);
    expect(live).toBeLessThan(computer);
  });

  /**
   * mac-browser (decisions.md 2026-09-22). The Browser tool (drive a browser on the user's Mac) arrives with a registered
   * Mac and is DEFERRED in both profiles: what a call sends for it is its name in the deferred list, not its schema.
   * Measured with context-budget.probe.test.ts "measures the deferred Browser tool on an everyday Bot with a Mac
   * registered" (CLI 2.1.277, the CLI's own /context, no model call), sonnet-5:
   *   without Browser  System prompt 5,046 · System tools 2,778 · MCP tools 2,112 · Skills 2,074 = 12,010
   *   with Browser     System prompt 5,046 · System tools 2,778 · MCP tools 2,109 · Skills 2,074 = 12,007
   *   (Browser's 541-token schema is counted under "MCP tools (deferred)": 6,997 -> 7,528, not sent.)
   * The first test above holds the WHOLE schema surface of a Mac-less Bot (Browser isn't in it). This one measures
   * what is actually sent per call with a Mac registered: up-front schemas in full, deferred tools by name only.
   */
  it("the Mac Browser tool is deferred: with a Mac registered it adds only its name to a call", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Browse", isKickstartRequested: false });
    await a.handlers.registerLocalComputer!({ computer: { computerId: "mac1", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/x" } } as never);
    const listed = async (cfg: McpSdkServerConfigWithInstance) => {
      const [s, c] = InMemoryTransport.createLinkedPair();
      await (cfg.instance as unknown as { connect(t: unknown): Promise<void> }).connect(s);
      const client = new Client({ name: "budget", version: "1" });
      await client.connect(c);
      try { return (await client.listTools()).tools; } finally { await client.close(); }
    };
    for (const engineering of [false, true]) {
      await a.handlers.setAgentEngineeringMode!({ id, enabled: engineering });
      const upFront = a.services.spawnConfig(id).upFrontBotTools!;
      const tools = a.services.runner.wiring(id).botTools();
      const sdk = await listed(toSdkMcpServer(a.services.runner.wiring(id), upFront));
      // Sent per call: up-front schemas in full + every deferred tool's name (the CLI lists deferred names only).
      const sent = (ts: typeof tools) => ts.reduce((s, t) => s + (upFront.includes(t.name) ? wireBytes(t as never) : `mcp__bot__${t.name}`.length + 1), 0);
      // mac-apps: MacApp rides the same ratchet as Browser — a Mac-gated tool that is never up front, so a call
      // carries its NAME, not its schema. Its schema is the biggest of the bot tools (33 actions, 14 fields), which
      // is exactly why it must stay deferred; the Mac-less whole-surface test above is unaffected by it.
      for (const name of ["Browser", "MacApp"]) {
        expect(tools.map((t) => t.name)).toContain(name);
        expect(upFront, `${name} is never up front`).not.toContain(name);
        expect(sdk.find((t) => t.name === name)!._meta?.["anthropic/alwaysLoad"], `the SDK server defers ${name}`).not.toBe(true);
        const withT = sent(tools);
        const without = sent(tools.filter((t) => t.name !== name));
        process.stdout.write(`${engineering ? "engineering" : "everyday"} + Mac: sent per call ${without} -> ${withT} chars with ${name} (its full schema would be ${wireBytes(tools.find((t) => t.name === name) as never)})\n`);
        expect(withT - without, `${name} adds only its name per call`).toBeLessThanOrEqual(`mcp__bot__${name}`.length + 1);
      }
      const upBytes = tools.filter((t) => upFront.includes(t.name)).reduce((s, t) => s + wireBytes(t as never), 0);
      expect(upBytes, "the up-front ceiling holds with a Mac registered").toBeLessThan(engineering ? 4_100 : EVERYDAY_PROFILE_MEASURED.upFrontCharsCeiling);
      // The 28-tool ceiling is measured on a Mac-LESS Bot (the test above), because that is the surface every
      // Bot pays for. What matters here is that connecting a Mac adds exactly the Mac family and no more, and
      // that every one of them is deferred, so the count does not become a per-call cost.
      const mac = ["ExternalShell", "AwaitExternalShell", "ExternalRead", "CopyToBox", "CopyFromBox", "Mac", "Browser", "MacApp"];
      expect(tools.map((t) => t.name).filter((n) => mac.includes(n)).sort()).toEqual([...mac].sort());
      for (const n of mac) expect(upFront, `${n} is never up front`).not.toContain(n);
    }
  });

  it("charges every tool to someone: no tool is registered twice", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const names = app.services.runner.wiring((await app.handlers.createAgent!({ name: "Dup", isKickstartRequested: false })).id).botTools().map((t) => t.name);
    expect(names.length, "a duplicate name is a schema paid for twice").toBe(new Set(names).size);
  });
});
