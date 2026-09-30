import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BOT_MODEL, spawnModelId } from "@synapse/shared";
import type { CuBox } from "./box";
import { renderCuEstimate } from "./estimate";
import { MODES, type Mode } from "./metrics";
import { CU_RUNNERS, DEFAULT_CU_BUDGET, runCuBench, runnerForModel, type CuRunnerKind } from "./runner";
import { TASKS } from "./tasks";

const USAGE = `npm run bench:cu -- [--runner claude|provider] [--modes screenshots,live] [--tasks W1,H3|all] [--model <id>] [--timeout-min <n>]
                      [--max-weighted <n>] [--out <dir>] [--dry-run] [--estimate] [--list]

  --runner        claude (default): the Bot and its computerUse child run on Claude.
                  provider: they run on the provider brain on --model, a <provider>:<model> ref (e.g. openai:gpt-6.1-sol);
                  no Claude is involved, and a model that can't read images uses the text-only screen tools.

  --timeout-min   per-task wall-time budget (default 15)
  --max-weighted  per-task weighted-token budget (default ${DEFAULT_CU_BUDGET.maxWeighted}); past either the Bot is stopped
                  and the task is marked budget exceeded
  Live perception is shelved (decisions.md 2026-09-21): the host rejects "live", so a live run errors before any prompt.

  --dry-run    print the plan (tasks, modes, model, what each run does) and exit: nothing is touched
  --estimate   print the token estimate for the selection and exit
  --list       print the task suite and exit
  Real runs need BENCH_REAL=1; each one spends on the Anthropic API key (claude) or the provider's key (provider), on
  temporary bench-cu-* Bots on the box.`;

/** The computerUse subagent's model is fixed by the host; the Bot model is the Bot's default, the same for both modes. */
export const DEFAULT_MODEL = spawnModelId(DEFAULT_BOT_MODEL);

const here = () => process.env.BENCH_CU_DIR ?? path.dirname(fileURLToPath(import.meta.url));

export async function main(argv: string[], deps: { makeBox?: () => CuBox | Promise<CuBox>; out?: (s: string) => void } = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--help") || argv.includes("-h")) { out(USAGE); return 0; }
  const runner = (arg("--runner") ?? "claude") as CuRunnerKind;
  if (!CU_RUNNERS.includes(runner)) { out(USAGE); return 2; }
  // Live perception is shelved; the provider runner starts on Screenshots only.
  const modes = (arg("--modes") ?? (runner === "provider" ? "screenshots" : "screenshots,live")).split(",").map((s) => s.trim()) as Mode[];
  if (!modes.length || modes.some((m) => !MODES.includes(m))) { out(USAGE); return 2; }
  const tasksArg = arg("--tasks") ?? "all";
  const taskIds = tasksArg === "all" ? TASKS.map((t) => t.id) : tasksArg.split(",").map((s) => s.trim().toUpperCase());
  const unknown = taskIds.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) { out(`unknown task(s): ${unknown.join(", ")}`); return 2; }
  const model = arg("--model") ?? (runner === "provider" ? "" : DEFAULT_MODEL);
  if (runnerForModel(model) !== runner) { out(`the ${runner} runner needs ${runner === "provider" ? "--model <provider>:<model>, e.g. openai:gpt-6.1-sol" : "a Claude --model"}`); return 2; }
  const timeoutMs = Number(arg("--timeout-min") ?? 15) * 60_000;
  const maxWeighted = Number(arg("--max-weighted") ?? DEFAULT_CU_BUDGET.maxWeighted);
  if (!Number.isFinite(maxWeighted) || maxWeighted <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) { out(USAGE); return 2; }
  const budget = { ...DEFAULT_CU_BUDGET, maxWeighted };
  const budgetLine = `Budget per task: ${maxWeighted.toLocaleString("en-US")} weighted tokens and ${timeoutMs / 60_000} min wall time; past either the Bot is stopped and the task is marked budget exceeded.`;

  if (argv.includes("--list")) {
    for (const t of TASKS) out(`${t.id}  ${t.category.padEnd(8)} ${t.difficulty.padEnd(7)} ${t.title}`);
    return 0;
  }
  if (argv.includes("--estimate")) { out(renderCuEstimate(taskIds, modes)); return 0; }
  if (argv.includes("--dry-run")) {
    out(`DRY RUN (nothing touched): ${taskIds.length} tasks x modes ${modes.join(", ")} on the ${runner} runner, model ${model}, ${timeoutMs / 60_000} min limit each.`);
    out("Per run: create a bench-cu-<nonce> Bot -> setAgentComputerPerception(mode) -> send the task prompt -> wait for the Bot and its computerUse child to go idle -> read system state -> check -> delete the Bot (finally).");
    out(budgetLine);
    for (const m of modes) for (const id of taskIds) {
      const t = TASKS.find((x) => x.id === id)!;
      out(`  [${m}] ${t.id} ${t.category}/${t.difficulty}: ${t.title}`);
    }
    out("");
    out(renderCuEstimate(taskIds, modes));
    return 0;
  }
  if (process.env.BENCH_REAL !== "1") { out("refusing a real computer-use run: set BENCH_REAL=1 (after approval), or use --dry-run / --estimate."); return 2; }

  const box = await (deps.makeBox ?? (async () => new (await import("./gateway-cu-box")).GatewayCuBox()))();
  const outDir = path.resolve(arg("--out") ?? path.join(here(), "..", "..", "..", "test-reports", "bench-cu", new Date().toISOString().replace(/[:.]/g, "-")));
  out(budgetLine);
  const r = await runCuBench({ box, modes, taskIds, model, runner, timeoutMs, outDir, log: out, budget });
  for (const m of modes) {
    const rs = r.results.filter((x) => x.mode === m);
    out(`${m}: ${rs.filter((x) => x.success).length}/${rs.length} passed, tokens ${rs.reduce((a, x) => a + (x.tokens ?? 0), 0)}, images ${rs.reduce((a, x) => a + x.images, 0)}`);
  }
  out(`report: ${r.mdPath}\njson:   ${r.jsonPath}`);
  return 0;
}
