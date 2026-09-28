import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file gets its own temp root, removed when the file ends. os.tmpdir() reads TMPDIR on each call,
 * so every mkdtemp(os.tmpdir(), …) in a test or helper lands here and no run leaves temp dirs behind (a full run
 * used to leave ~1,500 dirs, ~350 MB). The root stays short: some tests bind unix sockets inside it (104-byte cap).
 */
const base = os.tmpdir();
let root = "";

function chmodTree(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return;
    fs.chmodSync(p, 0o700);
    for (const e of fs.readdirSync(p)) chmodTree(path.join(p, e));
  } catch { /* best effort */ }
}

function cleanup(): void {
  if (!root) return;
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    chmodTree(root); // a test left a read-only dir behind
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
}

// Made when this setup file loads, before the test file is collected: a helper called in a describe body
// or at module scope (walls.test.ts's tmpConfig()) used to run before a beforeAll and leak into the system
// temp dir (bug-log 128). A fully skipped file runs no afterAll: the exit hooks remove its root. Vitest ends
// a fork worker with SIGTERM, which skips "exit" handlers, so SIGTERM cleans up and is then re-raised with
// its default action (the worker still dies exactly as before).
// The run id (scripts/vitest-disk-guard.ts) marks this run's roots, so the guard can count its own leaks.
const run = process.env.SYNAPSE_TEST_RUN_ID;
root = fs.mkdtempSync(path.join(base, run ? `vt-${run}-` : "vt-"));
process.env.TMPDIR = root;
afterAll(() => { process.env.TMPDIR = base; cleanup(); });
process.once("exit", cleanup);
process.once("SIGTERM", () => {
  cleanup();
  if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
});
