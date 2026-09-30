import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { engineeringSystemPrompt } from "../../brain/provider/provider-brain";
import { providerUpFrontTools } from "../../engineering/lean-profile";
import { builtinTools } from "../../tools/builtin/index";
import { localBotFile } from "../../walls/bot-file";
import { tmpConfig } from "../helpers";
import { CLI_BASELINE, cliEquivalent, renderTable, replayCodingEngine, replayEngineeringBot, summarize, syntheticConnectors, type BotProfile, type Summary } from "./token-replay";

/**
 * Token accounting on Synapse's own engine (0.1.8: close the coding token gap). Replays the 14 coding-bench tasks, CLI
 * shaped (76 model calls, the CLI's own count), through (a) the provider-loop coding engine and (b) an engineering-mode
 * Bot on ProviderBrain, both on Claude through the Messages adapter, against the fake Messages API's cache simulation.
 * See token-replay.ts for the method and the token ratios. No key, no network:
 *
 *   npx vitest run --project host host/test/perf/engine-tokens.test.ts --silent=false
 *   (TOKENS_OUT=<dir> also writes report.md and summary.json there)
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function engineeringProfile(connectors: number, deferral = true): Promise<BotProfile> {
  app = await createHostApp(tmpConfig({ FUZZ: "1" }));
  const { id } = await app.handlers.createAgent!({ name: "Tokens", isKickstartRequested: false });
  await app.handlers.setAgentEngineeringMode!({ id, enabled: true });
  const system = engineeringSystemPrompt(app.services.runner.systemAppend(id));
  const botTools = app.services.runner.wiring(id).botTools();
  return {
    system, botTools, mcp: syntheticConnectors(connectors), upFront: deferral ? providerUpFrontTools({ engineeringMode: true }) : null,
    builtins: (cwd) => builtinTools({ botId: id, files: localBotFile({ deny: [] }), library: null, plugins: () => [], cwd: () => cwd, search: { botRef: () => "claude-sonnet-5-5", usable: () => true } }),
  };
}

const out: string[] = [];
const summaries: Record<string, Summary> = {};
function record(label: string, s: Summary) {
  summaries[label] = s;
  const t = renderTable(label, s);
  out.push(t);
  process.stdout.write(`${t}\n`);
  if (process.env.TOKENS_OUT) {
    fs.mkdirSync(process.env.TOKENS_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.TOKENS_OUT, "report.md"), `# Engine token accounting\n\nCLI baseline: ${CLI_BASELINE.source}; floor ${CLI_BASELINE.floorPerCall}/call, ${CLI_BASELINE.calls} calls.\n\n${out.join("\n")}`);
    fs.writeFileSync(path.join(process.env.TOKENS_OUT, "summary.json"), JSON.stringify(summaries, null, 1));
  }
}

describe("engine token accounting (14 bench tasks, CLI-shaped replay)", () => {
  it("provider-loop coding engine", async () => {
    const r = await replayCodingEngine();
    expect(r.toolErrors).toEqual([]);
    const s = summarize(r);
    record("provider-loop coding engine (Claude, Messages adapter)", s);
    expect(s.calls).toBe(CLI_BASELINE.calls);
    // Ratchets (0.1.8, measured 2026-09-30: 8 tools 4,333 chars, prompt 3,684 chars + the worktree line, session
    // 420,794 est. tokens vs 458,459 before the trims). Raising one is a decision, not an accident.
    expect(s.floor.toolCount).toBe(8);
    expect(s.floor.toolChars, "coding tool schemas (chars)").toBeLessThan(4_400);
    expect(s.floor.systemChars - 3_684, "coding prompt plus its worktree line (chars)").toBeLessThan(400);
    expect(s.session.total, "14-task session input (est. tokens)").toBeLessThan(430_000);
    expect(s.session.total, "at most a third of the CLI's for the same conversation").toBeLessThan(cliEquivalent(s) / 3);
  }, 120_000);

  for (const [connectors, deferral] of [[0, false], [0, true], [20, false], [20, true]] as const) {
    it(`engineering-mode Bot on ProviderBrain, ${connectors} connector tools, ${deferral ? "deferred loading" : "every tool up front"}`, async () => {
      const r = await replayEngineeringBot(await engineeringProfile(connectors, deferral));
      expect(r.toolErrors).toEqual([]);
      const s = summarize(r);
      record(`engineering Bot on ProviderBrain, ${connectors} connector tools, ${deferral ? "deferred loading" : "every tool up front"}`, s);
      expect(s.calls).toBe(CLI_BASELINE.calls);
      if (deferral) {
        // The up-front set: SendMessage, Read/Write/Edit/Glob/Grep, Skill, Shell, AwaitShell, CodingAgent, SearchHistory,
        // update_state and ToolSearch (13; 8,468 chars measured). A connector adds its name to ToolSearch, not its schema.
        expect(s.floor.toolCount, "up-front tools").toBeLessThanOrEqual(13);
        expect(s.floor.toolChars, "up-front tool schemas (chars)").toBeLessThan(connectors ? 9_300 : 8_700);
        expect(s.session.total, "no more than the CLI for the same conversation").toBeLessThan(cliEquivalent(s) * 0.6);
      }
    }, 120_000);
  }

  it("deferred loading saves at least 4,000 tokens a call, and connectors stop growing the floor", () => {
    const up0 = summaries["engineering Bot on ProviderBrain, 0 connector tools, every tool up front"]!;
    const d0 = summaries["engineering Bot on ProviderBrain, 0 connector tools, deferred loading"]!;
    const up20 = summaries["engineering Bot on ProviderBrain, 20 connector tools, every tool up front"]!;
    const d20 = summaries["engineering Bot on ProviderBrain, 20 connector tools, deferred loading"]!;
    expect(up0.floor.total - d0.floor.total).toBeGreaterThan(4_000);
    expect(up20.floor.total - d20.floor.total).toBeGreaterThan(10_000);
    expect(d20.floor.total - d0.floor.total, "20 connector tools cost their names only").toBeLessThan(400);
  });
});
