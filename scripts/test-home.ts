/**
 * The test suite never sees the developer's real home folder (bug-log 436).
 *
 * A test once ran `rm -rf ~/Downloads/<file>` through the real Mac gate: `~` was the owner's REAL home,
 * because only that one test file swapped HOME. scripts/vitest-test-home.ts (a setupFile in every
 * project) now gives each test file a fresh, empty home before any test module loads; this module holds
 * the pieces it shares with the global guard (scripts/vitest-disk-guard.ts) and the one escape hatch.
 *
 * Only erasable TypeScript and node: imports (it is loaded by vitest's globalSetup as well).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the setup file leaves the real home for `realHomeForTest`. A global symbol, not an env var, so spawned processes never inherit it. */
export const REAL_HOME_KEY = Symbol.for("synapse.test.realHome");

/** Env vars that point a tool at a config folder in the home; each is moved into the test home. */
export const XDG_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
/** Env vars that point a tool straight at a folder in the real home; removed so the tool falls back to $HOME. */
export const HOME_REDIRECT_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GIT_CONFIG_GLOBAL", "ZDOTDIR", "GNUPGHOME"] as const;

/**
 * The escape hatch: the developer's real home, for a test that must read what is installed on this Mac
 * (the claude login, a downloaded model). Opt-in live and native tests only, each with its reason. Never
 * write under it. Throws outside a test worker.
 */
export function realHomeForTest(reason: string): string {
  if (!reason.trim()) throw new Error("realHomeForTest: say why this test needs the real home");
  const real = (globalThis as Record<symbol, unknown>)[REAL_HOME_KEY];
  if (typeof real !== "string" || !real) throw new Error("realHomeForTest: the test home setup (scripts/vitest-test-home.ts) did not run");
  return real;
}

/** The real home as the passwd entry has it: HOME can already be a test home (a nested run), the account cannot. */
export function passwdHome(): string {
  return os.userInfo().homedir;
}

// ---- The global guard: the real home's sensitive folders, top level only. ----

/**
 * Folders a stray test is most likely to hit. `names` compares entry names only: a live app writes inside
 * those all the time (Claude Code in ~/.claude, a running Synapse in its own folder), so only an entry
 * disappearing counts there. `mtimes` also compares each top-level entry's mtime.
 */
export const GUARDED: { rel: string; check: "names" | "mtimes" }[] = [
  { rel: "Downloads", check: "mtimes" },
  { rel: "Desktop", check: "mtimes" },
  { rel: "Documents", check: "mtimes" },
  { rel: "Library/Application Support/Synapse", check: "names" },
  { rel: ".claude", check: "names" },
];

export type HomeSnapshot = Record<string, Record<string, number> | null>;

/** One readdir + one lstat per top-level entry. A folder we cannot read (no Full Disk Access) is skipped, not failed. */
export function snapshotHome(home: string): HomeSnapshot {
  const out: HomeSnapshot = {};
  for (const g of GUARDED) {
    const dir = path.join(home, g.rel);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (e) {
      out[g.rel] = (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
      continue;
    }
    const entries: Record<string, number> = {};
    for (const n of names) {
      if (g.check === "names") { entries[n] = 0; continue; }
      try { entries[n] = fs.lstatSync(path.join(dir, n)).mtimeMs; } catch { entries[n] = -1; }
    }
    out[g.rel] = entries;
  }
  return out;
}

/**
 * What a test could have broken, one line per entry; empty when nothing was. Only an entry that existed
 * before the run counts: removed, or (in an `mtimes` folder) rewritten. A new entry never fails the run,
 * so a download the owner makes mid-run is fine.
 */
export function homeChanges(before: HomeSnapshot, after: HomeSnapshot): string[] {
  const out: string[] = [];
  for (const g of GUARDED) {
    const a = before[g.rel], b = after[g.rel];
    if (!a || !b) continue; // unreadable on either side
    for (const n of Object.keys(a)) {
      if (!(n in b)) out.push(`removed  ~/${g.rel}/${n}`);
      else if (a[n] !== b[n]) out.push(`changed  ~/${g.rel}/${n}`);
    }
  }
  return out;
}

export function homeChangeMessage(home: string, changes: string[]): string | null {
  if (changes.length === 0) return null;
  const shown = changes.slice(0, 20).join("\n  ");
  return [
    `[home guard] The test run changed the REAL home folder (${home}). Tests must never touch it.`,
    `  ${shown}${changes.length > 20 ? `\n  … and ${changes.length - 20} more` : ""}`,
    "Every test file gets a temp HOME (scripts/vitest-test-home.ts). A test that reached the real home used a",
    "path from before the setup ran, the passwd entry, or a hard-coded /Users path. If you changed one of these",
    "folders yourself during the run, re-run to confirm (SYNAPSE_HOME_GUARD=warn reports without failing).",
  ].join("\n");
}
