import path from "node:path";
import { DEFAULT_BOT_MODEL, spawnModelId } from "@synapse/shared";
import { renderEstimate } from "./estimate";
import { runBench } from "./harness";
import { benchDir } from "./repo";
import { PILOT, TASKS } from "./suite";
import type { RunnerName } from "./types";

const USAGE = `npm run bench:coding -- [--runner cli|synapse|both|provider-loop] [--tasks T01,T03|pilot|all] [--dry-run]
                          [--model <id>] [--timeout-min <n>] [--max-weighted <n>] [--out <dir>] [--estimate] [--list]
                          [--upstream <url>]

  --runner provider-loop  Synapse's own coding engine on a provider model (--model openai:gpt-6.1-sol) or a Claude
               model (--model claude-sonnet-5-5, key from ANTHROPIC_API_KEY); a provider's key from BENCH_PROVIDER_KEY
               or <PROVIDER>_API_KEY; --upstream for a local model. --runner cli,provider-loop runs both on one model.

  --dry-run    fake model on both runners: no Claude call, nothing spent (default when BENCH_REAL is unset)
  --max-weighted  per-task weighted-token budget (default 300000), metered live on both runners; past it
               the run is stopped and the task fails as budget exceeded
  --estimate   print the token estimate for the selection and exit
  --list       print the task suite and exit
  Real runs need BENCH_REAL=1; each one spends on the Anthropic API key.`;

/** Per-task weighted-token budget (bug-log 88): ~4x Synapse's worst pilot task (74k, 2026-09-21 run 3). */
export const DEFAULT_MAX_WEIGHTED = 300_000;

/** Default model: the Bot's (DEFAULT_BOT_MODEL, as it is spawned), so both runners match. */
export const DEFAULT_MODEL = spawnModelId(DEFAULT_BOT_MODEL);

export async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  const runnerArg = arg("--runner") ?? "both";
  // A comma list runs several (0.1.8: `--runner cli,provider-loop` compares Claude Code with Synapse's own engine).
  const picked = runnerArg === "both" ? ["cli", "synapse"] : runnerArg.split(",").map((s) => s.trim());
  if (!picked.length || !picked.every((r) => ["cli", "synapse", "provider-loop"].includes(r))) { console.error(USAGE); return 2; }
  const runners = picked as RunnerName[];
  const tasksArg = arg("--tasks") ?? "pilot";
  const taskIds = tasksArg === "pilot" ? PILOT : tasksArg === "all" ? TASKS.map((t) => t.id) : tasksArg.split(",").map((s) => s.trim().toUpperCase());

  if (argv.includes("--list")) {
    for (const t of TASKS) console.log(`${t.id}  ${t.difficulty.padEnd(6)}  ${t.category.padEnd(10)}  ${t.title}${t.trap ? "  [trap]" : ""}${t.after ? `  [after ${t.after}]` : ""}${t.pilot ? "  [pilot]" : ""}`);
    return 0;
  }
  if (argv.includes("--estimate")) { console.log(renderEstimate(taskIds, runners)); return 0; }

  const maxWeighted = Number(arg("--max-weighted") ?? DEFAULT_MAX_WEIGHTED);
  if (!Number.isFinite(maxWeighted) || maxWeighted <= 0) { console.error(USAGE); return 2; }
  const dryRun = argv.includes("--dry-run") || process.env.BENCH_REAL !== "1";
  if (!argv.includes("--dry-run") && dryRun) console.log("BENCH_REAL is not 1: running as --dry-run (fake model, nothing spent).");
  const outDir = path.resolve(arg("--out") ?? path.join(benchDir(), "..", "..", "..", "test-reports", "bench-coding", `${new Date().toISOString().replace(/[:.]/g, "-")}${dryRun ? "-dry" : ""}`));
  const r = await runBench({
    runners, taskIds, dryRun, outDir,
    model: arg("--model") ?? DEFAULT_MODEL,
    timeoutMs: Number(arg("--timeout-min") ?? 20) * 60_000,
    maxWeighted,
    ...(arg("--upstream") ? { providerUpstream: arg("--upstream")! } : {}),
    log: (s) => console.log(s),
  });
  console.log(`budget per task: ${maxWeighted} weighted tokens (--max-weighted)`);
  for (const s of r.summaries) console.log(`${s.runner}: ${s.successes}/${s.tasks} passed, weighted input ${Math.round(s.weighted)}, output ${s.usage.output}, calls ${s.calls}, false done ${s.falseDone}/${s.failures}`);
  console.log(`report: ${r.mdPath}\njson:   ${r.jsonPath}`);
  return 0;
}
