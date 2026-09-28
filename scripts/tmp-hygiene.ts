/**
 * Test temp-dir hygiene (bug-log 128).
 *
 * The test suites once left ~700,000 temp dirs (183 GB) in the macOS per-user temp dir and filled the
 * disk to 0 bytes. Each test file now works inside its own temp root (host|app|shared/test/setup-tmpdir.ts);
 * this module is the backstop:
 *   - the vitest guard (scripts/vitest-disk-guard.ts) refuses a full run under 10 GB free and fails a
 *     run that leaves more than 25 new entries behind;
 *   - `npm run clean:tmp` (also run at the end of `npm test`) deletes OUR test temp entries that are
 *     over an hour old, and nothing else.
 *
 * "Ours" is derived from the code: every mkdtemp prefix in host/, app/, shared/ and scripts/, plus the
 * few fixed names tests write straight into the temp dir. Runs under plain `node` (type stripping), so
 * only erasable TypeScript here and only node: imports.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GUARD_MAX_NEW_ENTRIES = 25;
export const GUARD_MIN_FREE_BYTES = 10 * 1024 ** 3;
export const SWEEP_OLDER_THAN_MS = 3600_000;

export interface OurPatterns {
  /** mkdtemp prefixes with a fixed text: `<prefix><6 chars>`. */
  prefixes: string[];
  /** mkdtemp prefixes whose text continues with an interpolation: `<head>…<6 chars>`. */
  heads: string[];
  /** Fixed names tests write into the temp dir directly. */
  fixed: RegExp[];
}

const SCAN_DIRS = ["host", "app", "shared", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-release", "out", ".git", "test-results", "playwright-report"]);
const SCAN_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SUFFIX = /^[A-Za-z0-9]{6}$/;
// Test files that write fixed names straight into the temp dir (webhook-security, phase2 e2e).
const FIXED: RegExp[] = [/^victim-\d+-\d+$/, /^notes-\d+\.md$/];
// Vitest's own module cache dir: a 21-char nanoid holding only `ssr` (never removed by vitest).
const VITEST_DIR = /^[A-Za-z0-9_-]{21}$/;

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function* sourceFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(path.join(dir, e.name)); }
    else if (e.isFile() && SCAN_EXT.test(e.name)) yield path.join(dir, e.name);
  }
}

/** Every mkdtemp prefix in the code. The first string literal inside the call is the prefix (or the path ending in it). */
export function ourPatterns(root: string): OurPatterns {
  const prefixes = new Set<string>(["vt-"]); // the per-file roots (setup-tmpdir.ts), with or without a run id
  const heads = new Set<string>();
  const call = /mkdtemp(?:Sync)?\(([^;\n]{0,240})/g; // the call's own line, up to the statement's end
  const literal = /(["'`])((?:(?!\1)[^\\$])*)(\$\{)?/;
  for (const d of SCAN_DIRS) {
    for (const f of sourceFiles(path.join(root, d))) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("mkdtemp")) continue;
      for (const m of src.matchAll(call)) {
        const lit = literal.exec(m[1]!);
        if (!lit) continue;
        const text = path.posix.basename(lit[2]!.endsWith("/") ? "" : lit[2]!);
        if (text.length < 3 || !/^[A-Za-z0-9._-]+$/.test(text)) continue;
        (lit[3] ? heads : prefixes).add(text);
      }
    }
  }
  return { prefixes: [...prefixes].sort(), heads: [...heads].sort(), fixed: FIXED };
}

/** Whether a temp-dir entry name is one our tests make. (Vitest's nanoid dirs are checked by content in sweep.) */
export function isOurs(name: string, p: OurPatterns): boolean {
  for (const x of p.prefixes) if (name.startsWith(x) && SUFFIX.test(name.slice(x.length))) return true;
  for (const h of p.heads) if (name.startsWith(h) && name.length >= h.length + 7 && /[A-Za-z0-9]{6}$/.test(name)) return true;
  return p.fixed.some((r) => r.test(name));
}

/**
 * Exactly one child, `ssr`, and a nanoid-looking name (a digit, `_` or `-` in it). An EMPTY 21-char dir is
 * never ours: macOS keeps some (AudioConverterService, diagnosticextensionsd, mediaanalysisd-access).
 */
function isVitestCacheDir(full: string, name: string): boolean {
  if (!VITEST_DIR.test(name) || !/[0-9_-]/.test(name)) return false;
  try { const c = fs.readdirSync(full); return c.length === 1 && c[0] === "ssr"; } catch { return false; }
}

/** The name's prefix for the report (the longest matching one), or "(other)". */
export function prefixOf(name: string, p: OurPatterns): string {
  let best = "";
  for (const x of [...p.prefixes, ...p.heads]) if (name.startsWith(x) && x.length > best.length) best = x;
  if (best) return best;
  const fx = p.fixed.find((r) => r.test(name));
  if (fx) return name.replace(/\d+/g, "N");
  const m = /^(.*?[-_.])[A-Za-z0-9]{6}$/.exec(name);
  return m ? m[1]! : "(other)";
}

export function topPrefixes(names: string[], p: OurPatterns, n = 8): { prefix: string; count: number }[] {
  const c = new Map<string, number>();
  for (const name of names) { const k = prefixOf(name, p); c.set(k, (c.get(k) ?? 0) + 1); }
  return [...c.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)).slice(0, n);
}

/** The guard's failure message, or null when the run stayed within the cap. */
export function leftoverMessage(added: string[], dir: string, p: OurPatterns, max = GUARD_MAX_NEW_ENTRIES): string | null {
  if (added.length <= max) return null;
  const top = topPrefixes(added, p).map((t) => `  ${t.prefix} ×${t.count}`).join("\n");
  return [
    `Temp-dir guard: this test run left ${added.length} new entries in ${dir} (the cap is ${max}).`,
    "A suite that leaks temp dirs filled this Mac's disk once (183 GB, bug-log 128). Top prefixes:",
    top,
    "Make the test (or the helper) create its temp dirs under os.tmpdir() inside the test, or clean them up.",
    "`npm run clean:tmp` removes our test temp entries older than an hour.",
  ].join("\n");
}

const fmtGB = (b: number) => `${(Math.round((b / 1024 ** 3) * 10) / 10).toFixed(1)} GB`;

const VALUED_FLAGS = new Set(["--project", "--reporter", "--config", "-c", "--root", "-r", "--dir", "--pool", "--environment", "--outputFile", "--shard", "--sequence.seed", "--maxWorkers", "--minWorkers", "--testTimeout", "--mode", "--inspect-brk"]);
const FILTER_FLAGS = new Set(["-t", "--testNamePattern", "--changed", "--related"]);

/** A run with no file filter and no name filter (a whole project still counts: it is hundreds of files). */
export function isFullRun(argv: string[]): boolean {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "run" || a === "watch" || a === "dev") continue;
    if (FILTER_FLAGS.has(a) || [...FILTER_FLAGS].some((f) => a.startsWith(`${f}=`))) return false;
    if (VALUED_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return false; // a positional file filter
  }
  return true;
}

/** Why a full run must not start (free space under 10 GB), or null. SYNAPSE_ALLOW_LOW_DISK=1 overrides. */
export function lowDiskRefusal(freeBytes: number, argv: string[], env: Record<string, string | undefined>): string | null {
  if (freeBytes >= GUARD_MIN_FREE_BYTES || env.SYNAPSE_ALLOW_LOW_DISK === "1" || !isFullRun(argv)) return null;
  return [
    `Not starting the full test run: this Mac has only ${fmtGB(freeBytes)} free (the floor is ${fmtGB(GUARD_MIN_FREE_BYTES).replace(".0", "")}).`,
    "A full run writes thousands of temp dirs and SQLite files; on a nearly full disk tests fail in confusing ways and can take the Mac to 0 bytes free (bug-log 128).",
    "Free some space first — `npm run clean:tmp` removes old test temp entries — or run a single file, or set SYNAPSE_ALLOW_LOW_DISK=1 if you really mean it.",
  ].join("\n");
}

export function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

/** The OS temp dir tests write into by default (the macOS per-user one, whatever TMPDIR says now). */
export function systemTempDir(): string {
  if (process.platform === "darwin") {
    try {
      const d = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
      if (d) return path.resolve(d);
    } catch { /* fall through */ }
  }
  return path.resolve(os.tmpdir());
}

function isTempDir(dir: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const d = real(dir);
  if (d === "/" || d === real(os.homedir())) return false;
  return [systemTempDir(), "/tmp", "/private/tmp", process.env.TMPDIR ?? ""].filter(Boolean).map(real).includes(d);
}

function makeWritable(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return;
    fs.chmodSync(p, (st.mode & 0o7777) | 0o700); // chmod u+rwx: a read-only fixture dir can't be emptied otherwise
    for (const e of fs.readdirSync(p)) makeWritable(path.join(p, e));
  } catch { /* best effort */ }
}

function remove(p: string): boolean {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); } catch { makeWritable(p); try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); } catch { /* reported below */ } }
  return !fs.existsSync(p);
}

export interface SweepResult { removed: number; failed: number; failedNames: string[]; keptYoung: number; scanned: number }

/** Deletes our test temp entries in `dir` older than `olderThanMs`. Only direct children; never follows a symlink. */
export function sweep(o: { dir: string; patterns: OurPatterns; olderThanMs: number; now: number; allowAnyDir?: boolean }): SweepResult {
  if (!o.allowAnyDir && !isTempDir(o.dir)) throw new Error(`clean:tmp: ${o.dir} is not a temp dir; refusing to sweep it.`);
  const r: SweepResult = { removed: 0, failed: 0, failedNames: [], keptYoung: 0, scanned: 0 };
  const cutoff = o.now - o.olderThanMs;
  for (const name of fs.readdirSync(o.dir)) {
    r.scanned++;
    const full = path.join(o.dir, name);
    if (!isOurs(name, o.patterns) && !isVitestCacheDir(full, name)) continue;
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { continue; }
    // A vitest cache dir gains files inside `ssr` while its run lives (watch mode): judge it by that too.
    let mtime = st.mtimeMs;
    if (st.isDirectory() && VITEST_DIR.test(name)) { try { mtime = Math.max(mtime, fs.statSync(path.join(full, "ssr")).mtimeMs); } catch { /* no ssr */ } }
    if (mtime > cutoff) { r.keptYoung++; continue; }
    if (remove(full)) r.removed++; else { r.failed++; r.failedNames.push(name); }
  }
  return r;
}

// CLI: `npm run clean:tmp` (node scripts/tmp-hygiene.ts [--dry-run])
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = systemTempDir();
  const t0 = Date.now();
  const before = freeBytes(dir);
  const r = sweep({ dir, patterns: ourPatterns(repoRoot()), olderThanMs: SWEEP_OLDER_THAN_MS, now: t0 });
  const freed = Math.max(0, freeBytes(dir) - before);
  console.log(`clean:tmp: removed ${r.removed} test temp entr${r.removed === 1 ? "y" : "ies"} older than 1 h from ${dir} (${fmtGB(freed)} freed; kept ${r.keptYoung} newer; ${r.failed} failed) in ${Date.now() - t0} ms.`);
  if (r.failed > 0) { console.log(`clean:tmp: could not remove: ${r.failedNames.slice(0, 10).join(", ")}`); process.exitCode = 1; }
}
