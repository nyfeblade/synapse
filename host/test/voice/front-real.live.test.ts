import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_BOT_MODEL, type UserMessageEntry } from "@synapse/shared";
import { createHostApp } from "../../app";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { collectUserTurn } from "../../runner/prompt-collector";
import { meteredQuery, runUsageOf } from "../../usage/metered-query";
import { AsyncQueue } from "../../util/async-queue";
import { fillTemplate, loadPrompt } from "../../prompts/index";
import { SdkFrontSession } from "../../voice/front-session";
import { CALL_MINUTES, CALL_SCRIPT } from "../../bench/voice/call-script";
import { tmpConfig } from "../helpers";

/**
 * Bug 142 — the ONE approved real-model run (under 100k tokens), on this Mac with the user's own sign-in:
 *   - the Bot's VOICE (host/voice/front-session.ts) for the whole scripted call: first-text latency and tokens a turn;
 *   - two turns of the OLD path's shape (the full Bot prompt: system append + built-ins + every bot tool schema), for
 *     the same utterances, as the latency and token comparison;
 *   - the CPU of every Claude process either path spawns, sampled while they run.
 * Everything it measures goes to test-reports/voice-fast-path/real/report.md; the bench's UNIT costs come from it.
 *
 * Run: `RUN_REAL_FRONT=1 npx vitest run --project host host/test/voice/front-real.live.test.ts --silent=false`
 */

const OUT = path.resolve(__dirname, "../../../test-reports/voice-fast-path/real");
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1))))]! : 0; };
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** %CPU of this process's Claude children, sampled while a turn runs. */
function childCpu(): { pcpu: number; rssMb: number; n: number } {
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,pcpu,rss,comm"], { encoding: "utf8" });
    const rows = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5 && Number(c[1]) === process.pid);
    return { pcpu: sum(rows.map((c) => Number(c[2]))), rssMb: Math.round(sum(rows.map((c) => Number(c[3]))) / 1024), n: rows.length };
  } catch { return { pcpu: 0, rssMb: 0, n: 0 }; }
}

describe.skipIf(process.env.RUN_REAL_FRONT !== "1")("voice fast path (REAL model, one run)", () => {
  it("measures the voice's latency and tokens a turn, against the old full-turn shape, and the CPU of both", async () => {
    const cpu: number[] = [];
    const rss: number[] = [];
    const sampler = setInterval(() => { const c = childCpu(); if (c.n) { cpu.push(c.pcpu); rss.push(c.rssMb); } }, 250);
    const localEnv: Record<string, string> = {
      HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin", USER: process.env.USER ?? "user", LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh", TMPDIR: os.tmpdir(), ENABLE_TOOL_SEARCH: "false",
    };

    // ---- the Bot's voice, the whole scripted call ----
    const system = fillTemplate(loadPrompt("voice-front.md"), { BOT_NAME: "Nova", USER_NAME: "Alex", PERSONA: "Chief of Staff. Warm, quick, a little dry; keeps things moving." });
    const front = new SdkFrontSession({ botId: "bench", model: DEFAULT_BOT_MODEL, system }, { env: localEnv, cwd: os.tmpdir() });
    const frontTurns: { text: string; firstTextMs: number | null; tokens: number; delegated: string[]; usage: Record<string, number> }[] = [];
    let seeded = false;
    for (const u of CALL_SCRIPT) {
      const msg = seeded ? `User: ${u.text}` : `[earlier]\nUser: can you keep an eye on the retainer numbers today\nNova: Will do.\nUser: ${u.text}`;
      seeded = true;
      const r = await front.turn(msg, () => {}, () => {});
      frontTurns.push({ text: r.text, firstTextMs: r.firstTextMs, tokens: r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens, delegated: r.delegations, usage: { ...r.usage } });
      if (r.error) break;
    }
    front.close();
    const frontCpu = { p50: pct(cpu, 50), p90: pct(cpu, 90), rss: pct(rss, 90) };
    cpu.length = 0; rss.length = 0;

    // ---- the old shape: two turns of the full Bot prompt (system append + built-ins + every bot tool) ----
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Nova", isKickstartRequested: false });
    const systemAppend = app.services.runner.systemAppend(id);
    const wiring = app.services.runner.wiring(id);
    const base = buildBotQueryOptions({
      cfg: app.services.phase4 ? (tmpConfig()) : tmpConfig(), flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null,
      systemAppend, systemPromptMode: "standalone", model: DEFAULT_BOT_MODEL, effort: "low", env: localEnv,
      mcpServers: { bot: toSdkMcpServer(wiring) }, botToolNames: wiring.botTools().map((t) => t.name),
      hooks: {}, canUseTool: async () => ({ behavior: "deny", message: "(bench) tools don't run here" }), abortController: new AbortController(),
    });
    const fullTurns: { text: string; firstTextMs: number | null; tokens: number; usage: Record<string, number> }[] = [];
    for (const u of [CALL_SCRIPT[0]!, CALL_SCRIPT[2]!]) {
      const entry: UserMessageEntry = { kind: "message", id: "t1u", role: "user", content: u.text, createdAt: Date.now(), voice: { durationMs: 2_000, call: true } };
      const prompt = collectUserTurn({ messages: [{ entry, before: [], after: [] }], profileUpdate: null, blocks: [] });
      const input = new AsyncQueue<SDKUserMessage>();
      const ac = new AbortController();
      const options: Options = { ...base, env: localEnv, cwd: os.tmpdir(), persistSession: false, abortController: ac, includePartialMessages: true, thinking: { type: "disabled" } };
      delete (options as { pathToClaudeCodeExecutable?: string }).pathToClaudeCodeExecutable;
      const q = meteredQuery({ purpose: "voice-bench", botId: null }, { prompt: input, options });
      const t0 = Date.now();
      input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt.map((p) => ("text" in p ? { type: "text" as const, text: p.text } : { type: "text" as const, text: "" })) } } as SDKUserMessage);
      input.end();
      let first: number | null = null;
      let text = "";
      let usage: Record<string, number> = {};
      const timer = setTimeout(() => ac.abort(), 60_000);
      for await (const m of q) {
        const msg = m as unknown as { type: string; event?: { type?: string; delta?: { type?: string; text?: string; partial_json?: string } }; result?: string };
        if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && first === null) {
          const d = msg.event.delta ?? {};
          if (d.type === "text_delta" || (d.type === "input_json_delta" && /content/.test(d.partial_json ?? ""))) first = Date.now() - t0;
        }
        if (msg.type === "result") { const u2 = runUsageOf(m); if (u2) usage = { ...u2 }; text = String(msg.result ?? "").slice(0, 200); }
      }
      clearTimeout(timer);
      q.close?.();
      fullTurns.push({ text, firstTextMs: first, tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), usage });
    }
    await app.close();
    clearInterval(sampler);
    const fullCpu = { p50: pct(cpu, 50), p90: pct(cpu, 90), rss: pct(rss, 90) };

    const firsts = frontTurns.map((t) => t.firstTextMs ?? 0).filter(Boolean);
    const spent = sum(frontTurns.map((t) => t.tokens)) + sum(fullTurns.map((t) => t.tokens));
    const md = [
      "# Voice fast path — the real-model run (one, on this Mac)",
      `Model ${DEFAULT_BOT_MODEL}, low effort, thinking off. ${frontTurns.length} voice turns and ${fullTurns.length} old-shape turns; ${spent.toLocaleString()} tokens in total.`,
      "",
      "## The Bot's voice (the fast path)",
      `first text: p50 ${pct(firsts, 50)} ms, p90 ${pct(firsts, 90)} ms (n=${firsts.length})`,
      `tokens a turn: first ${frontTurns[0]?.tokens.toLocaleString()}, later p50 ${pct(frontTurns.slice(1).map((t) => t.tokens), 50).toLocaleString()}`,
      `CPU while it ran: p50 ${frontCpu.p50}% of a core, p90 ${frontCpu.p90}%; RSS p90 ${frontCpu.rss} MB`,
      `delegated ${frontTurns.filter((t) => t.delegated.length).length} of ${frontTurns.length} turns`,
      "",
      "| # | utterance | first text (ms) | tokens | delegated | said |",
      "|---|---|---|---|---|---|",
      ...frontTurns.map((t, i) => `| ${i + 1} | ${CALL_SCRIPT[i]?.text ?? ""} | ${t.firstTextMs ?? "-"} | ${t.tokens} | ${t.delegated[0] ? `yes: ${t.delegated[0].slice(0, 60)}` : "no"} | ${t.text.replace(/\n/g, " ").slice(0, 80)} |`),
      "",
      "## The old shape (a full-session turn per utterance)",
      ...fullTurns.map((t, i) => `- "${[CALL_SCRIPT[0]!, CALL_SCRIPT[2]!][i]!.text}": first text ${t.firstTextMs ?? "-"} ms, ${t.tokens.toLocaleString()} tokens (${JSON.stringify(t.usage)})`),
      `CPU while they ran: p50 ${fullCpu.p50}% of a core, p90 ${fullCpu.p90}%; RSS p90 ${fullCpu.rss} MB`,
      "",
      "## Raw",
      "```json",
      JSON.stringify({ frontTurns, fullTurns, frontCpu, fullCpu, callMinutes: CALL_MINUTES }, null, 2),
      "```",
      "",
    ].join("\n");
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "report.md"), md);
    console.warn(md.slice(0, 4_000));
    expect(frontTurns.length).toBeGreaterThan(4);
    expect(spent).toBeLessThan(100_000);
  }, 30 * 60_000);
});
