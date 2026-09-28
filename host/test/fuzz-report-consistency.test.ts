import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Task 34, fix round 1, finding 1: SUMMARY.md's severity counts must match
// the findings.json artifact it summarizes.
// test-reports/ stays in the private working repo (docs/public-repo-exclude.md), so a public checkout skips this.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const reportDir = path.join(repoRoot, "test-reports/fuzz/2026-09-19-p5");
describe.skipIf(!existsSync(reportDir))("phase 5 fuzz report consistency (Task 34 fix round 1, finding 1)", () => {

  it("SUMMARY.md's medium/low counts match findings.json", () => {
    const findings = JSON.parse(
      readFileSync(path.join(reportDir, "findings.json"), "utf8"),
    ) as Array<{ severity: string }>;
    const mediumCount = findings.filter((f) => f.severity === "medium").length;
    const lowCount = findings.filter((f) => f.severity === "low").length;
    const total = findings.length;

    expect(mediumCount).toBe(66);
    expect(lowCount).toBe(2);
    expect(total).toBe(68);

    const summary = readFileSync(path.join(reportDir, "SUMMARY.md"), "utf8");

    // The lede sentence.
    expect(summary).toContain(`${mediumCount} medium and ${lowCount} low findings`);
    // The severity table's "Final crawl" column for medium.
    expect(summary).toMatch(
      new RegExp(`\\| medium \\|[^|]*\\| ${mediumCount} \\(explained below\\) \\| 0 \\|`),
    );
    // The "Final crawl (Layer 1)" section prose.
    expect(summary).toContain(
      `The final crawl left ${mediumCount} medium and ${lowCount} low findings`,
    );

    // No stale "64" count should remain anywhere in the report.
    expect(summary).not.toMatch(/\b64\b/);
  });
});
