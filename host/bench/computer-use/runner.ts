import fs from "node:fs";
import path from "node:path";
import { claimsDone, weightedInput } from "../coding/score";
import { addUsage, ZERO_USAGE, type Usage } from "../coding/types";
import { benchCuName, newNonce, type BoxEvent, type CuBox } from "./box";
import { tokensOf, transcriptMetrics, type Mode } from "./metrics";
import { renderReport } from "./report";
import { taskById, type Category, type Check, type CuTask, type SystemState } from "./tasks";
import { isProviderModelRef } from "@synapse/shared";

/** Which brain runs the Bot and its computerUse child: Claude (the Agent SDK), or the provider brain on the Bot's own
 *  provider model (no Claude involved). The runner is chosen by the Bot's model; this names and checks the choice. */
export type CuRunnerKind = "claude" | "provider";
export const CU_RUNNERS: CuRunnerKind[] = ["claude", "provider"];
export function runnerForModel(model: string): CuRunnerKind {
  return isProviderModelRef(model) ? "provider" : "claude";
}

/** What the runner holds equal across the two modes, and what it cannot. Printed in every report. */
export const PARITY = {
  equalised: [
    "Same Bot model for both modes (createAgent model); only the Bot's Computer perception setting differs (setAgentComputerPerception).",
    "A fresh temporary bench-cu-<nonce> Bot per task x mode: no memory or history carries over between runs.",
    "Same prompt text and the same starting state: each task's files are re-created before each run; web records are counted only from after the run started.",
    "Same wall-clock limit; at the limit the Bot is interrupted and then deleted (which stops its computerUse child).",
    "Same hard per-task budget (weighted tokens + wall time); past it the Bot is stopped the same way and the task fails as budget exceeded.",
    "No human: approvals and questions are declined, a box-help request interrupts the run. Each one counts as an intervention.",
    "Success is read from system state only (the local server's records, files on disk, Thunar's xfconf xml), never from the Bot's reply.",
  ],
  notEqualised: [
    "The parent Bot's own turns are metered from usage.db; its computerUse child from the child's session transcript (usage per message id, or per record on the provider runner). They are added.",
    "D3 (Thunar setting) resets by stopping xfconfd and removing the property from thunar.xml; a running Thunar may cache the old value [unverified on the box].",
    "The Bot could bypass the screen through Shell although the prompt forbids it; the tools each run used are listed so such runs can be discounted.",
  ],
};

export interface Intervention { kind: "approval" | "question" | "box-help" | "permission" | "awaiting"; detail: string; action: "declined" | "interrupted" }

export interface CuRun {
  taskId: string; category: Category; mode: Mode; model: string;
  success: boolean; reason: string; claimedDone: boolean; finalText: string;
  usage: Usage | null; weighted: number | null; tokens: number | null;
  calls: number | null; images: number; wallMs: number; timedOut: boolean;
  interventions: Intervention[]; tools: Record<string, number>; error?: string;
  /** Set when the run hit its per-task budget and was stopped; the task then fails as "budget exceeded". */
  budgetExceeded: "tokens" | "time" | null;
}

/**
 * Hard per-task budget (bug-log: the pilot spent 38.3M + 8.7M tokens on 4 tasks against an estimate of <=4.3M).
 * Weighted tokens (fresh 1, cache write 1.25, cache read 0.1) are polled from the child transcripts and the parent's
 * usage.db while the run is live; the wall cap is `maxWallMs`, else the run's `timeoutMs`. Past either, the Bot is
 * interrupted and then deleted (which stops its computerUse child), and the task fails as "budget exceeded".
 */
export interface CuBudget { maxWeighted: number; maxWallMs?: number; pollMs?: number }
export const DEFAULT_CU_BUDGET = { maxWeighted: 750_000, pollMs: 15_000 } as const satisfies CuBudget;

export interface CuRunnerOptions {
  box: CuBox; modes: Mode[]; taskIds: string[]; model: string; timeoutMs: number;
  outDir: string; log?: (s: string) => void;
  /** Per-task budget; DEFAULT_CU_BUDGET when omitted. */
  budget?: CuBudget;
  /** After the Bot and its children go idle, wait this long before calling the run done. */
  settleMs?: number;
  usageWaitMs?: number;
  /** The brain under test; must match the model (a provider runner needs a `<provider>:<model>` ref). Default: from the model. */
  runner?: CuRunnerKind;
}

export interface CuResult { meta: { startedAt: string; model: string; runner: CuRunnerKind; modes: Mode[]; tasks: string[]; notes: string[] }; parity: typeof PARITY; results: CuRun[]; jsonPath: string; mdPath: string }

export async function runCuBench(o: CuRunnerOptions): Promise<CuResult> {
  const runner = o.runner ?? runnerForModel(o.model);
  if (runnerForModel(o.model) !== runner) throw new Error(`the ${runner} runner needs ${runner === "provider" ? "a provider model ref (<provider>:<model>)" : "a Claude model"}, not ${o.model}`);
  if (o.box.real && process.env.BENCH_REAL !== "1") throw new Error(`refusing a real computer-use run: it spends on the ${runner === "provider" ? "model provider's" : "Anthropic API"} key. Set BENCH_REAL=1 (after approval).`);
  const log = o.log ?? (() => {});
  const box = o.box;
  const tasks = o.taskIds.map(taskById);
  const notes: string[] = [];
  const results: CuRun[] = [];
  const startBots = (await box.listBots()).map((b) => b.id);
  const siteNonce = newNonce();
  const events = new Set<(ev: BoxEvent) => void>();
  const unsubscribe = await box.subscribe((ev) => { for (const l of [...events]) l(ev); });
  try {
    const ctx = await box.setup(siteNonce, tasks);
    for (const mode of o.modes) {
      for (const task of tasks) {
        const r = await runOne(o, task, mode, ctx, siteNonce, events, notes);
        results.push(r);
        log(`[${mode}] ${task.id} ${r.success ? "PASS" : "FAIL"} ${r.reason}${r.error ? ` error: ${r.error.slice(0, 120)}` : ""}`);
      }
    }
  } finally {
    unsubscribe();
    try { await box.teardown(siteNonce); } catch (e) { notes.push(`teardown failed: ${String(e)}`); }
    try {
      const after = (await box.listBots()).map((b) => b.id);
      const lost = startBots.filter((b) => !after.includes(b));
      const extra = after.filter((b) => !startBots.includes(b));
      if (lost.length) notes.push(`SAFETY: user Bots missing after the run: ${lost.join(", ")}`);
      if (extra.length) notes.push(`SAFETY: Bots left behind: ${extra.join(", ")}`);
    } catch (e) { notes.push(`post-run check failed: ${String(e)}`); }
  }
  const meta = { startedAt: new Date().toISOString(), model: o.model, runner, modes: o.modes, tasks: tasks.map((t) => t.id), notes };
  fs.mkdirSync(o.outDir, { recursive: true });
  const jsonPath = path.join(o.outDir, "results.json");
  const mdPath = path.join(o.outDir, "report.md");
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, parity: PARITY, results }, null, 2) + "\n");
  fs.writeFileSync(mdPath, renderReport({ meta, parity: PARITY, results }));
  return { meta, parity: PARITY, results, jsonPath, mdPath };
}

async function runOne(o: CuRunnerOptions, task: CuTask, mode: Mode, ctx: { base: string; desk: string }, siteNonce: string, events: Set<(ev: BoxEvent) => void>, notes: string[]): Promise<CuRun> {
  const box = o.box;
  const base: CuRun = { taskId: task.id, category: task.category, mode, model: o.model, success: false, reason: "", claimedDone: false, finalText: "", usage: null, weighted: null, tokens: null, calls: null, images: 0, wallMs: 0, timedOut: false, interventions: [], tools: {}, budgetExceeded: null };
  let botId = "";
  const t0 = Date.now();
  try {
    await box.resetTask(siteNonce, task);
    const before = (await box.submissions(siteNonce))[task.id]?.length ?? 0;
    const xfBefore = task.xfconf ? await box.xfconf() : null;
    botId = await box.createBot(benchCuName(newNonce()), o.model);
    await box.setPerception(botId, mode);
    const run = await drive(o, botId, task, task.prompt(ctx), siteNonce, events, t0);
    Object.assign(base, run);

    const state: SystemState = {
      submissions: { [task.id]: ((await box.submissions(siteNonce))[task.id] ?? []).slice(before) },
      files: task.watch ? await box.readFiles(siteNonce, task.watch) : {},
      xfconf: { before: xfBefore, after: task.xfconf ? await box.xfconf() : null },
    };
    const v: Check = task.check(state);
    base.success = v.pass;
    base.reason = v.reason;
    base.claimedDone = claimsDone(base.finalText);

    const m = await measure(box, botId, t0);
    base.images += m.images;
    for (const [k, n] of Object.entries(m.tools)) base.tools[k] = (base.tools[k] ?? 0) + n;
    base.images += base.tools["mcp__bot__Screenshot"] ?? 0; // the parent's own screenshots (each returns one image)
    base.usage = m.usage;
    base.calls = m.calls;
    base.weighted = weightedInput(m.usage);
    base.tokens = tokensOf(m.usage);
    if (base.budgetExceeded) {
      // A stopped run fails whatever state it left: the budget is part of the task.
      const cap = budgetOf(o);
      base.success = false;
      base.reason = base.budgetExceeded === "tokens"
        ? `budget exceeded: ${Math.round(base.weighted).toLocaleString("en-US")} weighted tokens > cap ${cap.maxWeighted.toLocaleString("en-US")}`
        : `budget exceeded: wall time past ${Math.round(cap.maxWallMs / 1000)} s`;
    }
  } catch (err) {
    base.error = String(err);
    base.reason ||= "run failed before a check";
    base.wallMs ||= Date.now() - t0;
  } finally {
    if (botId) {
      try { await box.deleteBot(botId); } catch (e) { notes.push(`${task.id}/${mode}: deleteBot ${botId} failed: ${String(e)}`); }
    }
  }
  return base;
}

/** The run's effective budget: the wall cap never exceeds the run's timeout. */
function budgetOf(o: CuRunnerOptions): { maxWeighted: number; maxWallMs: number; pollMs: number } {
  const b: CuBudget = o.budget ?? DEFAULT_CU_BUDGET;
  return { maxWeighted: b.maxWeighted, maxWallMs: Math.min(b.maxWallMs ?? o.timeoutMs, o.timeoutMs), pollMs: b.pollMs ?? DEFAULT_CU_BUDGET.pollMs };
}

/** Usage so far: the parent's usage.db rows + its computerUse children's transcripts. */
async function measure(box: CuBox, botId: string, t0: number): Promise<{ usage: Usage; calls: number; images: number; tools: Record<string, number> }> {
  let usage: Usage = ZERO_USAGE;
  let calls = 0, images = 0;
  const tools: Record<string, number> = {};
  for (const r of await box.usage(botId, t0 - 1_000)) {
    usage = addUsage(usage, { fresh: r.inputTokens, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.outputTokens });
    calls += r.numTurns;
  }
  for (const t of await box.childTranscripts(botId)) {
    const m = transcriptMetrics(t);
    usage = addUsage(usage, m.usage);
    calls += m.calls;
    images += m.images;
    for (const [k, n] of Object.entries(m.tools)) tools[k] = (tools[k] ?? 0) + n;
  }
  return { usage, calls, images, tools };
}

/** Sends the prompt and waits until the Bot and every child it launched are idle (read off SSE), or until the
 *  per-task budget stops it (weighted tokens polled every `pollMs`, wall time on a timer). */
async function drive(o: CuRunnerOptions, id: string, task: CuTask, prompt: string, siteNonce: string, events: Set<(ev: BoxEvent) => void>, runT0: number): Promise<Pick<CuRun, "finalText" | "wallMs" | "timedOut" | "interventions" | "tools" | "budgetExceeded">> {
  const box = o.box;
  const t0 = Date.now();
  const texts: string[] = [];
  const interventions: Intervention[] = [];
  const tools: Record<string, number> = {};
  const handled = new Set<string>();
  const pending: Promise<unknown>[] = [];
  let running = false, sawRunning = false, liveChildren = 0, timedOut = false;
  let settle: NodeJS.Timeout | null = null;
  let resolveDone = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  const act = (key: string, iv: Intervention, fn: () => Promise<unknown>) => {
    if (handled.has(key)) return;
    handled.add(key);
    interventions.push(iv);
    pending.push(fn().catch(() => {}));
  };
  const maybeDone = () => {
    if (settle) { clearTimeout(settle); settle = null; }
    if (sawRunning && !running && liveChildren === 0) settle = setTimeout(resolveDone, o.settleMs ?? (box.real ? 5_000 : 20));
  };
  const listener = (ev: BoxEvent) => {
    const p = ev.payload ?? {};
    if (ev.channel === "agent-upserted" && p.agent?.id === id) {
      running = !!p.agent.running;
      if (running) sawRunning = true;
      const aw = p.agent.awaiting;
      if (aw && aw.tabId !== "widget" && aw.tabId !== "auto-review") act(`await:${aw.tabId}:${aw.since}`, { kind: "awaiting", detail: String(aw.tabId), action: "interrupted" }, () => box.call("interruptAgent", { id }));
      maybeDone();
    }
    if (ev.channel === "async-tasks" && p.botId === id) {
      liveChildren = (p.tasks ?? []).filter((t: any) => t.status === "queued" || t.status === "running").length;
      maybeDone();
    }
    if (ev.channel === "box-help" && (p.request?.botId === id || p.botId === id)) {
      act(`bh:${p.request?.id}`, { kind: "box-help", detail: String(p.request?.reason ?? ""), action: "interrupted" }, () => box.call("interruptAgent", { id }));
    }
    if (ev.channel === "transcript" && p.botId === id && p.entry) {
      const e = p.entry;
      if (e.kind === "tool-call" && e.name) tools[e.name] = (tools[e.name] ?? 0) + 1;
      if (e.kind !== "send-message" || !e.message) return;
      const m = e.message;
      if (m.type === "text" && p.op === "append") texts.push(String(m.content ?? ""));
      else if (m.type === "widget" && e.status === "pending") act(`w:${e.id}`, { kind: "question", detail: String(m.widget?.question ?? "").slice(0, 160), action: "declined" }, () => box.call("dismissWidget", { id, entryId: e.id }));
      else if (m.type === "auto-review-approval" && m.approval?.status === "pending") act(`a:${m.approval.approvalId}`, { kind: "approval", detail: String(m.approval.command ?? "").slice(0, 160), action: "declined" }, () => box.call("resolveAutoReviewApproval", { id, approvalId: m.approval.approvalId, choice: "deny" }));
      else if (m.type === "card" && m.card?.kind === "local-tool-permission" && m.card.status === "pending") act(`l:${m.card.askId}`, { kind: "permission", detail: `${m.card.action} ${m.card.target}`, action: "declined" }, () => box.call("resolveLocalToolPermission", { id, askId: m.card.askId, choice: "deny" }));
    }
  };
  events.add(listener);
  const cap = budgetOf(o);
  let budgetExceeded: CuRun["budgetExceeded"] = null;
  const stop = (why: "tokens" | "time") => {
    if (budgetExceeded) return;
    budgetExceeded = why;
    if (why === "time") timedOut = true;
    pending.push(box.call("interruptAgent", { id }).catch(() => {}));
    resolveDone();
  };
  const timer = setTimeout(() => stop("time"), cap.maxWallMs);
  let polling = false;
  const poll = setInterval(() => {
    if (polling || budgetExceeded) return;
    polling = true;
    measure(box, id, runT0)
      .then((m) => { if (weightedInput(m.usage) > cap.maxWeighted) stop("tokens"); })
      .catch(() => {})
      .finally(() => { polling = false; });
  }, cap.pollMs);
  try {
    await box.call("sendPrompt", { id, text: prompt, clientNonce: `bench-cu-${siteNonce}-${task.id}` });
    await done;
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    if (settle) clearTimeout(settle);
    events.delete(listener);
    await Promise.all(pending);
  }
  const wallMs = Date.now() - t0;
  // usage.db is written when a run ends; the gateway announces it on `usage`. Give it a moment.
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { events.delete(l); resolve(); }, o.usageWaitMs ?? (box.real ? 10_000 : 50));
    const l = (ev: BoxEvent) => { if (ev.channel === "usage") { clearTimeout(t); events.delete(l); resolve(); } };
    events.add(l);
  });
  return { finalText: texts.join("\n"), wallMs, timedOut, interventions, tools, budgetExceeded };
}
