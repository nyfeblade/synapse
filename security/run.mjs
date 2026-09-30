// `npm run security-suite [-- --with-model] [-- --release 0.1.4]`
//
// Runs Synapse's published security scenarios (host/security/scenarios.ts) through the real code with no model, no
// API key and no network, then writes security/results/<version>.md and .json. `--with-model` adds the optional
// tier: the approval eval's must-block cases through the real AI reviewer, when one is configured (see README.md).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvalOutput, releaseVersion, renderMarkdown, summarize } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const withModel = args.includes("--with-model");
const ri = args.indexOf("--release");
const version = ri >= 0 && args[ri + 1] ? args[ri + 1] : releaseVersion(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
if (!/^[\w.-]{1,40}$/.test(version)) { console.error(`security-suite: not a version: ${version}`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "security-suite-"));
try {
  // ---- the deterministic tier: one vitest file, the same one CI runs ----
  const json = path.join(tmp, "results.json");
  console.log("security-suite: running the scenarios (no model, no API key, no network)…");
  const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(process.execPath, [vitest, "run", "--project", "host", "host/test/security/security-suite.test.ts", "--reporter=dot"], {
    cwd: root, stdio: "inherit", env: { ...process.env, SECURITY_SUITE_JSON: json },
  });
  if (!fs.existsSync(json)) { console.error("security-suite: the scenarios didn't produce results (see the output above)."); process.exit(run.status || 1); }
  const results = JSON.parse(fs.readFileSync(json, "utf8"));

  // ---- the optional model tier ----
  const model = withModel ? modelTier(tmp) : { status: "skipped", reason: "Not requested. Run `npm run security-suite -- --with-model` to include it." };

  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || null;
  const report = {
    version, date: new Date().toISOString().slice(0, 10), commit, node: process.versions.node, platform: `${process.platform}-${process.arch}`,
    summary: summarize(results), scenarios: results.filter((r) => r.category !== "control"), controls: results.filter((r) => r.category === "control"), model,
  };
  const dir = path.join(here, "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${version}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `${version}.md`), renderMarkdown(report));

  const s = report.summary;
  console.log("");
  console.log(`security-suite ${version}: ${s.passed} of ${s.total} attacks stopped; controls ${s.controls.passed} of ${s.controls.total}.`);
  for (const c of s.byCategory) console.log(`  ${c.name.padEnd(40)} ${c.passed}/${c.total}`);
  for (const r of report.scenarios.filter((x) => !x.pass)) console.log(`  FAIL ${r.id}: ${r.attack}\n       ${r.actual}`);
  console.log(`  Model tier: ${model.status}${model.reason ? ` (${model.reason})` : ""}`);
  console.log(`Wrote security/results/${version}.md and .json`);
  const ok = s.failed.length === 0 && s.controls.passed === s.controls.total && model.status !== "failed";
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/**
 * The approval eval (host/evals/reviewer/run.ts), must-block cases only, one run. Configured means one of:
 *   EVAL_LOCAL_CLI=1        your local `claude` CLI and its own sign-in (a developer machine);
 *   ANTHROPIC_API_KEY=…     an API key, used through the local `claude` CLI;
 *   SYNAPSE_EVAL_SAVED_KEY=1 the host's saved key, inside the Bots' computer.
 * Anything else is skipped, and the report says so.
 */
function modelTier(scratch) {
  const local = process.env.EVAL_LOCAL_CLI === "1";
  const key = !!process.env.ANTHROPIC_API_KEY;
  const saved = process.env.SYNAPSE_EVAL_SAVED_KEY === "1";
  if (!local && !key && !saved) return { status: "skipped", reason: "No model is configured: set ANTHROPIC_API_KEY, EVAL_LOCAL_CLI=1 or SYNAPSE_EVAL_SAVED_KEY=1 (see security/README.md)." };
  const cli = local || key;
  if (cli && spawnSync(process.env.CLAUDE_BIN ?? "claude", ["--version"], { encoding: "utf8" }).status !== 0) {
    return { status: "skipped", reason: "The `claude` CLI isn't installed (or CLAUDE_BIN doesn't point at it), so the model tier can't run." };
  }
  const cases = fs.readFileSync(path.join(root, "host/evals/reviewer/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ids = cases.filter((c) => c.mustBlock).map((c) => c.id);
  console.log(`security-suite: model tier: building the approval eval, then ${ids.length} must-block cases (and their Full-auto twins)…`);
  const build = spawnSync(process.execPath, [path.join(root, "host/build.mjs")], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) return { status: "failed", reason: `The eval didn't build: ${(build.stderr || build.stdout).slice(0, 300)}`, cases: [] };
  const env = { ...process.env, EVAL_RUNS: "1", EVAL_ONLY: `^(${ids.join("|")})(-FA)?$`, ...(cli ? { EVAL_LOCAL_CLI: "1" } : {}), ...(key && !local ? { EVAL_USE_API_KEY: "1" } : {}), TMPDIR: scratch };
  const r = spawnSync(process.execPath, [path.join(root, "host/dist/eval-reviewer.mjs")], { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  const got = parseEvalOutput(`${r.stdout}\n${r.stderr}`).filter((c) => c.expected === "block");
  if (!got.length) return { status: "failed", reason: `The eval produced no results: ${(r.stderr || r.stdout).slice(0, 300)}`, cases: [] };
  const via = local ? "your local claude sign-in" : key ? "your API key, through the claude CLI" : "the host's saved key";
  return { status: got.every((c) => c.pass) ? "passed" : "failed", via, cases: got };
}
