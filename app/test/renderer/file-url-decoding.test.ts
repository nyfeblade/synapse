import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `new URL(import.meta.url).pathname` is PERCENT-ENCODED. A space is `%20`, and every path built
 * from it lands somewhere that does not exist the moment a directory in it has a space.
 *
 * Found in the worktree this repo's own agents run in: they live under `.../My Project/...`, so
 * `box-lifecycle.test.ts` resolved `/Users/alex/Project%201/...` and failed two tests that pass
 * on the normal checkout. It reads as an environment flake — "passes on main, fails in a worktree" —
 * which is exactly the shape that gets a real defect written off. It also means the repo's own rule
 * of giving each concurrent agent an isolated worktree silently broke part of its test suite.
 *
 * `fileURLToPath` is the API that decodes, and it is also the one that is correct on Windows.
 */
const ROOTS = ["app", "host", "shared", "box", "scripts"];
const EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "dist-release" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (EXT.has(path.extname(e.name))) yield full;
  }
}

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const sources = ROOTS.flatMap((r) => [...walk(path.join(repoRoot, r))]);

/**
 * `.pathname` read off a FILE url specifically.
 *
 * The first draft of this rule matched any `new URL(...).pathname` and flagged three correct sites:
 * an https attachment URL that already calls `decodeURIComponent`, a webhook URL, and
 * `new URL(req.url, "http://x")`. On an http URL `.pathname` is the right API and none of this
 * rule's business — percent-decoding there would corrupt a legitimately encoded query path. A guard
 * that fires on correct code gets an allowlist bolted on within a week, and then it guards nothing.
 */
const UNDECODED = /new URL\(\s*import\.meta\.url\s*\)\.pathname|new URL\(\s*["'`]file:[^)]*\)\.pathname|import\.meta\.url\s*\)?\s*\.pathname/;

describe("a path built from import.meta.url must be decoded", () => {
  it("finds source files to check at all (the guard's own smoke test)", () => {
    // A zero from a search is a claim about the pattern, not about the code. If the walk breaks,
    // every assertion below passes vacuously and the guard silently stops guarding.
    expect(sources.length).toBeGreaterThan(200);
  });

  it("no file reads .pathname off a file URL — use fileURLToPath, which decodes %20", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      // This file holds the forbidden shapes as test DATA, in the two self-tests below. Those are
      // what verify the pattern; scanning them would just make the guard flag itself forever.
      if (path.resolve(file) === path.resolve(__filename)) continue;
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (UNDECODED.test(line)) offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
      });
    }
    expect(offenders, `use fileURLToPath(import.meta.url) instead:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("rejects the exact shape that failed, and accepts the fix (self-test)", () => {
    expect(UNDECODED.test(`path.dirname(new URL(import.meta.url).pathname)`)).toBe(true);
    expect(UNDECODED.test(`const d = new URL("file:///tmp/a b/c.ts").pathname;`)).toBe(true);
    expect(UNDECODED.test(`path.dirname(fileURLToPath(import.meta.url))`)).toBe(false);
  });

  it("does not fire on an http URL, where .pathname is the correct API (self-test)", () => {
    // These three are real lines from this repo that the first draft of the rule flagged. Each is
    // correct: on an http URL `.pathname` is right, and decoding it would corrupt a legitimately
    // encoded path. Pinned here so a future widening of the regex fails loudly instead of quietly
    // sending someone to "fix" working code.
    expect(UNDECODED.test(`decodeURIComponent(new URL(url).pathname.split("/").pop() || "file")`)).toBe(false);
    expect(UNDECODED.test(`new URL(routine.webhook!.url).pathname.split("/").pop()`)).toBe(false);
    expect(UNDECODED.test(`const p = new URL(req.url!, "http://x").pathname;`)).toBe(false);
  });

  it("a decoded path survives a directory with a space, an undecoded one does not", () => {
    const spaced = new URL("file:///tmp/My Project/box-lifecycle.test.ts");
    expect(spaced.pathname).toContain("%20");
    expect(decodeURIComponent(spaced.pathname)).toBe("/tmp/My Project/box-lifecycle.test.ts");
  });
});
