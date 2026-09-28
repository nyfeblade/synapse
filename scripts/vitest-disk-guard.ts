/**
 * Vitest globalSetup for every project (root, host, app, shared): the temp-dir and disk guard (bug-log 128).
 *
 * Before the run: records the system temp dir's entry count and the free space, and refuses a full run
 * under 10 GB free. It also gives the run an id; each test file's temp root is `vt-<runId>-XXXXXX`
 * (setup-tmpdir.ts), so a root this run leaked is told apart from another worktree's run going on at
 * the same time.
 * After the run: counts what this run left behind — its own per-file roots still present, plus new
 * entries with one of our mkdtemp prefixes that escaped TMPDIR — and fails the run over 25.
 *
 * The root config and each project config all list this file; only the first to run in a process guards.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { freeBytes, isOurs, leftoverMessage, lowDiskRefusal, ourPatterns, repoRoot, systemTempDir } from "./tmp-hygiene";

const ACTIVE = "SYNAPSE_TMP_GUARD_ACTIVE";

export default function setup(): (() => void) | void {
  if (process.env[ACTIVE] === "1") return;
  process.env[ACTIVE] = "1";
  const dir = systemTempDir();
  const free = freeBytes(dir);
  const refusal = lowDiskRefusal(free, process.argv, process.env);
  if (refusal) { delete process.env[ACTIVE]; throw new Error(refusal); }
  const runId = randomBytes(3).toString("hex").slice(0, 4);
  process.env.SYNAPSE_TEST_RUN_ID = runId;
  const before = new Set(fs.readdirSync(dir));
  const patterns = ourPatterns(repoRoot());
  const t0 = Date.now();

  return () => {
    delete process.env[ACTIVE];
    delete process.env.SYNAPSE_TEST_RUN_ID;
    const now = fs.readdirSync(dir);
    const ownRoots = `vt-${runId}-`;
    const added = now.filter((n) => n.startsWith(ownRoots) || (!before.has(n) && !n.startsWith("vt-") && isOurs(n, patterns)));
    const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
    console.log(`[temp guard] ${dir}: ${before.size} entries before, ${now.length} after; this run left ${added.length}. Free: ${gb(free)} GB → ${gb(freeBytes(dir))} GB (${Math.round((Date.now() - t0) / 1000)} s).`);
    const msg = leftoverMessage(added, dir, patterns);
    if (msg) throw new Error(msg);
  };
}
