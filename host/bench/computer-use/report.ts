import { tokensOf, type Mode } from "./metrics";
import type { CuRun, PARITY } from "./runner";

const k = (n: number | null) => (n === null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

export interface ModeSummary { mode: Mode; tasks: number; successes: number; tokens: number; weighted: number; output: number; cacheRead: number; cacheWrite: number; fresh: number; calls: number; images: number; wallMs: number; interventions: number }

export function summarizeCu(results: CuRun[], filter: (r: CuRun) => boolean = () => true): ModeSummary[] {
  const modes = [...new Set(results.map((r) => r.mode))];
  return modes.map((mode) => {
    const rs = results.filter((r) => r.mode === mode && filter(r));
    const sum = (f: (r: CuRun) => number) => rs.reduce((a, r) => a + f(r), 0);
    return {
      mode, tasks: rs.length, successes: rs.filter((r) => r.success).length,
      tokens: sum((r) => (r.usage ? tokensOf(r.usage) : 0)), weighted: sum((r) => r.weighted ?? 0),
      fresh: sum((r) => r.usage?.fresh ?? 0), cacheRead: sum((r) => r.usage?.cacheRead ?? 0), cacheWrite: sum((r) => r.usage?.cacheWrite ?? 0), output: sum((r) => r.usage?.output ?? 0),
      calls: sum((r) => r.calls ?? 0), images: sum((r) => r.images), wallMs: sum((r) => r.wallMs), interventions: sum((r) => r.interventions.length),
    };
  });
}

export function renderReport(o: { meta: { startedAt: string; model: string; modes: Mode[]; tasks: string[]; notes: string[] }; parity: typeof PARITY; results: CuRun[] }): string {
  const L: string[] = [`# Computer-use bench: Screenshots vs Live`, "", `Started ${o.meta.startedAt} · model ${o.meta.model} · modes ${o.meta.modes.join(", ")} · ${o.meta.tasks.length} tasks`, "",
    "Success is the gate: Live only becomes the default if it completes at least as many tasks as Screenshots.", ""];
  const head = "| Mode | Success | Tokens | Weighted input | Fresh | Cache read | Cache write | Output | Calls | Images | Wall | Interventions |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (s: ModeSummary) => `| ${s.mode} | ${s.successes}/${s.tasks} | ${k(s.tokens)} | ${k(s.weighted)} | ${k(s.fresh)} | ${k(s.cacheRead)} | ${k(s.cacheWrite)} | ${k(s.output)} | ${s.calls} | ${s.images} | ${Math.round(s.wallMs / 1000)} s | ${s.interventions} |`;
  L.push("## All tasks", "", head, sep, ...summarizeCu(o.results).map(row), "");
  for (const c of ["web", "desktop", "hard"] as const) L.push(`## ${c}`, "", head, sep, ...summarizeCu(o.results, (r) => r.category === c).map(row), "");
  L.push("## Per task", "", "| Task | Mode | Result | Why | Tokens | Calls | Images | Wall | Interventions | Tools |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of o.results) {
    L.push(`| ${r.taskId} | ${r.mode} | ${r.success ? "PASS" : r.budgetExceeded ? `BUDGET EXCEEDED (${r.budgetExceeded})` : "FAIL"}${r.claimedDone && !r.success && !r.budgetExceeded ? " (claimed done)" : ""} | ${r.error ? `error: ${r.error.slice(0, 80)}` : r.reason} | ${k(r.tokens)} | ${r.calls ?? "–"} | ${r.images} | ${Math.round(r.wallMs / 1000)} s | ${r.interventions.map((i) => i.kind).join(", ") || "–"} | ${Object.entries(r.tools).map(([t, n]) => `${t.replace(/^mcp__\w+__/, "")}×${n}`).join(" ")} |`);
  }
  L.push("", "## Parity", "", "Equalised:", ...o.parity.equalised.map((s) => `- ${s}`), "", "Not equalised:", ...o.parity.notEqualised.map((s) => `- ${s}`));
  if (o.meta.notes.length) L.push("", "## Notes", "", ...o.meta.notes.map((s) => `- ${s}`));
  return L.join("\n") + "\n";
}
