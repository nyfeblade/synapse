import fs from "node:fs";
import path from "node:path";
import { CliRunner, realClaudeExec, type ClaudeExec, type CliSession } from "./cli";
import { fakeClaudeExec, FakeBox, idleModel, type FakeModel } from "./fake";
import { prepareTask, readTexts, snapshot, tmpDir } from "./repo";
import { scoreRun, summarize, type RunnerSummary, type ScoredRun } from "./score";
import { promptFor, sessionsFor } from "./suite";
import { SynapseRunner, type SynapseBox, type SynapseSession } from "./synapse";
import { ProviderLoopRunner, type ProviderLoopSession } from "./provider-loop";
import type { AgentRun, RunnerName } from "./types";
import { verifyTask } from "./verify";
import { renderMarkdown } from "./report";

/** What the harness makes equal across runners, and what it cannot. Printed in every report. */
export const PARITY = {
  equalised: [
    "Same prompt text: one location line (\"You are working in the git repository at <path>\") + the task prompt.",
    "Same model id on both (--model for the CLI, createAgent/updateAgent model for the Bot).",
    "Same starting state: the same deterministic commit (SHA recorded per task), no node_modules in the copy, the same vitest/typescript versions linked in (on the box: a Bot-writable node_modules folder linking each shared package, so vitest can write its temp config as on the Mac).",
    "Same wall-clock limit per task; at the limit the CLI process is killed and the Bot is interrupted.",
    "Same weighted-token budget per task (bug-log 88), metered live: the CLI's streamed per-call usage; the Bot's session file plus its usage.db review rows. Past it the run is stopped and fails as budget exceeded.",
    "No human: questions and approvals are auto-declined, cards with no decline are skipped, a Bot stuck awaiting the user is interrupted. Every one is counted as an intervention.",
    "Success is decided only by hidden verification run on the Mac on the final repo state, for both runners.",
    "Follow-up tasks resume the same session (CLI --resume <session id>; the same Bot chat).",
  ],
  notEqualised: [
    "OS: the CLI runs on macOS (the Mac); the Bot runs on Linux (the box VM). Shell tools differ (BSD vs GNU sed/grep).",
    "System prompt: the CLI gets Claude Code's preset only; the Bot gets the preset + its Bot prompt + the ENGINEERING MODE section, plus its Bot MCP tools (SendMessage etc.).",
    "Tool permissions: the CLI allows a fixed tool list (cli.ts CLI_ALLOWED_TOOLS, acceptEdits) and denies the rest silently; the Bot's reviewer decides per command and may raise an approval card.",
    "The Bot replies through SendMessage; its 'final text' is the concatenation of those messages. The CLI's is the result text.",
    "Usage source: the CLI's own result (modelUsage, summed over models); the Bot's usage.db rows for its id in the task's time window (includes helper-model rows attributed to the Bot).",
    "Model calls = the SDK's num_turns on both sides; the CLI's distinct assistant message ids are noted as a cross-check. The Bot's usage.db rows count 1 per turn and 1 per helper call (each Haiku review), so its figure is turns + reviews, not its model calls (2026-09-21: 38 reported, 78 main-model calls + 35 reviews in the session files).",
    "The Bot's repo is its own ~/code/bench-<nonce>/ledger (bug 231; /workspace/bench-<nonce>/ledger on a box without per-Bot accounts) and its CLI starts in /workspace; the CLI's cwd is the repo.",
    "OrbStack can expose the Mac's files to the box; neither runner is sandboxed from the harness's private dirs. Tool inputs that mention them mark the run leak-suspect.",
    "provider-loop: Synapse's own coding engine (the one a Bot's coding agent runs) on a provider model, on the Mac, in the task's repo. Its gate is the CLI runner's allowlist (declined otherwise, counted as interventions); its usage is what providerFetch metered; OpenAI-style usage reports no cache writes.",
  ],
};

export interface BenchOptions {
  runners: RunnerName[];
  taskIds: string[];
  model: string;
  timeoutMs: number;
  dryRun: boolean;
  outDir: string;
  log?: (s: string) => void;
  /** Per-task weighted-token budget on both runners (metered live); past it the run is stopped and fails. */
  maxWeighted?: number;
  /** Synapse budget poll interval (tests). */
  budgetPollMs?: number;
  /** Dry-run model (default: idleModel). */
  fake?: FakeModel;
  /** Test hooks. */
  cliExec?: ClaudeExec;
  box?: SynapseBox;
  /** provider-loop, real runs: the provider's key (else BENCH_PROVIDER_KEY / <PROVIDER>_API_KEY) and an upstream override (a local model). */
  providerKey?: string;
  providerUpstream?: string;
}

export interface BenchResult {
  meta: { startedAt: string; model: string; runners: RunnerName[]; tasks: string[]; dryRun: boolean; timeoutMs: number; maxWeighted: number | null; startRefs: Record<string, string>; notes: string[] };
  parity: typeof PARITY;
  results: ScoredRun[];
  summaries: RunnerSummary[];
  markdown: string;
  jsonPath: string;
  mdPath: string;
}

type Session = CliSession | SynapseSession | ProviderLoopSession;

async function makeRunner(name: RunnerName, o: BenchOptions, scratch: string): Promise<{ open(dir: string): Promise<Session> }> {
  if (name === "provider-loop") {
    return new ProviderLoopRunner({ model: o.model, timeoutMs: o.timeoutMs, real: !o.dryRun, ...(o.maxWeighted !== undefined ? { maxWeighted: o.maxWeighted } : {}),
      ...(o.fake ? { fake: o.fake } : {}), ...(o.providerKey ? { key: o.providerKey } : {}), ...(o.providerUpstream ? { upstream: o.providerUpstream } : {}) });
  }
  if (name === "cli") {
    return new CliRunner({ exec: o.cliExec ?? (o.dryRun ? fakeClaudeExec(o.fake ?? idleModel, o.model) : realClaudeExec), model: o.model, timeoutMs: o.timeoutMs, real: !o.dryRun, maxWeighted: o.maxWeighted });
  }
  let box = o.box;
  if (!box) {
    if (o.dryRun) box = new FakeBox(o.fake ?? idleModel, o.model);
    else box = new (await import("./gateway-box")).GatewayBox();
  }
  let n = 0;
  // The fake box ends runs and announces usage at once; the real one needs the settle window.
  const quick = !box.real ? { settleMs: 20, usageWaitMs: 200 } : {};
  return new SynapseRunner({ box, model: o.model, timeoutMs: o.timeoutMs, log: o.log, pullDir: (id) => path.join(scratch, `synapse-${id}-${++n}`), maxWeighted: o.maxWeighted, budgetPollMs: o.budgetPollMs, ...quick });
}

/** Runs the selected tasks on each runner, verifies, scores, and writes report.md + results.json. */
export async function runBench(o: BenchOptions): Promise<BenchResult> {
  const log = o.log ?? (() => {});
  if (!o.dryRun && process.env.BENCH_REAL !== "1") throw new Error("refusing a real run: each task spends on the Anthropic API key. Set BENCH_REAL=1 (after approval), or pass --dry-run.");
  const sessions = sessionsFor(o.taskIds);
  const results: ScoredRun[] = [];
  const startRefs: Record<string, string> = {};
  const notes: string[] = [];
  const scratch = tmpDir("run");
  for (const runnerName of o.runners) {
    const runner = await makeRunner(runnerName, o, scratch);
    for (const session of sessions) {
      const local = path.join(scratch, `${runnerName}-${session[0]!.id}`);
      const prepared = prepareTask(session[0]!, local);
      startRefs[session[0]!.id] = prepared.startRef;
      log(`[${runnerName}] session ${session.map((t) => t.id).join("+")} from ${prepared.startTag} ${prepared.startRef.slice(0, 10)}`);
      let s: Session | null = null;
      let startDir = local;
      try {
        s = await runner.open(local);
        for (const task of session) {
          const snap = snapshot(startDir);
          const start = { snap, texts: readTexts(startDir, snap) };
          let run: AgentRun;
          try {
            run = await s.run(task, promptFor(task, s.repoPath));
          } catch (err) {
            run = { taskId: task.id, runner: runnerName, model: o.model, finalDir: startDir, finalText: "", usage: null, costUsd: null, calls: null, wallMs: 0, timedOut: false, error: String(err), interventions: [], notes: [] };
          }
          const verdict = await verifyTask(task, run.finalDir, start);
          const scored = scoreRun(run, verdict);
          results.push(scored);
          log(`[${runnerName}] ${task.id} ${verdict.pass ? "PASS" : "FAIL"}${scored.falseDone ? " (false done)" : ""}${run.error ? ` error: ${run.error.slice(0, 120)}` : ""}`);
          startDir = run.finalDir;
        }
      } catch (err) {
        notes.push(`[${runnerName}] session ${session[0]!.id} aborted: ${String(err)}`);
        log(notes.at(-1)!);
        // Tasks the aborted session never ran still count, as failures.
        for (const task of session.filter((t) => !results.some((r) => r.runner === runnerName && r.taskId === t.id))) {
          const run: AgentRun = { taskId: task.id, runner: runnerName, model: o.model, finalDir: startDir, finalText: "", usage: null, costUsd: null, calls: null, wallMs: 0, timedOut: false, error: `session aborted: ${String(err)}`, interventions: [], notes: [] };
          results.push(scoreRun(run, { taskId: task.id, pass: false, checks: [{ name: "run", pass: false, detail: String(err) }] }));
        }
      } finally {
        if (s) {
          await s.close();
          if ("notes" in s) notes.push(...s.notes.map((n) => `[${runnerName}] ${n}`));
        }
      }
    }
  }
  const summaries = summarize(results);
  const meta = { startedAt: new Date().toISOString(), model: o.model, runners: o.runners, tasks: sessions.flat().map((t) => t.id), dryRun: o.dryRun, timeoutMs: o.timeoutMs, maxWeighted: o.maxWeighted ?? null, startRefs, notes };
  const markdown = renderMarkdown({ meta, parity: PARITY, results, summaries });
  fs.mkdirSync(o.outDir, { recursive: true });
  const jsonPath = path.join(o.outDir, "results.json");
  const mdPath = path.join(o.outDir, "report.md");
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, parity: PARITY, summaries, results }, null, 2) + "\n");
  fs.writeFileSync(mdPath, markdown);
  fs.rmSync(scratch, { recursive: true, force: true });
  return { meta, parity: PARITY, results, summaries, markdown, jsonPath, mdPath };
}
