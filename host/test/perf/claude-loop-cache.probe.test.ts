import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { ProviderBrain } from "../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../brain/provider/session-store";
import type { BotToolDef, BrainWiring } from "../../brain/types";
import { startClaudeQuery } from "../../claude/spawn";
import { listCostUsd } from "../../usage/list-price";
import { setProviderRuntime } from "../../usage/metered-provider";
import { setUsageSink } from "../../usage/metered-query";
import { AsyncQueue } from "../../util/async-queue";
import { promptOf, startFakeMessagesServer, type MsgReply, type MsgRequest } from "../brain/provider/fake-messages-server";
import { startProviderRuntime } from "../brain/provider/runtime";

/**
 * Prompt-cache cost, today's path vs the new one (2026-09-30), on the wire. The SAME scripted conversation (4 user
 * turns, each: one shell call, then a reply) runs through the real Claude Code CLI (the Agent SDK path) and through
 * ProviderBrain on the Messages adapter, both against the fake Messages API that simulates the prompt cache from the
 * request bytes and their cache_control breakpoints. The system prompts and tool lists differ in size between the two
 * (the CLI's own), so the comparison is the cache SHAPE: the share of prompt tokens read from the cache, and the prompt
 * cost as a fraction of sending it all uncached. Needs the bundled CLI binary, no key, no network:
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/perf/claude-loop-cache.probe.test.ts
 */
const TURNS = ["check the disk", "now the logs", "and the network", "summarize it all"];
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => { setProviderRuntime(null); setUsageSink(null); for (const c of closers.splice(0)) await c.close(); });

type U = { input: number; read: number; write: number; total: number };
function summary(label: string, u: U[], ttl1h: boolean) {
  const total = u.reduce((a, x) => a + x.total, 0);
  const read = u.reduce((a, x) => a + x.read, 0);
  const write = u.reduce((a, x) => a + x.write, 0);
  const input = u.reduce((a, x) => a + x.input, 0);
  const cost = listCostUsd("claude-sonnet-5", { inputTokens: input, outputTokens: 0, cacheReadTokens: read, cacheWriteTokens: write, cacheWrite1hTokens: ttl1h ? write : 0 });
  const none = listCostUsd("claude-sonnet-5", { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const line = `[cache-compare] ${label}: calls=${u.length} prompt=${total} read=${(100 * read / total).toFixed(1)}% write=${(100 * write / total).toFixed(1)}% uncached=${(100 * input / total).toFixed(1)}% promptCost/uncached=${(cost / none).toFixed(3)}`;
  console.log(line);
  fs.appendFileSync(process.env.CACHE_OUT ?? path.join(os.tmpdir(), "claude-loop-cache.txt"), `${line}\n`);
  return { readShare: read / total, costRatio: cost / none };
}

describe.runIf(process.env.RUN_CLAUDE === "1")("prompt cache: Claude Code CLI vs Synapse's own loop, same conversation", () => {
  it("the new path reads at least as much of its prompt from the cache and costs no more per prompt token", async () => {
    // ---- today's path: the real CLI ----
    let cliTurn = 0;
    const cliScript = (r: MsgRequest): MsgReply => {
      const tools = (r.body.tools as { name: string }[] | undefined) ?? [];
      if (!tools.some((t) => t.name === "Bash")) return { blocks: [{ text: "ok" }] }; // a side call (titles, checks)
      const msgs = r.body.messages as { role: string; content: unknown }[];
      let i = msgs.length - 1;
      while (i > 0 && !(msgs[i]!.role === "user" && !(Array.isArray(msgs[i]!.content) && (msgs[i]!.content as { type: string }[]).some((x) => x.type === "tool_result")))) i--;
      const after = msgs.slice(i + 1).filter((m) => m.role === "assistant").length;
      return after === 0 ? { blocks: [{ tool: "Bash", input: { command: `echo ${TURNS[cliTurn]}`, description: "probe" } }] } : { blocks: [{ text: `Result for ${TURNS[cliTurn]}.` }] };
    };
    const cli = await startFakeMessagesServer(cliScript);
    closers.push(cli);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cache-cli-")));
    closers.push({ close: async () => fs.rmSync(home, { recursive: true, force: true }) });
    const input = new AsyncQueue<SDKUserMessage>();
    const q = startClaudeQuery({
      prompt: input, options: {
        cwd: home, model: "claude-sonnet-5", settingSources: [], persistSession: false, tools: ["Bash"], permissionMode: "default",
        canUseTool: async (_n, i) => ({ behavior: "allow", updatedInput: i }),
        env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: cli.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
      },
    }, query);
    const push = (t: string) => input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: t }] } } as SDKUserMessage);
    push(TURNS[0]!);
    for await (const m of q) {
      if (m.type !== "result") continue;
      cliTurn++;
      if (cliTurn >= TURNS.length) break;
      push(TURNS[cliTurn]!);
    }
    input.end();
    q.close();
    const convo = cli.requests.map((r, i) => ({ r, u: cli.usages[i]! })).filter(({ r }) => ((r.body.tools as { name: string }[] | undefined) ?? []).some((t) => t.name === "Bash")).map((x) => x.u);
    expect(convo.length).toBe(TURNS.length * 2);
    const today = summary("Claude Code CLI", convo, true);

    // ---- the new path: ProviderBrain on the Messages adapter ----
    const up = await startFakeMessagesServer((r) => {
      const { prompt, after } = promptOf(r.body);
      return after === 0 ? { blocks: [{ tool: "Shell", input: { command: `echo ${prompt}` } }] } : { blocks: [{ text: `Result for ${prompt}.` }] };
    });
    closers.push(up);
    const rt = await startProviderRuntime({ anthropicUpstream: up.url });
    closers.push({ close: rt.stop });
    setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
    // The same stable prefix size as the CLI's conversational calls: its system prompt plus its tool schemas, as text.
    const first = cli.requests.find((r) => ((r.body.tools as { name: string }[] | undefined) ?? []).some((t) => t.name === "Bash"))!;
    const sys = `${JSON.stringify(first.body.system)}\n${JSON.stringify(first.body.tools)}`;
    const shell: BotToolDef = { name: "Shell", description: "Run a shell command.", readOnly: false, schema: { command: z.string() }, handler: async (a) => ({ text: String(a.command) }) };
    const wiring: BrainWiring = {
      preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
      toolBatch: async () => ({ endTurn: false }), botTools: () => [shell], flags: () => DEFAULT_FLAGS,
      turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    };
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cache-own-"));
    closers.push({ close: async () => fs.rmSync(hp, { recursive: true, force: true }) });
    let sid: string | null = null;
    const brain = new ProviderBrain({ botId: "b", wiring, store: new ProviderSessionStore(hp), getSessionId: () => sid, systemPrompt: () => sys, cacheTtl: () => "1h", effort: () => "high" });
    for (const t of TURNS) await brain.runTurn({ prompt: [{ text: t }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: "claude-sonnet-5", autoReviewEpoch: "continue" }, (e) => { if (e.kind === "session") sid = e.sessionId; });
    const ours = summary("Synapse own loop", up.usages, true);
    expect(ours.readShare).toBeGreaterThanOrEqual(today.readShare - 0.02);
    expect(ours.costRatio).toBeLessThanOrEqual(today.costRatio + 0.02);
  }, 300_000);
});
