import fs from "node:fs";
import path from "node:path";
import type { ClaudeExec } from "./cli";
import { copyTree, linkNodeModules, tmpDir } from "./repo";
import { NONCE_RE, type BoxEvent, type BoxState, type SynapseBox, type UsageRow } from "./synapse";
import type { Usage } from "./types";

/**
 * Dry-run doubles: a fake model both runners drive, a fake `claude` binary and a fake box. They
 * exercise the whole harness (prepare, run, pull, verify, score, report) with no model call.
 */

export interface FakeTurn {
  text: string;
  /** Files to write in the repo, path -> content. */
  writes?: Record<string, string>;
  /** Questions put to the user (a declined intervention on both runners). */
  asks?: string[];
  /** Commands needing approval (CLI: permission denials; Synapse: approval cards). */
  approvals?: string[];
  usage?: Usage;
  calls?: number;
  /** Never finish: the harness's time limit has to end it. */
  hang?: boolean;
}
export type FakeModel = (ctx: { prompt: string; dir: string; resumed: boolean }) => FakeTurn;

export const SYNTHETIC_USAGE: Usage = { fresh: 4, cacheRead: 60_000, cacheWrite: 20_000, output: 900 };

/** The --dry-run default: changes nothing and claims success, so every task scores a false done. */
export const idleModel: FakeModel = () => ({ text: "Done. All tests pass.", usage: SYNTHETIC_USAGE, calls: 3 });

function applyWrites(dir: string, writes: Record<string, string> = {}): void {
  for (const [rel, content] of Object.entries(writes)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeClaudeExec(model: FakeModel, modelId = "fake-model"): ClaudeExec {
  let n = 0;
  return async (args, o) => {
    const t0 = Date.now();
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const ri = args.indexOf("--resume");
    const sid = ri >= 0 ? args[ri + 1]! : `fake-session-${++n}`;
    const turn = model({ prompt, dir: o.cwd, resumed: ri >= 0 });
    const emit = (ev: unknown) => o.onLine(JSON.stringify(ev));
    emit({ type: "system", subtype: "init", session_id: sid, model: modelId });
    if (turn.hang) {
      emit({ type: "assistant", session_id: sid, message: { id: "msg-hang", content: [{ type: "text", text: "Working on it" }], usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 20 } } });
      // Ends at the time limit, or earlier when the runner aborts it (its token budget).
      const aborted = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), o.timeoutMs);
        if (o.signal?.aborted) { clearTimeout(t); r(true); }
        o.signal?.addEventListener("abort", () => { clearTimeout(t); r(true); }, { once: true });
      });
      return { code: null, out: "", timedOut: !aborted, ms: Date.now() - t0 };
    }
    applyWrites(o.cwd, turn.writes);
    for (const [i, q] of (turn.asks ?? []).entries()) {
      emit({ type: "assistant", session_id: sid, message: { id: `msg-ask-${i}`, content: [{ type: "tool_use", id: `tu-${i}`, name: "AskUserQuestion", input: { question: q } }] } });
    }
    const u = turn.usage ?? SYNTHETIC_USAGE;
    emit({ type: "assistant", session_id: sid, message: { id: "msg-final", content: [{ type: "text", text: turn.text }] } });
    emit({
      type: "result", subtype: "success", is_error: false, session_id: sid, result: turn.text, num_turns: turn.calls ?? 1, duration_ms: Date.now() - t0, total_cost_usd: 0,
      modelUsage: { [modelId]: { inputTokens: u.fresh, cacheReadInputTokens: u.cacheRead, cacheCreationInputTokens: u.cacheWrite, outputTokens: u.output } },
      permission_denials: (turn.approvals ?? []).map((c) => ({ tool_name: "Bash", tool_use_id: "x", tool_input: { command: c } })),
    });
    return { code: 0, out: "", timedOut: false, ms: Date.now() - t0 };
  };
}

/** An in-memory gateway + a temp dir standing in for the Bot's home (the repo goes in its ~/code, bug 231). Has one pre-existing user Bot. */
export class FakeBox implements SynapseBox {
  readonly real = false;
  readonly root = tmpDir("fakebox");
  readonly bots = new Map<string, { name: string; engineering: boolean; model: string }>([["user-bot-1", { name: "Research", engineering: false, model: "claude-sonnet-5" }]]);
  readonly calls: { cmd: string; args: Record<string, unknown> }[] = [];
  readonly rows: (UsageRow & { botId: string })[] = [];
  maxScreens: string | null = "MAX_SCREENS=3";
  private listeners = new Set<(ev: BoxEvent) => void>();
  private repo = "";
  private runs = new Map<string, number>();
  private waiters = new Map<string, () => void>();
  private stop = new Map<string, () => void>();
  private n = 0;

  constructor(private model: FakeModel = idleModel, private modelId = "fake-model") {}

  async state(): Promise<BoxState> {
    return { botIds: [...this.bots.keys()], botCount: this.bots.size, maxBots: 50, maxScreens: this.maxScreens, nodeModulesOk: true, nodeModulesPath: "(fake)" };
  }
  async createBot(name: string, model: string): Promise<string> {
    const id = `bot-${++this.n}`;
    this.bots.set(id, { name, engineering: false, model });
    return id;
  }
  async enableEngineering(id: string): Promise<void> {
    this.bots.get(id)!.engineering = true;
  }
  async deleteBot(id: string): Promise<void> {
    const b = this.bots.get(id);
    if (b && !/^bench-[a-z0-9]{8}$/.test(b.name)) throw new Error(`refusing to delete ${b.name}`);
    this.calls.push({ cmd: "deleteBot", args: { id } });
    this.bots.delete(id);
    this.sessions.delete(id); // like the host: deleting a Bot deletes its session file (bug-log 75)
  }
  async pushRepo(localDir: string, nonce: string, _botId: string): Promise<string> {
    if (!NONCE_RE.test(nonce)) throw new Error("bad nonce");
    this.repo = path.join(this.root, "code", `bench-${nonce}`, "ledger");
    copyTree(localDir, this.repo, false);
    linkNodeModules(this.repo);
    return this.repo;
  }
  async pullRepo(nonce: string, localDir: string): Promise<void> {
    copyTree(path.join(this.root, "code", `bench-${nonce}`, "ledger"), localDir, false);
  }
  async removeWorkspace(nonce: string): Promise<void> {
    fs.rmSync(path.join(this.root, "code", `bench-${nonce}`), { recursive: true, force: true });
    try { fs.rmdirSync(path.join(this.root, "code")); } catch { /* another session's repo is still there */ }
  }
  async subscribe(fn: (ev: BoxEvent) => void): Promise<() => void> {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async usage(botId: string, sinceMs: number): Promise<UsageRow[]> {
    return this.rows.filter((r) => r.botId === botId && r.startedAt >= sinceMs);
  }
  /** The Bot's session file, as the CLI writes it: one assistant line per model call, usage on each. */
  readonly sessions = new Map<string, string[]>();
  async transcript(botId: string): Promise<string | null> {
    this.calls.push({ cmd: "transcript", args: { id: botId } });
    const lines = this.sessions.get(botId);
    return lines ? lines.join("\n") + "\n" : null;
  }
  private writeCalls(id: string, n: number, u: Usage): void {
    const lines = this.sessions.get(id) ?? [];
    const k = Math.max(1, n);
    for (let i = 0; i < k; i++) {
      const usage = { input_tokens: Math.round(u.fresh / k), cache_read_input_tokens: Math.round(u.cacheRead / k), cache_creation_input_tokens: Math.round(u.cacheWrite / k), output_tokens: Math.round(u.output / k) };
      const tool = i === k - 1 ? "mcp__bot__SendMessage" : "Bash";
      lines.push(JSON.stringify({ type: "assistant", message: { id: `msg-${id}-${lines.length}`, usage, content: [{ type: "tool_use", id: `tu-${lines.length}`, name: tool, input: {} }] } }));
    }
    this.sessions.set(id, lines);
  }

  private emit(channel: string, payload: unknown): void {
    for (const l of [...this.listeners]) l({ channel, payload });
  }
  private upsert(id: string, running: boolean): void {
    this.emit("agent-upserted", { agent: { id, name: this.bots.get(id)?.name, running, awaiting: null } });
  }
  private waitFor(key: string): Promise<void> {
    return new Promise((r) => { this.waiters.set(key, r); setTimeout(r, 2_000); });
  }

  async call(cmd: string, args: Record<string, any>): Promise<any> {
    this.calls.push({ cmd, args });
    if (cmd === "sendPrompt") { void this.simulate(args.id as string, args.text as string); return { entryId: `e-${++this.n}` }; }
    if (cmd === "dismissWidget") { this.waiters.get(`w:${args.entryId}`)?.(); return { status: "dismissed" }; }
    if (cmd === "resolveAutoReviewApproval") { this.waiters.get(`a:${args.approvalId}`)?.(); return { status: "denied" }; }
    if (cmd === "interruptAgent") { this.stop.get(args.id as string)?.(); return {}; }
    return {};
  }

  private async simulate(id: string, text: string): Promise<void> {
    const t0 = Date.now();
    const resumed = (this.runs.get(id) ?? 0) > 0;
    this.runs.set(id, (this.runs.get(id) ?? 0) + 1);
    await sleep(5);
    this.upsert(id, true);
    const turn = this.model({ prompt: text, dir: this.repo, resumed });
    if (turn.hang) {
      this.writeCalls(id, 1, { fresh: 4, cacheRead: 1000, cacheWrite: 500, output: 20 });
      await new Promise<void>((r) => this.stop.set(id, r));
      this.upsert(id, false);
      return;
    }
    applyWrites(this.repo, turn.writes);
    for (const [i, q] of (turn.asks ?? []).entries()) {
      const entryId = `w-${id}-${i}`;
      this.emit("transcript", { botId: id, op: "append", entry: { kind: "send-message", id: entryId, status: "pending", message: { type: "widget", widget: { question: q, options: [] } } } });
      await this.waitFor(`w:${entryId}`);
    }
    for (const [i, c] of (turn.approvals ?? []).entries()) {
      const approvalId = `ap-${id}-${i}`;
      this.emit("transcript", { botId: id, op: "append", entry: { kind: "send-message", id: `e-${approvalId}`, message: { type: "auto-review-approval", approval: { approvalId, status: "pending", command: c } } } });
      await this.waitFor(`a:${approvalId}`);
    }
    this.emit("transcript", { botId: id, op: "append", entry: { kind: "send-message", id: `t-${++this.n}`, message: { type: "text", content: turn.text } } });
    const u = turn.usage ?? SYNTHETIC_USAGE;
    this.writeCalls(id, turn.calls ?? 1, u);
    this.rows.push({ botId: id, model: this.modelId, startedAt: t0, inputTokens: u.fresh, outputTokens: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: 0, numTurns: turn.calls ?? 1, status: "success", purpose: "turn" });
    this.upsert(id, false);
    this.emit("usage", {});
  }
}
