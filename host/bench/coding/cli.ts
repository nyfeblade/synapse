import { DEFAULT_EFFORT } from "@synapse/shared";
import { run, type ProcResult } from "./repo";
import type { Task } from "./suite";
import { weightedInput } from "./score";
import { traceOf } from "./trace";
import type { AgentRun, Intervention, Usage } from "./types";
import { explicitKeyEnv } from "../../auth/dev-auth";
import { runClaudeCli } from "../../claude/spawn";

/**
 * CLI runner: headless Claude Code (`claude -p`, stream-json) in a temp copy of the sample repo on
 * the Mac. A session is one directory and one Claude session id; a follow-up task resumes it.
 */

export type ClaudeExec = (args: string[], o: { cwd: string; timeoutMs: number; onLine: (l: string) => void; signal?: AbortSignal }) => Promise<ProcResult>;

/**
 * Review round 2 (S3): the baseline `claude` runs on an explicit API key (SYNAPSE_API_KEY / ANTHROPIC_API_KEY), the same
 * sign-in the Synapse arm uses, never the developer's own Claude login; with no key it fails fast (dead sentinel).
 */
export function claudeEnvForBench(base: Record<string, string | undefined> = process.env): Record<string, string> {
  return explicitKeyEnv(base);
}

/** The real binary (`CLAUDE_BIN` overrides the path), started through the one claude spawn helper (review round 3, S6). */
export const realClaudeExec: ClaudeExec = (args, o) =>
  runClaudeCli(args, { env: claudeEnvForBench(), bin: process.env.CLAUDE_BIN }, (cmd, a, env) => run(cmd, a, { cwd: o.cwd, env, timeoutMs: o.timeoutMs, onLine: o.onLine, input: "", signal: o.signal }));

/**
 * Live weighted-token meter over Claude Code event lines (stream-json or a session JSONL): one usage per
 * assistant message id (a message's usage repeats on each of its lines; the last one seen wins).
 */
export class LiveMeter {
  private per = new Map<string, Usage>();
  constructor(private skip: ReadonlySet<string> = new Set()) {}
  add(line: string): number {
    if (line.includes("\"assistant\"")) {
      try {
        const ev = JSON.parse(line) as { type?: string; message?: { id?: string; usage?: Record<string, number> } };
        const m = ev.message;
        if (ev.type === "assistant" && m?.id && m.usage && !this.skip.has(m.id)) this.per.set(m.id, usageOf(m.usage));
      } catch { /* a partial line */ }
    }
    return this.weighted();
  }
  weighted(): number {
    let w = 0;
    for (const u of this.per.values()) w += weightedInput(u);
    return w;
  }
}

/**
 * Tools the headless run may use without asking. Everything else is denied by -p (no human), and
 * each denial is recorded as a declined intervention, the same policy as a declined approval card
 * on Synapse. Edits are auto-accepted inside the repo (acceptEdits).
 */
export const CLI_ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(git:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(wc:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(diff:*)", "Bash(mkdir:*)", "Bash(echo:*)",
  "Bash(pwd)", "Bash(sort:*)",
];

export function claudeArgs(prompt: string, model: string, resume?: string): string[] {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    // Bug 171: the same effort the Bot runs at, so neither side thinks harder by default.
    "--effort", DEFAULT_EFFORT,
    "--permission-mode", "acceptEdits",
    "--allowedTools", CLI_ALLOWED_TOOLS.join(","),
    // No user MCP servers, settings or CLAUDE.md: the run sees only the repo, like a fresh Bot.
    "--strict-mcp-config",
    "--setting-sources", "project",
    ...(resume ? ["--resume", resume] : []),
  ];
}

/** Paths the agent must never touch. Seeing one in a tool input marks the run leak-suspect. */
export const PRIVATE_MARKERS = ["reference-solutions", "bench/coding/tasks", ".bench-hidden"];

const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export interface ParsedStream {
  sessionId?: string;
  finalText: string;
  usage: Usage | null;
  usageSource: "result" | "messages" | "none";
  costUsd: number | null;
  calls: number | null;
  messageIds: number;
  interventions: Intervention[];
  isError: boolean;
  leakSuspect: boolean;
  models: string[];
}

type Json = Record<string, any>;

/** Reads a `claude -p --output-format stream-json --verbose` transcript. */
export function parseClaudeStream(lines: string[]): ParsedStream {
  const ids = new Set<string>();
  const perMessage = new Map<string, Usage>();
  const interventions: Intervention[] = [];
  let sessionId: string | undefined, result: Json | undefined, lastText = "", leak = false;
  for (const line of lines) {
    let ev: Json;
    try { ev = JSON.parse(line) as Json; } catch { continue; }
    if (ev.session_id && !sessionId) sessionId = String(ev.session_id);
    if (ev.type === "assistant" && ev.message) {
      const m = ev.message as Json;
      if (m.id) ids.add(String(m.id));
      if (m.id && m.usage) perMessage.set(String(m.id), usageOf(m.usage));
      const texts: string[] = [];
      for (const c of (m.content ?? []) as Json[]) {
        if (c.type === "text" && !ev.parent_tool_use_id) texts.push(String(c.text));
        if (c.type === "tool_use") {
          const input = JSON.stringify(c.input ?? {});
          if (PRIVATE_MARKERS.some((p) => input.includes(p))) leak = true;
          if (ASK_TOOLS.has(String(c.name))) interventions.push({ kind: "question", detail: `${c.name}: ${input.slice(0, 160)}`, action: "declined" });
        }
      }
      if (texts.length) lastText = texts.join("\n");
    }
    if (ev.type === "result") result = ev;
  }
  for (const d of (result?.permission_denials ?? []) as Json[]) {
    if (ASK_TOOLS.has(String(d.tool_name))) continue; // already counted as a question
    interventions.push({ kind: "permission-denied", detail: `${d.tool_name}: ${JSON.stringify(d.tool_input ?? {}).slice(0, 160)}`, action: "declined" });
  }
  let usage: Usage | null = null, usageSource: ParsedStream["usageSource"] = "none";
  const models: string[] = [];
  if (result?.modelUsage && Object.keys(result.modelUsage).length) {
    usage = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const [model, mu] of Object.entries(result.modelUsage as Record<string, Json>)) {
      models.push(model);
      usage.fresh += mu.inputTokens ?? 0;
      usage.cacheRead += mu.cacheReadInputTokens ?? 0;
      usage.cacheWrite += mu.cacheCreationInputTokens ?? 0;
      usage.output += mu.outputTokens ?? 0;
    }
    usageSource = "result";
  } else if (result?.usage) {
    usage = usageOf(result.usage);
    usageSource = "result";
  } else if (perMessage.size) {
    // Killed before its result: the per-call usages it streamed are a lower bound.
    usage = [...perMessage.values()].reduce((a, u) => ({ fresh: a.fresh + u.fresh, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, output: a.output + u.output }));
    usageSource = "messages";
  }
  return {
    sessionId,
    finalText: typeof result?.result === "string" ? result.result : lastText,
    usage,
    usageSource,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    calls: typeof result?.num_turns === "number" ? result.num_turns : null,
    messageIds: ids.size,
    interventions,
    isError: result ? Boolean(result.is_error) : true,
    leakSuspect: leak,
    models,
  };
}

function usageOf(u: Json): Usage {
  return { fresh: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

export interface CliRunnerOptions {
  exec: ClaudeExec; model: string; timeoutMs: number; real: boolean;
  /** Per-task weighted-token budget, metered live from the streamed per-call usage; past it the process is killed. */
  maxWeighted?: number;
}

export class CliSession {
  private sessionId?: string;
  constructor(readonly repoPath: string, private o: CliRunnerOptions) {}

  async run(task: Task, prompt: string): Promise<AgentRun> {
    const lines: string[] = [];
    const args = claudeArgs(prompt, this.o.model, task.after ? this.sessionId : undefined);
    if (task.after && !this.sessionId) throw new Error(`${task.id} needs the session of ${task.after}, which has no session id`);
    const ac = new AbortController();
    const meter = new LiveMeter();
    let budgetExceeded = false;
    const onLine = (l: string) => {
      lines.push(l);
      if (this.o.maxWeighted === undefined || budgetExceeded) return;
      if (meter.add(l) > this.o.maxWeighted) { budgetExceeded = true; ac.abort(); }
    };
    const r = await this.o.exec(args, { cwd: this.repoPath, timeoutMs: this.o.timeoutMs, onLine, signal: ac.signal });
    const p = parseClaudeStream(lines);
    const { ids: _ids, ...trace } = traceOf(lines);
    this.sessionId = p.sessionId ?? this.sessionId;
    const notes = [`usage from ${p.usageSource}`, `assistant message ids: ${p.messageIds}`];
    if (p.models.length) notes.push(`models: ${p.models.join(", ")}`);
    if (!this.o.real) notes.push("dry run: fake model");
    return {
      taskId: task.id, runner: "cli", model: this.o.model,
      finalDir: this.repoPath, finalText: p.finalText,
      usage: p.usage, costUsd: p.costUsd, calls: p.calls,
      wallMs: r.ms, timedOut: r.timedOut,
      error: budgetExceeded ? `budget exceeded: over ${this.o.maxWeighted} weighted tokens` : r.timedOut ? "time limit" : r.code !== 0 || p.isError ? `claude exited ${r.code}${p.isError ? " (result is_error)" : ""}: ${r.out.slice(-300)}` : undefined,
      interventions: p.interventions, sessionId: p.sessionId, leakSuspect: p.leakSuspect, notes,
      ...(budgetExceeded ? { budgetExceeded } : {}), ...(trace.calls ? { trace } : {}),
    };
  }

  async close(): Promise<void> {}
}

export class CliRunner {
  readonly name = "cli" as const;
  constructor(private o: CliRunnerOptions) {
    if (o.real && process.env.BENCH_REAL !== "1") throw new Error("refusing a real CLI run: it spends on the Anthropic API key. Set BENCH_REAL=1 to run for real.");
  }
  async open(localDir: string): Promise<CliSession> {
    return new CliSession(localDir, this.o);
  }
}
