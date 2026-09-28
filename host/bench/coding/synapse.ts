import crypto from "node:crypto";
import { LiveMeter, PRIVATE_MARKERS } from "./cli";
import { weightedInput } from "./score";
import { traceOf, type RunTrace } from "./trace";
import type { Task } from "./suite";
import type { AgentRun, Intervention, Usage } from "./types";

/**
 * SYNAPSE runner: an engineering-mode Bot named `bench-<nonce>` on the box, driven through the
 * gateway. The repo goes into the Bot's ~/code/bench-<nonce>/ledger (/workspace/bench-<nonce> without per-Bot accounts), the task is sent as a user message,
 * the run's end is read off the SSE stream (agent-upserted running true -> false; never polled),
 * the repo comes back to the Mac for hidden verification, and usage comes from usage.db (read-only).
 * The Bot and its workspace are removed in `close()`, which the harness calls in `finally`.
 */

export interface BoxEvent { channel: string; payload: any }
export interface UsageRow { model: string; startedAt: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; numTurns: number; status: string; purpose?: string | null }
export interface BoxState { botIds: string[]; botCount: number; maxBots: number; maxScreens: string | null; nodeModulesOk: boolean; nodeModulesPath: string }

/** Everything the runner needs from the box. GatewayBox is the real one, FakeBox the dry-run one. */
export interface SynapseBox {
  readonly real: boolean;
  state(): Promise<BoxState>;
  createBot(name: string, model: string): Promise<string>;
  enableEngineering(id: string): Promise<void>;
  deleteBot(id: string): Promise<void>;
  /** Copies the repo (no node_modules) to the Bot's ~/code/bench-<nonce>/ledger (else /workspace/bench-<nonce>/ledger) with the box's node_modules. Returns the remote repo path. */
  pushRepo(localDir: string, nonce: string, botId: string): Promise<string>;
  pullRepo(nonce: string, localDir: string): Promise<void>;
  removeWorkspace(nonce: string): Promise<void>;
  subscribe(fn: (ev: BoxEvent) => void): Promise<() => void>;
  call(cmd: string, args: Record<string, unknown>): Promise<any>;
  usage(botId: string, sinceMs: number): Promise<UsageRow[]>;
  /** The Bot's current Claude Code session file (.jsonl text), or null. Read before the Bot is deleted (bug-log 75). */
  transcript(botId: string): Promise<string | null>;
}

export const NONCE_RE = /^[a-z0-9]{8}$/;
export const newNonce = () => crypto.randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 8);
export const benchBotName = (nonce: string) => `bench-${nonce}`;

export interface SynapseOptions {
  box: SynapseBox;
  model: string;
  timeoutMs: number;
  /** After running goes false, wait this long for it to come back before calling the run done. */
  settleMs?: number;
  /** How long to wait for the usage SSE event after a run, before reading usage.db anyway. */
  usageWaitMs?: number;
  /** Where pulled repo states go on the Mac. */
  pullDir: (taskId: string) => string;
  /**
   * Per-task weighted-token budget. usage.db gets a turn's row only when the turn ends, so the live meter
   * reads the Bot's session file (per-call usage) plus the usage.db rows already written (its reviews).
   */
  maxWeighted?: number;
  /** How often the budget is checked (default 15 s). */
  budgetPollMs?: number;
  log?: (s: string) => void;
}

export class SynapseRunner {
  readonly name = "synapse" as const;
  constructor(private o: SynapseOptions) {
    if (o.box.real && process.env.BENCH_REAL !== "1") throw new Error("refusing a real Synapse run: it spends on the Anthropic API key. Set BENCH_REAL=1 to run for real.");
  }

  /** Preflight, create the Bot, turn engineering mode on, push the repo. */
  async open(localDir: string): Promise<SynapseSession> {
    const box = this.o.box;
    const before = await box.state();
    if (!before.nodeModulesOk) throw new Error(`box has no vitest/typescript at ${before.nodeModulesPath} (set BENCH_BOX_NODE_MODULES)`);
    if (before.botCount >= before.maxBots) throw new Error(`box is at its Bot limit (${before.maxBots})`);
    const nonce = newNonce();
    const s = new SynapseSession(this.o, nonce, before);
    try {
      s.botId = await box.createBot(benchBotName(nonce), this.o.model);
      if (before.botIds.includes(s.botId)) throw new Error(`createBot returned an existing Bot id ${s.botId}`);
      await box.enableEngineering(s.botId);
      s.repoPath = await box.pushRepo(localDir, nonce, s.botId);
      s.unsubscribe = await box.subscribe((ev) => s.onEvent(ev));
    } catch (err) {
      await s.close();
      throw err;
    }
    return s;
  }
}

type Waiter = { resolve: () => void };

export class SynapseSession {
  botId = "";
  repoPath = "";
  unsubscribe: (() => void) | null = null;
  readonly notes: string[] = [];
  private listeners = new Set<(ev: BoxEvent) => void>();
  /** Model-call ids of this session's earlier tasks: a follow-up's trace and budget count only its own. */
  private seenIds = new Set<string>();

  constructor(private o: SynapseOptions, readonly nonce: string, readonly before: BoxState) {}

  onEvent(ev: BoxEvent): void {
    for (const l of [...this.listeners]) l(ev);
  }

  async run(task: Task, prompt: string): Promise<AgentRun> {
    const box = this.o.box;
    const id = this.botId;
    const t0 = Date.now();
    const texts: string[] = [];
    const interventions: Intervention[] = [];
    const handled = new Set<string>();
    const pending: Promise<unknown>[] = [];
    let leak = false, sawRunning = false, sawUsage = false, timedOut = false, error: string | undefined;
    let settle: NodeJS.Timeout | null = null;
    const done: Waiter = { resolve: () => {} };
    const finished = new Promise<void>((r) => (done.resolve = r));
    const act = (key: string, iv: Intervention, fn: () => Promise<unknown>) => {
      if (handled.has(key)) return;
      handled.add(key);
      interventions.push(iv);
      pending.push(fn().catch((e) => this.notes.push(`${task.id}: ${iv.kind} ${iv.action} failed: ${String(e)}`)));
    };

    const listener = (ev: BoxEvent) => {
      const p = ev.payload ?? {};
      if (ev.channel === "usage" && sawRunning) sawUsage = true;
      if (ev.channel === "agent-upserted" && p.agent?.id === id) {
        if (p.agent.running) {
          sawRunning = true;
          if (settle) { clearTimeout(settle); settle = null; }
        } else if (sawRunning && !settle) {
          settle = setTimeout(done.resolve, this.o.settleMs ?? 3_000);
        }
        const aw = p.agent.awaiting;
        if (aw && aw.tabId !== "widget" && aw.tabId !== "auto-review") {
          // Waiting on something we cannot decline (a secret, the box): end the run.
          act(`await:${aw.tabId}:${aw.since}`, { kind: "awaiting", detail: `${aw.tabId}: ${aw.reason ?? ""}`, action: "interrupted" }, () => box.call("interruptAgent", { id }));
        }
      }
      if (ev.channel === "transcript" && p.botId === id && p.entry) {
        const e = p.entry;
        if (e.kind === "tool-call") {
          if (PRIVATE_MARKERS.some((m) => String(e.step ?? "").includes(m))) leak = true;
          if (/computer|screen/i.test(String(e.name ?? ""))) this.notes.push(`${task.id}: Bot used ${e.name} (may take a MAX_SCREENS seat)`);
        }
        if (e.kind !== "send-message" || !e.message) return;
        const m = e.message;
        if (m.type === "text" && p.op === "append") texts.push(String(m.content ?? ""));
        else if (m.type === "widget" && e.status === "pending") {
          act(`w:${e.id}`, { kind: "question", detail: String(m.widget?.question ?? "").slice(0, 160), action: "declined" }, () => box.call("dismissWidget", { id, entryId: e.id }));
        } else if (m.type === "auto-review-approval" && m.approval?.status === "pending") {
          act(`a:${m.approval.approvalId}`, { kind: "approval", detail: String(m.approval.command ?? "").slice(0, 160), action: "declined" }, () =>
            box.call("resolveAutoReviewApproval", { id, approvalId: m.approval.approvalId, choice: "deny" }));
        } else if (m.type === "card" && m.card) {
          const c = m.card;
          if (c.kind === "local-tool-permission" && c.status === "pending") {
            act(`l:${c.askId}`, { kind: "approval", detail: `${c.action} ${c.target}`, action: "declined" }, () => box.call("resolveLocalToolPermission", { id, askId: c.askId, choice: "deny" }));
          } else if (c.kind === "form" && (e.status ?? "pending") === "pending") {
            act(`f:${e.id}`, { kind: "form", detail: String(c.title ?? ""), action: "declined" }, () => box.call("dismissWidget", { id, entryId: e.id }));
          } else if (p.op === "append") {
            act(`c:${e.id}`, { kind: "card", detail: String(c.kind), action: "skipped" }, async () => {});
          }
        }
      }
    };

    this.listeners.add(listener);
    const timer = setTimeout(() => {
      timedOut = true;
      pending.push(box.call("interruptAgent", { id }).catch(() => {}));
      done.resolve();
    }, this.o.timeoutMs);
    let budgetExceeded = false;
    const cap = this.o.maxWeighted;
    const poll = cap === undefined ? null : setInterval(() => {
      void (async () => {
        if (budgetExceeded || timedOut) return;
        const w = await this.spent(id, t0).catch(() => 0);
        if (w <= cap || budgetExceeded || timedOut) return;
        budgetExceeded = true;
        this.notes.push(`${task.id}: budget exceeded (${Math.round(w)} weighted tokens > ${cap}); Bot interrupted`);
        pending.push(box.call("interruptAgent", { id }).catch(() => {}));
        done.resolve();
      })();
    }, this.o.budgetPollMs ?? 15_000);
    try {
      await box.call("sendPrompt", { id, text: prompt, clientNonce: `bench-${this.nonce}-${task.id}` });
      await finished;
    } catch (err) {
      error = String(err);
    } finally {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (settle) clearTimeout(settle);
      this.listeners.delete(listener);
      await Promise.all(pending);
    }
    const wallMs = Date.now() - t0;

    // usage.db is written when the run ends; the gateway announces it on the `usage` channel.
    const usageSeen = new Promise<void>((resolve) => {
      if (sawUsage) return resolve();
      const t = setTimeout(resolve, this.o.usageWaitMs ?? 10_000);
      const l = (ev: BoxEvent) => { if (ev.channel === "usage") { clearTimeout(t); this.listeners.delete(l); resolve(); } };
      this.listeners.add(l);
    });
    await usageSeen;
    let usage: Usage | null = null, calls: number | null = null, costUsd: number | null = null;
    try {
      const rows = await box.usage(id, t0 - 1_000);
      if (rows.length) {
        usage = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        calls = 0; costUsd = 0;
        for (const r of rows) {
          usage.fresh += r.inputTokens; usage.cacheRead += r.cacheRead; usage.cacheWrite += r.cacheWrite; usage.output += r.outputTokens;
          calls += r.numTurns; costUsd += r.costUsd;
        }
        // By purpose (turn, review, …): a Bot's helper-model rows (the Haiku reviewer) are in these totals too.
        const byPurpose = new Map<string, number>();
        for (const r of rows) byPurpose.set(r.purpose || "other", (byPurpose.get(r.purpose || "other") ?? 0) + 1);
        const split = [...byPurpose].map(([p, n]) => `${p} ${n}`).join(", ");
        this.notes.push(`${task.id}: ${rows.length} usage.db run(s) (${split}), models ${[...new Set(rows.map((r) => r.model))].join(", ")}`);
      }
    } catch (err) {
      this.notes.push(`${task.id}: usage read failed: ${String(err)}`);
    }

    // Bug-log 75: the per-call trace, read now (deleting the Bot deletes its session file).
    let trace: RunTrace | undefined;
    try {
      const jsonl = await box.transcript(id);
      if (jsonl) {
        const { ids, ...t } = traceOf(jsonl.split("\n"), this.seenIds);
        for (const x of ids) this.seenIds.add(x);
        if (t.calls) trace = t;
      } else this.notes.push(`${task.id}: no session file to trace`);
    } catch (err) {
      this.notes.push(`${task.id}: trace read failed: ${String(err)}`);
    }

    const local = this.o.pullDir(task.id);
    await box.pullRepo(this.nonce, local);
    return {
      taskId: task.id, runner: "synapse", model: this.o.model,
      finalDir: local, finalText: texts.join("\n"),
      usage, costUsd, calls, wallMs, timedOut,
      error: error ?? (budgetExceeded ? `budget exceeded: over ${this.o.maxWeighted} weighted tokens` : timedOut ? "time limit" : undefined),
      interventions, leakSuspect: leak,
      ...(budgetExceeded ? { budgetExceeded } : {}), ...(trace ? { trace } : {}),
      notes: box.real ? [] : ["dry run: fake box"],
    };
  }

  /** Weighted tokens this task has spent so far: its model calls in the session file + usage.db rows already written (reviews). */
  private async spent(id: string, t0: number): Promise<number> {
    const box = this.o.box;
    const meter = new LiveMeter(this.seenIds);
    for (const line of ((await box.transcript(id)) ?? "").split("\n")) meter.add(line);
    const rows = (await box.usage(id, t0 - 1_000)).filter((r) => r.purpose !== "turn");
    return meter.weighted() + rows.reduce((a, r) => a + weightedInput({ fresh: r.inputTokens, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.outputTokens }), 0);
  }

  /** Always safe to call: removes only the Bot and workspace this session made, then re-checks the box. */
  async close(): Promise<void> {
    const box = this.o.box;
    this.unsubscribe?.();
    if (this.botId) {
      try { await box.deleteBot(this.botId); } catch (e) { this.notes.push(`deleteBot ${this.botId} failed: ${String(e)}`); }
    }
    if (NONCE_RE.test(this.nonce)) {
      try { await box.removeWorkspace(this.nonce); } catch (e) { this.notes.push(`workspace cleanup failed: ${String(e)}`); }
    }
    try {
      const after = await box.state();
      const lost = this.before.botIds.filter((b) => !after.botIds.includes(b));
      const extra = after.botIds.filter((b) => !this.before.botIds.includes(b));
      if (lost.length) this.notes.push(`PARITY/SAFETY: user Bots missing after the run: ${lost.join(", ")}`);
      if (extra.length) this.notes.push(`PARITY/SAFETY: Bots left behind: ${extra.join(", ")}`);
      if (after.maxScreens !== this.before.maxScreens) this.notes.push(`PARITY/SAFETY: MAX_SCREENS changed ${this.before.maxScreens} -> ${after.maxScreens}`);
    } catch (e) {
      this.notes.push(`post-run box check failed: ${String(e)}`);
    }
  }
}
