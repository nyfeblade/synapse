/**
 * `npm run journeys` — the journeys and their latency budgets (battle plan 5.9: "speed is key").
 *
 *   npm run journeys                      run every journey N times, append to the history, fail over budget
 *   npm run journeys -- --report          …and write test-reports/journeys/<date>.md and <date>.html
 *   npm run journeys -- --runs 7          runs per journey (default 5; the median is judged)
 *   npm run journeys -- --only switch-bot,search
 *   npm run journeys -- --strict          judge raw wall time, no load scaling
 *   npm run journeys -- --set-budgets     write budgets.json from this run's medians plus the margin
 *   npm run journeys -- --report-only     rebuild the report from the history without running anything
 *   npm run journeys -- --no-history      don't append this run to history.jsonl
 *
 * Load-robust (scripts/perf/robust-timing.ts): a calibration workload is timed before and after the journeys. Its
 * wall/CPU ratio is how much other processes are stretching wall time right now, and each journey's wall budget is
 * stretched by that (capped at ×4). The CPU budgets (renderer main-thread CPU, which load doesn't inflate) are only
 * scaled by the machine's measured speed against the calibration stored with the budgets. A median over N runs, not
 * a p95, is what is judged. Exit code 1 on any regression: the gate (see scripts/journeys/README.md).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calibrate, median, type Calibration } from "../perf/robust-timing.ts";
import { budgetFrom, JOURNEYS, judge, type BudgetFile } from "./budgets.ts";
import { coldStart, firstLaunch, openSession, sessionJourney } from "./journeys.ts";
import type { Sample } from "./measure.ts";
import { writeReport, type HistoryRow, type JourneyResult } from "./report.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUDGETS = path.join(import.meta.dirname, "budgets.json");
const OUT_DIR = path.join(ROOT, "test-reports", "journeys");
const HISTORY = path.join(OUT_DIR, "history.jsonl");


const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const RUNS = Math.max(1, Number(opt("--runs") ?? 5));
const ONLY = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean);

function readBudgets(): BudgetFile {
  return JSON.parse(fs.readFileSync(BUDGETS, "utf8")) as BudgetFile;
}

function git(cmd: string): string { try { return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } }

async function runAll(): Promise<{ results: Record<string, Sample[]>; errors: string[] }> {
  const selected = JOURNEYS.filter((j) => !ONLY || ONLY.includes(j.id));
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-journeys-")));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const results: Record<string, Sample[]> = {};
  const errors: string[] = [];
  const log = (s: string) => process.stdout.write(`${s}\n`);
  try {
    // An onboarded profile is needed by everything else: first-launch makes it (one extra, unmeasured run warms
    // the OS file cache for Electron and the host so the first measured launch isn't the one that pays for it).
    const profile = path.join(tmp, "profile");
    await firstLaunch(profile, home);
    if (selected.some((j) => j.id === "first-launch")) {
      results["first-launch"] = [];
      for (let i = 0; i < RUNS; i++) {
        const dir = path.join(tmp, `fresh-${i}`);
        const s = await firstLaunch(dir, home);
        fs.rmSync(dir, { recursive: true, force: true });
        results["first-launch"].push(s);
        log(`  first-launch #${i + 1}: ${s.wallMs.toFixed(0)} ms`);
      }
    }
    if (selected.some((j) => j.id === "cold-start")) {
      results["cold-start"] = [];
      for (let i = 0; i < RUNS; i++) {
        const s = await coldStart(profile, home);
        results["cold-start"].push(s);
        log(`  cold-start #${i + 1}: ${s.wallMs.toFixed(0)} ms`);
      }
    }
    const session = selected.filter((j) => j.kind === "session");
    if (session.length) {
      const l = await openSession(profile, home, { longChat: session.some((j) => j.id.startsWith("long-")) });
      try {
        // One unmeasured warm-up of each (first render of a view compiles and lays it out once), then rounds that
        // interleave the journeys so a slow moment on the machine is spread across all of them, not one.
        for (const j of session) await sessionJourney(j.id, l, -1);
        for (let r = 0; r < RUNS; r++) {
          for (const j of session) {
            const s = await sessionJourney(j.id, l, r);
            (results[j.id] ??= []).push(s);
            log(`  ${j.id} #${r + 1}: ${s.wallMs.toFixed(1)} ms (cpu ${s.cpuMs.toFixed(1)} ms, long tasks ${s.longTasks})`);
          }
        }
        errors.push(...l.errors);
      } finally {
        await l.app.close();
      }
    }
    // Bug 443: every app above ran with TMPDIR inside this run's folder. A launch and a quit must leave nothing there
    // (the updater used to make a stage folder at every startup).
    const leftovers = fs.existsSync(path.join(tmp, "tmp")) ? fs.readdirSync(path.join(tmp, "tmp")) : [];
    if (leftovers.length) errors.push(`TEMP LEAK: the app left ${leftovers.join(", ")} in its temp folder`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { results, errors };
}

async function main(): Promise<void> {
  if (flag("--report-only")) {
    const rows = fs.existsSync(HISTORY) ? fs.readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryRow) : [];
    if (!rows.length) throw new Error(`no history at ${HISTORY}`);
    const out = writeReport(rows, OUT_DIR);
    process.stdout.write(`report: ${out.md}\n        ${out.html}\n`);
    return;
  }
  const strict = flag("--strict");
  const before = calibrate();
  process.stdout.write(`journeys: ${RUNS} runs each; calibration ${before.cpuMs.toFixed(1)} ms CPU, load ×${before.load.toFixed(2)}\n`);
  const { results, errors } = await runAll();
  const afterCal = calibrate();
  // The heavier of the two readings: load that came and went during the run still stretched some of it.
  const cal: Calibration = afterCal.load > before.load ? afterCal : before;
  const budgets = fs.existsSync(BUDGETS) ? readBudgets() : null;

  if (flag("--set-budgets")) {
    // Click-level journeys: ×1.5, never tighter than +30 ms wall (two 60 Hz frames: a median still lands on frame
    // boundaries) or +15 ms CPU. Launch journeys are seconds long and steady: ×1.25.
    const margin = budgets?.margin ?? { factor: 1.5, launchFactor: 1.25, wallFloorMs: 30, cpuFloorMs: 15 };
    // Budgets are set from an unloaded reading: divide the medians by the load seen now.
    const next: BudgetFile = { calibration: { cpuMs: Math.round(cal.cpuMs * 100) / 100, wallMs: Math.round(cal.wallMs * 100) / 100 }, margin, journeys: { ...(budgets?.journeys ?? {}) }, ...(budgets?.relative ? { relative: budgets.relative } : {}) };
    for (const [id, xs] of Object.entries(results)) {
      const factor = JOURNEYS.find((j) => j.id === id)?.kind === "launch" ? margin.launchFactor : margin.factor;
      next.journeys[id] = {
        wallMs: budgetFrom(median(xs.map((x) => x.wallMs)) / cal.load, factor, margin.wallFloorMs),
        cpuMs: budgetFrom(median(xs.map((x) => x.cpuMs)), factor, margin.cpuFloorMs),
      };
    }
    fs.writeFileSync(BUDGETS, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`budgets written: ${BUDGETS}\n`);
  }

  const judged = judge(results, cal, fs.existsSync(BUDGETS) ? readBudgets() : null, strict);
  const row: HistoryRow = {
    at: new Date().toISOString(), commit: git("rev-parse --short HEAD"), branch: git("rev-parse --abbrev-ref HEAD"),
    runs: RUNS, strict, calibration: { cpuMs: cal.cpuMs, wallMs: cal.wallMs, load: cal.load },
    journeys: judged.map(({ samples: _s, ...r }) => r),
  };
  if (!flag("--no-history")) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(HISTORY, `${JSON.stringify(row)}\n`);
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`\n${pad("journey", 16)}${pad("median", 11)}${pad("limit", 11)}${pad("budget", 10)}${pad("cpu", 16)}long tasks\n`);
  for (const r of judged) {
    process.stdout.write(`${pad(r.id, 16)}${pad(`${r.wallMs.toFixed(0)} ms`, 11)}${pad(r.wallLimit ? `${r.wallLimit.toFixed(0)} ms` : "-", 11)}${pad(r.budget ? `${r.budget.wallMs} ms` : "-", 10)}${pad(`${r.cpuMs.toFixed(0)}/${r.cpuLimit?.toFixed(0) ?? "-"} ms`, 16)}${r.longTasks}${r.ratio !== undefined ? `  ×${r.ratio.toFixed(2)}/${r.ratioLimit}` : ""}${r.pass === false ? "  OVER BUDGET" : ""}\n`);
  }
  if (errors.length) process.stdout.write(`\nerrors during the run:\n${[...new Set(errors)].map((e) => `  ${e}`).join("\n")}\n`);

  if (flag("--report")) {
    const rows = fs.readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryRow);
    const out = writeReport(flag("--no-history") ? [...rows, row] : rows, OUT_DIR);
    process.stdout.write(`\nreport: ${out.md}\n        ${out.html}\n`);
  }
  const over = judged.filter((r) => r.pass === false);
  const leaks = errors.filter((e) => e.startsWith("TEMP LEAK"));
  if (leaks.length) { process.stdout.write(`\nFAIL: ${leaks.join("; ")}\n`); process.exitCode = 1; }
  const have = fs.existsSync(BUDGETS) ? readBudgets() : null;
  const missing = JOURNEYS.filter((j) => (!ONLY || ONLY.includes(j.id)) && !have?.journeys[j.id]).map((j) => j.id);
  if (missing.length) process.stdout.write(`\nno budget for: ${missing.join(", ")} (npm run journeys -- --set-budgets)\n`);
  if (over.length) {
    process.stdout.write(`\nFAIL: over budget: ${over.map((r) => `${r.id} (${r.wallMs.toFixed(0)} ms wall vs ${r.wallLimit?.toFixed(0)}, ${r.cpuMs.toFixed(0)} ms CPU vs ${r.cpuLimit?.toFixed(0)}${r.ratio !== undefined ? `, ×${r.ratio.toFixed(2)} of its short twin vs ×${r.ratioLimit}` : ""})`).join("; ")}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`\nPASS: every measured journey is within budget (load ×${cal.load.toFixed(2)}${strict ? ", strict" : ""})\n`);
}

await main();
