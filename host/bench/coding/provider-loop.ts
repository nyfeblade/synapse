import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseProviderModelRef, type ProviderId } from "@synapse/shared";
import { ProviderProxy } from "../../auth/provider-proxy";
import { AuthProxy } from "../../auth/proxy";
import { modelTarget } from "../../brain/provider/adapters/index";
import { ProviderSessionStore } from "../../brain/provider/session-store";
import type { CodingGate } from "../../coding/engines/policy";
import { providerLoopEngine } from "../../coding/engines/provider-loop";
import { localShell } from "../../coding/engines/shells";
import type { CodingMessage } from "../../coding/engines/types";
import { setProviderRuntime } from "../../usage/metered-provider";
import { setUsageSink, type MeteredRun } from "../../usage/metered-query";
import { localBotFile } from "../../walls/bot-file";
import { PRIVATE_MARKERS } from "./cli";
import type { FakeModel } from "./fake";
import { weightedInput } from "./score";
import type { Task } from "./suite";
import type { AgentRun, Intervention, Usage } from "./types";

/**
 * PROVIDER-LOOP runner (spec §8 coding bench plan: `synapse --engine provider-loop --provider <id>`): Synapse's own
 * coding engine, run on the Mac against the task's repo, on a provider model (`--model openai:gpt-6.1-sol`). The same
 * engine a Bot's coding agent runs (host/coding/engines/provider-loop.ts): the same tools, prompt, loop guard and
 * metering; only the shell (bash on the Mac, as the CLI runner's) and the gate (the bench's fixed policy) are the bench's.
 *
 * The gate: no human, as for the other runners. A command runs when every part of it starts with a tool the CLI runner
 * allows (cli.ts CLI_ALLOWED_TOOLS: npm, node, git, …); anything else is declined and counted as an intervention.
 *
 * Model calls: a dry run plays the FakeModel through a local fake Chat Completions server (its writes become Read/Write
 * calls, its approvals Bash calls), so nothing is spent. A real run (BENCH_REAL=1) goes through the provider proxy with
 * the key from BENCH_PROVIDER_KEY (or <PROVIDER>_API_KEY), metered by providerFetch, and needs the owner's approval.
 */
export const BENCH_ALLOWED_COMMANDS = ["npm", "npx", "node", "git", "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "sed", "diff", "mkdir", "echo", "pwd", "sort", "cd", "true", "test"];

/** Every part of a command (split on ;, &&, ||, |) starts with an allowed tool (after VAR=value assignments). */
export function benchAllows(command: string): boolean {
  const parts = command.split(/;|&&|\|\||\||\n/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const words = p.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").split(/\s+/);
    return BENCH_ALLOWED_COMMANDS.includes(words[0] ?? "");
  }) && !/[`]|\$\(/.test(command);
}

export interface ProviderLoopRunnerOptions {
  model: string;
  timeoutMs: number;
  real: boolean;
  maxWeighted?: number;
  /** Dry run: the fake model. */
  fake?: FakeModel;
  /** Real run: the provider's key (else BENCH_PROVIDER_KEY / <PROVIDER>_API_KEY) and, for a local model, its upstream. */
  key?: string;
  upstream?: string;
}

type Row = MeteredRun;

/** The FakeModel turn's steps: its writes as Read/Write calls, its approvals as Bash calls. */
function stepsOf(fake: FakeModel, prompt: string, dir: string, resumed: boolean) {
  const t = fake({ prompt, dir, resumed });
  const steps: { name: string; args: Record<string, unknown> }[][] = [];
  for (const [rel, content] of Object.entries(t.writes ?? {})) {
    if (fs.existsSync(path.join(dir, rel))) steps.push([{ name: "Read", args: { file_path: rel } }]);
    steps.push([{ name: "Write", args: { file_path: rel, content } }]);
  }
  for (const c of t.approvals ?? []) steps.push([{ name: "Bash", args: { command: c } }]);
  return { t, steps };
}

/** The dry run's model for a Claude model: a fake Messages API playing FakeModel turns as tool_use blocks. */
async function fakeMessagesProvider(fake: FakeModel, dirOf: () => string): Promise<{ url: string; close(): Promise<void> }> {
  let queue: { name: string; args: Record<string, unknown> }[][] = [];
  let final = "Done.";
  let resumed = false;
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: { role: string; content: { type: string; text?: string }[] }[] };
      const last = body.messages?.at(-1);
      const text = last?.role === "user" ? last.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : "";
      if (text.includes("Task:")) { const s = stepsOf(fake, text, dirOf(), resumed); resumed = true; queue = s.steps; final = s.t.text; }
      const step = queue.shift();
      const ev: string[] = [];
      const send = (type: string, data: Record<string, unknown>) => ev.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: `msg_${++n}`, type: "message", role: "assistant", content: [], usage: { input_tokens: 4, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 1_000, output_tokens: 1 } } });
      (step ?? [null]).forEach((c, i) => {
        if (!c) { send("content_block_start", { index: i, content_block: { type: "text", text: "" } }); send("content_block_delta", { index: i, delta: { type: "text_delta", text: final } }); }
        else { send("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${n}_${i}`, name: c.name, input: {} } }); send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) } }); }
        send("content_block_stop", { index: i });
      });
      send("message_delta", { delta: { stop_reason: step ? "tool_use" : "end_turn" }, usage: { output_tokens: 60 } });
      send("message_stop", {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ev.join(""));
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}

/** The dry run's model: a fake Chat Completions server playing FakeModel turns as tool calls. */
async function fakeProvider(fake: FakeModel, dirOf: () => string): Promise<{ url: string; close(): Promise<void> }> {
  let queue: unknown[][] = [];
  let resumed = false;
  let hang = false;
  let n = 0;
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: { role: string; content: unknown }[] };
      const last = body.messages?.at(-1);
      if (last?.role === "user" && typeof last.content === "string" && last.content.includes("Task:")) {
        const dir = dirOf();
        const t = fake({ prompt: last.content, dir, resumed });
        resumed = true;
        hang = t.hang === true;
        const steps: { name: string; args: Record<string, unknown> }[][] = [];
        for (const [rel, content] of Object.entries(t.writes ?? {})) {
          if (fs.existsSync(path.join(dir, rel))) steps.push([{ name: "Read", args: { file_path: rel } }]);
          steps.push([{ name: "Write", args: { file_path: rel, content } }]);
        }
        for (const c of t.approvals ?? []) steps.push([{ name: "Bash", args: { command: c } }]);
        const u = t.usage ?? { fresh: 4, cacheRead: 60_000, cacheWrite: 20_000, output: 900 };
        const k = steps.length + 1; // the model calls this turn makes; its usage is spread over them
        const usage = (i: number) => ({ prompt_tokens: Math.round((u.fresh + u.cacheRead + u.cacheWrite) / k), completion_tokens: Math.round(u.output / k), total_tokens: 0, prompt_tokens_details: { cached_tokens: Math.round(u.cacheRead / k) }, _i: i });
        queue = steps.map((s, i) => [
          ...s.map((c, j) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: j, id: `call_${++n}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })),
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, { choices: [], usage: usage(i) },
        ]);
        queue.push([{ choices: [{ index: 0, delta: { content: t.text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, { choices: [], usage: usage(steps.length) }]);
      }
      if (hang) return; // never answers: the time limit ends it
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([...(queue.shift() ?? [{ choices: [{ index: 0, delta: { content: "Done." } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]).map(frame), "data: [DONE]\n\n"].join(""));
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}

export class ProviderLoopSession {
  private sid: string | undefined;
  constructor(readonly repoPath: string, private o: ProviderLoopRunnerOptions, private rt: { stop(): Promise<void> }, private scratch: string) {}

  async run(task: Task, prompt: string): Promise<AgentRun> {
    if (task.after && !this.sid) throw new Error(`${task.id} needs the session of ${task.after}, which has no session id`);
    const t0 = Date.now();
    const rows: Row[] = [];
    const interventions: Intervention[] = [];
    let leak = false;
    let budgetExceeded = false;
    const gate: CodingGate = async (_b, call) => {
      const command = String(call.input.command ?? "");
      if (benchAllows(command)) return { behavior: "allow" };
      interventions.push({ kind: "permission-denied", detail: command.slice(0, 160), action: "declined" });
      return { behavior: "deny", message: "Declined: nobody approves other commands during the bench." };
    };
    const hostPrivate = path.join(this.scratch, "host-private");
    fs.mkdirSync(hostPrivate, { recursive: true, mode: 0o700 });
    const engine = providerLoopEngine({
      hostPrivate, gate, files: localBotFile({ deny: [hostPrivate] }), shell: localShell(), store: new ProviderSessionStore(hostPrivate, Date.now),
    });
    let child: ReturnType<typeof engine.start> | null = null;
    setUsageSink({
      record: (r) => {
        rows.push(r);
        if (this.o.maxWeighted !== undefined && !budgetExceeded && rows.reduce((a, x) => a + weightedInput(usageOf(x)), 0) > this.o.maxWeighted) { budgetExceeded = true; child?.close(); }
      },
      lastTotals: () => null, noteTotals: () => {},
    });
    child = engine.start({ botId: "bench", agentId: `bench-${task.id}`, cwd: this.repoPath, model: this.o.model, prompt: `Task:\n${prompt}`, ...(this.sid ? { resumeSessionId: this.sid } : {}) });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child?.close(); }, this.o.timeoutMs);
    const messages: CodingMessage[] = [];
    try {
      for await (const m of child.messages) {
        messages.push(m);
        if (m.type === "progress" && m.step === "tool" && PRIVATE_MARKERS.some((x) => JSON.stringify(m.input ?? {}).includes(x))) leak = true;
        if (m.type === "result") break;
      }
    } finally {
      clearTimeout(timer);
      this.sid = child.sessionId?.() ?? this.sid;
      child.close();
      setUsageSink(null);
    }
    const result = messages.find((m) => m.type === "result");
    const usage: Usage | null = rows.length ? rows.map(usageOf).reduce((a, u) => ({ fresh: a.fresh + u.fresh, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, output: a.output + u.output })) : null;
    return {
      taskId: task.id, runner: "provider-loop", model: this.o.model,
      finalDir: this.repoPath, finalText: String(result?.result ?? ""),
      usage, costUsd: rows.length ? Math.round(rows.reduce((a, r) => a + (r.usage.costUsd ?? 0), 0) * 1e6) / 1e6 : null, calls: rows.length,
      wallMs: Date.now() - t0, timedOut,
      error: budgetExceeded ? `budget exceeded: over ${this.o.maxWeighted} weighted tokens` : timedOut ? "time limit" : result?.subtype === "error" ? String(result.result).slice(0, 300) : !result ? "the agent ended without a report" : undefined,
      interventions, leakSuspect: leak, ...(this.sid ? { sessionId: this.sid } : {}),
      ...(budgetExceeded ? { budgetExceeded } : {}),
      notes: [this.o.real ? `provider-loop on ${this.o.model}` : "dry run: fake model", `model calls metered: ${rows.length}`],
    };
  }

  async close(): Promise<void> {
    await this.rt.stop();
  }
}

function usageOf(r: Row): Usage {
  return { fresh: r.usage.inputTokens, cacheRead: r.usage.cacheReadTokens, cacheWrite: r.usage.cacheWriteTokens, output: r.usage.outputTokens };
}

export class ProviderLoopRunner {
  readonly name = "provider-loop" as const;
  constructor(private o: ProviderLoopRunnerOptions) {
    if (o.real && process.env.BENCH_REAL !== "1") throw new Error("refusing a real provider-loop run: it spends on the provider's key. Set BENCH_REAL=1 to run for real.");
    // 0.1.8: a Claude model too (claude-sonnet-5-5): Synapse's own engine on the Messages API, for the same-model
    // comparison with the cli runner (the coding token gap).
    if (!parseProviderModelRef(o.model) && modelTarget(o.model)?.provider !== "anthropic") throw new Error(`--runner provider-loop needs a provider model (like openai:gpt-6.1-sol) or a Claude model (like claude-sonnet-5-5), not ${o.model}`);
  }

  async open(localDir: string): Promise<ProviderLoopSession> {
    if (modelTarget(this.o.model)?.provider === "anthropic") return this.openClaude(localDir);
    const provider = parseProviderModelRef(this.o.model)!.provider;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-provider-loop-"));
    let upstream = this.o.upstream;
    let fake: { close(): Promise<void> } | null = null;
    if (!this.o.real) {
      const f = await fakeProvider(this.o.fake ?? (() => ({ text: "Done. All tests pass." })), () => localDir);
      upstream = f.url;
      fake = f;
    }
    const key = this.o.real ? this.o.key ?? process.env.BENCH_PROVIDER_KEY ?? process.env[`${provider.toUpperCase()}_API_KEY`] ?? null : "sk-bench-dry-run";
    if (this.o.real && !key && provider !== "ollama" && provider !== "lmstudio") throw new Error(`no key for ${provider}: set BENCH_PROVIDER_KEY or ${provider.toUpperCase()}_API_KEY`);
    const proxy = new ProviderProxy({ credential: () => key, ...(upstream ? { upstream: () => upstream } : {}) });
    await proxy.start();
    setProviderRuntime({ proxy, allow: () => ({ ok: true, message: null }), consented: (p: ProviderId) => p === provider, hasKey: (p: ProviderId) => p === provider && key !== null });
    return new ProviderLoopSession(localDir, this.o, {
      stop: async () => { setProviderRuntime(null); await proxy.stop(); await fake?.close(); fs.rmSync(scratch, { recursive: true, force: true }); },
    }, scratch);
  }

  /** A Claude model: the engine's calls go through a local auth proxy holding the key (ANTHROPIC_API_KEY on a real run). */
  private async openClaude(localDir: string): Promise<ProviderLoopSession> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-provider-loop-"));
    let upstream = this.o.upstream ?? "https://api.anthropic.com";
    let fake: { close(): Promise<void> } | null = null;
    if (!this.o.real) {
      const f = await fakeMessagesProvider(this.o.fake ?? (() => ({ text: "Done. All tests pass." })), () => localDir);
      upstream = f.url;
      fake = f;
    }
    const key = this.o.real ? this.o.key ?? process.env.ANTHROPIC_API_KEY ?? null : "sk-ant-bench-dry-run";
    if (!key) throw new Error("no Anthropic key: set ANTHROPIC_API_KEY for a real provider-loop run on a Claude model");
    const auth = new AuthProxy({ upstream, port: 0, credential: () => key, unref: true });
    await auth.start();
    setProviderRuntime({
      proxy: null, allow: () => ({ ok: true, message: null }), consented: (p: ProviderId) => p === "anthropic", hasKey: (p: ProviderId) => p === "anthropic",
      anthropic: { get url() { return auth.url; }, issue: (g) => auth.issue(g), revoke: (t, r) => auth.revoke(t, r), hasKey: () => true },
    });
    return new ProviderLoopSession(localDir, this.o, {
      stop: async () => { setProviderRuntime(null); await auth.stop(); await fake?.close(); fs.rmSync(scratch, { recursive: true, force: true }); },
    }, scratch);
  }
}
