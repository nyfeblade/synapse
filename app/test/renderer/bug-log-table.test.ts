import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `docs/bug-log.md` is a Markdown table, and a bare `|` inside a cell silently ends that cell.
 *
 * It has happened three times, always the same way: a TypeScript union written in the description —
 * `SkillView[] | null`, `"loading" | "ready" | "failed"` — where the `|` is ordinary prose to the
 * writer and a column separator to the renderer. The row does not fail loudly; it renders with its
 * text sliced into the wrong columns and its Status and Where shifted off the end, so the log quietly
 * stops saying what it was written to say. Three of the four defects the loop's own bookkeeping has
 * produced were this one.
 *
 * Escape it as `\|`. Markdown renders that as a literal pipe inside the cell.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOG = path.join(repoRoot, "docs", "bug-log.md");

/** Cell separators are unescaped pipes; `\|` is content. */
const cellCount = (row: string): number => (row.match(/(?<!\\)\|/g) ?? []).length - 1;
const rows = (src: string): string[] => src.split("\n").filter((l) => /^\| \d+ \|/.test(l));

// The public repo leaves the working log out (docs/public-repo-exclude.md, bug 298): nothing to check there.
describe.skipIf(!fs.existsSync(LOG))("docs/bug-log.md stays a readable table", () => {
  const src = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";

  it("finds rows to check at all (the guard's own smoke test)", () => {
    // A zero here would make every assertion below pass vacuously.
    expect(rows(src).length).toBeGreaterThan(10);
  });

  it("every bug row has exactly five cells — # | Found | What happens | Status | Where", () => {
    const broken = rows(src)
      .map((r) => ({ n: r.split("|")[1]?.trim(), cells: cellCount(r) }))
      .filter((r) => r.cells !== 5);
    expect(broken, `escape any \\| inside a cell:\n  ${broken.map((b) => `row ${b.n}: ${b.cells} cells`).join("\n  ")}`).toEqual([]);
  });

  it("no two rows share a number", () => {
    // Four collisions so far: concurrent agents each append "the next number" against the same base,
    // and neither sees the other's row until the merge. The merge resolves the text, not the numbering.
    const nums = rows(src).map((r) => r.split("|")[1]!.trim());
    const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
    expect([...new Set(dupes)], "two bugs cannot share a row number").toEqual([]);
  });

  it("rejects a bare pipe and accepts an escaped one (self-test)", () => {
    expect(cellCount("| 9 | 2026-01-01 | a `T \\| null` union | open | `x.ts` |")).toBe(5);
    expect(cellCount("| 9 | 2026-01-01 | a `T | null` union | open | `x.ts` |")).toBe(6);
  });
});
