/**
 * Vitest setupFile for every project (host, app, shared): each test file runs with a fresh, empty temp
 * HOME, so `~`, `$HOME`, `os.homedir()` and `os.userInfo().homedir` can never reach the developer's real
 * home (bug-log 436). Listed FIRST in setupFiles, so it runs before any other setup or test module loads.
 *
 * - HOME and USERPROFILE point at the temp home; XDG_* move inside it; env vars that aim a tool straight
 *   at a real-home folder (CLAUDE_CONFIG_DIR, CODEX_HOME, GIT_CONFIG_GLOBAL, …) are removed.
 * - os.homedir() already reads HOME; it is wrapped anyway so a test that deletes HOME still gets the temp
 *   home, not the passwd entry. os.userInfo().homedir (the passwd entry) is wrapped the same way. Named
 *   ESM imports (`import { homedir } from "node:os"`) see both through syncBuiltinESMExports.
 * - Shells a test spawns inherit HOME, so `sh -c "rm -rf ~/x"` expands into the temp home.
 * - The temp home is removed when the file ends. PATH is left alone (node itself may live in the home).
 * - The only way back to the real home is realHomeForTest(reason) in scripts/test-home.ts.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { HOME_REDIRECT_VARS, REAL_HOME_KEY, XDG_VARS } from "./test-home";

type Originals = { homedir: typeof os.homedir; userInfo: typeof os.userInfo; real: string; homes: Set<string> };
const G = globalThis as Record<symbol, unknown>;
const ORIG = Symbol.for("synapse.test.homeOriginals");

// Once per worker process: keep the real functions (every later test file in this worker reuses them,
// so the wrappers never stack) and remove any temp home a file left when the worker ends.
let o = G[ORIG] as Originals | undefined;
if (!o) {
  o = { homedir: os.homedir, userInfo: os.userInfo, real: os.userInfo().homedir, homes: new Set() };
  G[ORIG] = o;
  const sweep = () => { for (const h of o!.homes) try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once("exit", sweep);
  process.once("SIGTERM", () => {
    sweep();
    if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
  });
  const orig = o;
  const current = () => process.env.HOME || orig.homes.values().next().value || "/nonexistent-test-home";
  os.homedir = () => current();
  os.userInfo = ((opts?: { encoding: BufferEncoding | "buffer" }) => {
    const info = orig.userInfo(opts as { encoding: BufferEncoding });
    return { ...info, homedir: opts?.encoding === "buffer" ? Buffer.from(current()) : current() };
  }) as typeof os.userInfo;
  syncBuiltinESMExports();
}
G[REAL_HOME_KEY] = o.real;

// The system temp dir, before setup-tmpdir.ts moves TMPDIR. The run id prefix lets the disk guard count a leak.
const run = process.env.SYNAPSE_TEST_RUN_ID;
const home = fs.mkdtempSync(path.join(os.tmpdir(), run ? `vt-${run}-h` : "vt-h"));
for (const h of o.homes) try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
o.homes.clear();
o.homes.add(home);

process.env.HOME = home;
process.env.USERPROFILE = home;
for (const v of XDG_VARS) process.env[v] = path.join(home, v === "XDG_CONFIG_HOME" ? ".config" : v === "XDG_DATA_HOME" ? ".local/share" : v === "XDG_CACHE_HOME" ? ".cache" : ".local/state");
for (const v of HOME_REDIRECT_VARS) delete process.env[v];

afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the exit sweep retries */ }
  // A home a test chmod'ed read-only is left to the exit sweep.
  if (!fs.existsSync(home)) o!.homes.delete(home);
});
