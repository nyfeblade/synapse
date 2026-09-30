// Battle plan 5.5: the security suite's report (security/report.mjs) and the website's draft /security-tests page.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script, no types
import { parseEvalOutput, releaseVersion, renderMarkdown, summarize, versionKey } from "../../security/report.mjs";
// @ts-expect-error plain ESM build script, no types
import { build, loadSecurityResults, renderSecurity, PAGES, DRAFT_PAGES } from "../../site/build.mjs";

const r = (id: string, category: string, pass = true, outcome = "ask") => ({ id, category, categoryName: category === "control" ? "Controls" : `Cat ${category}`, attack: `Attack ${id} | pipe`, expected: "Stopped", layer: "gate", outcome, actual: `Result ${id}`, pass, ms: 1 });

describe("security report", () => {
  it("files a run under the next version while the CHANGELOG leads with Unreleased", () => {
    expect(releaseVersion("# C\n\n## Unreleased\n\n- x\n\n## 0.1.3 — 2026-09-29\n\n## 0.1.2 — 2026-09-29\n")).toBe("0.1.4");
    expect(releaseVersion("## 0.2.0 — Unreleased\n\n## 0.1.9 — 2026-09-29\n")).toBe("0.2.0");
    expect(releaseVersion("## 0.1.3 — 2026-09-29\n")).toBe("0.1.3");
    expect(releaseVersion(fs.readFileSync(path.join(__dirname, "../../CHANGELOG.md"), "utf8"))).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionKey("0.1.10") > versionKey("0.1.9")).toBe(true);
  });

  it("reads the approval eval's per-case lines, errors included", () => {
    const out = "E05 block (expected block) stage=floor\n  E05: expected stage floor, got model\nE08 allow (expected block) stage=model · fine\nE09 block (expected block) stage=model ERROR boom\nrun 1: 2/3 correct";
    expect(parseEvalOutput(out)).toEqual([
      { id: "E05", decision: "block", expected: "block", error: false, pass: true },
      { id: "E08", decision: "allow", expected: "block", error: false, pass: false },
      { id: "E09", decision: "block", expected: "block", error: true, pass: false },
    ]);
  });

  it("counts attacks by category apart from the controls, and names every failure in the Markdown", () => {
    const results = [r("A-1", "a"), r("A-2", "a", false, "allow"), r("B-1", "b"), r("C-1", "control", true, "allow")];
    const s = summarize(results);
    expect(s).toMatchObject({ total: 3, passed: 2, failed: ["A-2"], controls: { total: 1, passed: 1 } });
    expect(s.byCategory).toEqual([{ category: "a", name: "Cat a", total: 2, passed: 1 }, { category: "b", name: "Cat b", total: 1, passed: 1 }]);
    const md = renderMarkdown({ version: "9.9.9", date: "2026-09-30", commit: "abc1234", node: "24", platform: "darwin-arm64", summary: s, scenarios: results.filter((x) => x.category !== "control"), model: { status: "skipped", reason: "No model is configured." } });
    expect(md).toContain("**2 of 3 attacks stopped.** Not stopped: A-2.");
    expect(md).toContain("| A-2 | Attack A-2 \\| pipe | Stopped | **FAIL**: Result A-2 | gate |");
    expect(md).toContain("## Cat a");
    expect(md).toContain("Skipped. No model is configured.");
  });
});

describe("the draft /security-tests page", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "site-sec-"));
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  it("is built from the newest results file, noindex, out of the sitemap and linked from no other page", () => {
    const dist = build("2026-09-30", out);
    const html = fs.readFileSync(path.join(dist, "security-tests.html"), "utf8");
    const latest = loadSecurityResults();
    expect(latest).not.toBeNull();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`<b>${latest.summary.passed} of ${latest.summary.total}</b> attacks stopped`);
    for (const s of latest.scenarios) expect(html).toContain(`<span class="id">${s.id}</span>`);
    expect(html).not.toContain("<!--SECURITY");
    expect(html).toMatch(/\/assets\/site\.[0-9a-f]{10}\.css/);
    expect(fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8")).not.toContain("security-tests");
    expect(Object.values(PAGES).map((p) => (p as { path: string }).path)).not.toContain(DRAFT_PAGES.security.path);
    for (const f of fs.readdirSync(dist).filter((x) => x.endsWith(".html") && x !== "security-tests.html")) expect(fs.readFileSync(path.join(dist, f), "utf8"), f).not.toContain('href="/security-tests"');
  });

  it("says there are no results yet when there are none, and escapes what it shows", () => {
    const tpl = "<!--SECURITY:TOC--><!--SECURITY:SUMMARY--><!--SECURITY:BODY-->";
    expect(renderSecurity(tpl, null)).toContain("No results yet");
    const report = { version: "1.0.0", date: "2026-09-30", summary: { total: 1, passed: 1, failed: [], byCategory: [{ category: "a", name: "A <b>", total: 1, passed: 1 }] }, scenarios: [{ ...r("X-1", "a"), attack: "<script>x</script>" }], model: { status: "skipped" } };
    const html = renderSecurity(tpl, report);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
