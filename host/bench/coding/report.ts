import type { RunnerSummary, ScoredRun } from "./score";
import { taskById } from "./suite";
import { traceLine } from "./trace";

const k = (n: number | null | undefined) => (n == null ? "?" : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const secs = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export interface ReportInput {
  meta: { startedAt: string; model: string; runners: string[]; tasks: string[]; dryRun: boolean; timeoutMs: number; maxWeighted?: number | null; startRefs: Record<string, string>; notes: string[] };
  parity: { equalised: string[]; notEqualised: string[] };
  results: ScoredRun[];
  summaries: RunnerSummary[];
}

export function renderMarkdown(r: ReportInput): string {
  const out: string[] = [];
  out.push(`# Coding benchmark: Synapse vs CLI${r.meta.dryRun ? " (DRY RUN: fake model, numbers are synthetic)" : ""}`, "");
  out.push(`${r.meta.startedAt} · model \`${r.meta.model}\` · runners ${r.meta.runners.join(", ")} · ${r.meta.tasks.length} tasks · limit ${secs(r.meta.timeoutMs)}${r.meta.maxWeighted ? ` and ${k(r.meta.maxWeighted)} weighted tokens` : ""} per task`, "");
  out.push("Success is hidden verification only. Weighted = fresh x1.0 + cache write x1.25 + cache read x0.1 (input only; output is its own column).", "");

  out.push("## Overall", "");
  out.push("| Runner | Success | Fresh | Cache read | Cache write | Output | Weighted | Calls | Wall | Interventions | False done (of failures) | Timed out | Usage unknown | Leak suspect |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.summaries) {
    out.push(`| ${s.runner} | ${s.successes}/${s.tasks} (${pct(s.successRate)}) | ${k(s.usage.fresh)} | ${k(s.usage.cacheRead)} | ${k(s.usage.cacheWrite)} | ${k(s.usage.output)} | ${k(s.weighted)} | ${s.calls} | ${secs(s.wallMs)} | ${s.interventions} | ${s.falseDone}/${s.failures} (${pct(s.falseDoneRate)}) | ${s.timedOut} | ${s.unknownUsage} | ${s.leakSuspect} |`);
  }
  out.push("");

  out.push("## Per task", "");
  out.push("| Task | Difficulty | Runner | Result | Fresh | Read | Write | Output | Weighted | Calls | Wall | Interv. | Claimed done | False done |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const id of r.meta.tasks) {
    const t = taskById(id);
    for (const x of r.results.filter((y) => y.taskId === id)) {
      const u = x.usage;
      out.push(`| ${id} ${t.title}${t.trap ? " (trap)" : ""} | ${t.difficulty} | ${x.runner} | ${x.success ? "PASS" : x.budgetExceeded ? "BUDGET EXCEEDED" : "FAIL"}${x.timedOut ? " (timeout)" : ""} | ${k(u?.fresh)} | ${k(u?.cacheRead)} | ${k(u?.cacheWrite)} | ${k(u?.output)} | ${k(x.weighted)} | ${x.calls ?? "?"} | ${secs(x.wallMs)} | ${x.interventions.length} | ${x.claimedDone ? "yes" : "no"} | ${x.falseDone ? "**yes**" : "no"} |`);
    }
  }
  out.push("");

  const traced = r.results.filter((x) => x.trace);
  if (traced.length) {
    out.push("## Per-call trace", "", "Main-model calls only (a Bot's Haiku reviews are usage.db rows, in the notes). Send-only calls: an ack or progress note paid for as a model call of its own.", "");
    for (const x of traced) out.push(`- ${x.taskId} / ${x.runner}: ${traceLine(x.trace!)}`);
    out.push("");
  }

  const failed = r.results.filter((x) => !x.success);
  if (failed.length) {
    out.push("## Failures", "");
    for (const x of failed) {
      const bad = x.checks.filter((c) => !c.pass).map((c) => c.name).join(", ") || "no checks ran";
      out.push(`- **${x.taskId} / ${x.runner}**: failed ${bad}${x.error ? `; error: ${x.error.slice(0, 200)}` : ""}${x.falseDone ? "; the agent claimed it was done" : ""}`);
    }
    out.push("");
  }
  const iv = r.results.filter((x) => x.interventions.length);
  if (iv.length) {
    out.push("## Interventions", "");
    for (const x of iv) for (const i of x.interventions) out.push(`- ${x.taskId} / ${x.runner}: ${i.kind}, ${i.action}: ${i.detail}`);
    out.push("");
  }
  out.push("## Parity", "", "Equalised:", "", ...r.parity.equalised.map((s) => `- ${s}`), "", "Not equalised (read results with these in mind):", "", ...r.parity.notEqualised.map((s) => `- ${s}`), "");
  out.push("## Starting refs", "", ...Object.entries(r.meta.startRefs).map(([id, sha]) => `- ${id}: \`${sha}\``), "");
  if (r.meta.notes.length) out.push("## Notes", "", ...r.meta.notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}
