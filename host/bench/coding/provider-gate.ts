import fs from "node:fs";
import path from "node:path";
import { isProviderModelRef } from "@synapse/shared";
import { BENCH_RATIO, ProviderEvidenceStore, type BenchRecord } from "../../brain/provider/conformance/evidence";
import { TASKS } from "./suite";

/**
 * The coding-bench gate for a provider model (spec §11.2): a provider Bot's bench run passes when its pass rate is at
 * least 85% of the default Claude Bot's on the same tasks, and every trap task (the obvious fix is wrong) passes.
 * Run it on two results.json files the coding bench wrote (`npm run bench:coding`); it runs no model itself.
 *
 *   npm run bench:provider-gate -- --ref openai:gpt-6.1-sol --provider <results.json> --claude <results.json> [--record <hostPrivate>]
 *
 * `--record` writes the result into hostPrivate/provider-evidence.json, where the model picker's badge reads it.
 */
interface Result { taskId: string; runner: string; success?: boolean }
interface Report { meta?: { model?: string }; results: Result[] }

export function gate(ref: string, provider: Report, claude: Report, now = Date.now(), reportPath = ""): BenchRecord {
  // The provider's own run: a provider Bot on the box (synapse), or Synapse's coding engine on its model (provider-loop).
  const mine = provider.results.filter((r) => r.runner === "synapse" || r.runner === "provider-loop");
  const theirs = claude.results.filter((r) => r.runner === "synapse");
  const tasks = [...new Set(mine.map((r) => r.taskId))].filter((t) => theirs.some((r) => r.taskId === t));
  if (!tasks.length) throw new Error("the two reports share no tasks");
  const rate = (rs: Result[]) => { const on = rs.filter((r) => tasks.includes(r.taskId)); return on.length ? on.filter((r) => r.success).length / on.length : 0; };
  const passRate = rate(mine);
  const claudePassRate = rate(theirs);
  const ratio = claudePassRate ? passRate / claudePassRate : passRate > 0 ? 1 : 0;
  const traps = TASKS.filter((t) => t.trap && tasks.includes(t.id)).map((t) => t.id);
  const trapsOk = traps.every((id) => mine.filter((r) => r.taskId === id).every((r) => r.success));
  return { ref, at: now, passRate, claudePassRate, ratio, trapsOk, passed: trapsOk && ratio >= BENCH_RATIO, tasks: tasks.length, report: reportPath };
}

export function main(argv: string[]): number {
  const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const ref = arg("ref"), pf = arg("provider"), cf = arg("claude"), rec = arg("record");
  if (!ref || !isProviderModelRef(ref) || !pf || !cf) {
    console.error("usage: bench:provider-gate -- --ref <provider:model> --provider <results.json> --claude <results.json> [--record <hostPrivate dir>]");
    return 2;
  }
  const r = gate(ref, JSON.parse(fs.readFileSync(pf, "utf8")) as Report, JSON.parse(fs.readFileSync(cf, "utf8")) as Report, Date.now(), pf);
  console.log(`${ref}: ${(r.passRate * 100).toFixed(0)}% vs Claude ${(r.claudePassRate * 100).toFixed(0)}% = ${(r.ratio * 100).toFixed(0)}% (bar ${BENCH_RATIO * 100}%), traps ${r.trapsOk ? "all passed" : "FAILED"}, ${r.tasks} tasks → ${r.passed ? "PASS" : "FAIL"}`);
  if (rec) new ProviderEvidenceStore(path.join(rec, "provider-evidence.json")).saveBench(r);
  return r.passed ? 0 : 1;
}
