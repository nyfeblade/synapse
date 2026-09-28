/**
 * Per built-in tool schema cost, by the CLI's own /context accounting (the same instrument as
 * context-budget.probe.test.ts: Query.getContextUsage with detail "summary", no model call).
 * Each run spawns the real CLI with the Bot's production options and exactly one built-in in
 * `tools`, so the "System tools" row is that tool alone. Gated: it spawns ~12 CLI processes.
 *
 *   PROMPT_BUDGET_PROBE=1 BUDGET_OUT=/tmp/tools.txt npx vitest run --project host host/test/perf/builtin-tools.probe.test.ts
 */
import fs from "node:fs";
import { describe, it } from "vitest";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { BOT_BUILTIN_TOOLS, TOOL_SEARCH } from "../../brain/tool-policy";
import { tmpConfig } from "../helpers";
import { explicitKeyEnv } from "../../auth/dev-auth";
import { startClaudeQuery } from "../../claude/spawn";

const OUT = process.env.BUDGET_OUT ?? "/tmp/tools.txt";
const w = (...a: unknown[]) => fs.appendFileSync(OUT, a.join(" ") + "\n");
const CANDIDATES = [...new Set([...BOT_BUILTIN_TOOLS, TOOL_SEARCH, "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Skill"])];

describe.skipIf(process.env.PROMPT_BUDGET_PROBE !== "1")("CLI /context accounting per built-in tool", () => {
  it("prints System tools tokens for each built-in alone, and for the production list", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const measure = async (label: string, tools: string[]) => {
      const o: Options = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null,
        systemAppend: "", systemPromptMode: "standalone", model: "claude-haiku-4-5-20251001",
        env: { ...explicitKeyEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false", ENABLE_TOOL_SEARCH: buildBotEnv({ cfg, botId: "b" }).ENABLE_TOOL_SEARCH! },
        mcpServers: {}, botToolNames: [], tools,
        hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
      });
      o.cwd = "/tmp";
      delete (o as { hooks?: unknown }).hooks;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      async function* input(): AsyncGenerator<never> { await gate; return; }
      const q = startClaudeQuery({ prompt: input() as never, options: o }, query);
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const r = (await q.getContextUsage({ detail: "summary" })) as unknown as { categories: { name: string; tokens: number; kind: string }[] };
        const cats = r.categories.filter((c) => /System tools|Skills/.test(c.name)).map((c) => `${c.name}${c.kind === "deferred" ? " (deferred)" : ""}=${c.tokens}`);
        w(label.padEnd(28), cats.join(" · "));
      } catch (e) {
        w(label, "ERR", String(e).slice(0, 200));
      } finally {
        release();
        q.close();
      }
    };
    w(`\n##### ${new Date().toISOString()}`);
    await measure("production list", [...BOT_BUILTIN_TOOLS, TOOL_SEARCH]);
    for (const t of CANDIDATES) await measure(t, [t]);
  }, 600_000);
});
