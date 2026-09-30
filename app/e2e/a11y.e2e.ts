import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { launch } from "./fuzz-helpers";
import { E2E_TEST_API_KEY } from "./onboarding";
import { test } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const OUT = path.join(REPO, "test-reports/a11y/latest");
const BASELINE = path.join(__dirname, "a11y-baseline.json");

// WCAG 2.0/2.1/2.2 A + AA only. `best-practice` is deliberately excluded: it is advisory, not a defect class,
// and mixing it in is how teams learn to ignore this report. No exclude()/disableRules() — the point of the
// sweep is the unfiltered list. docs/ui-audit-playbook.md explains what axe does and does not catch.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** AxeBuilder's default run assembles frame results in a fresh blank page, and Electron's CDP rejects
 *  Target.createTarget ("Protocol error (Target.createTarget): Not supported"). setLegacyMode runs axe
 *  entirely inside the page under test instead. The only thing legacy mode gives up is cross-origin iframe
 *  traversal; this app has no iframes and link-guard.e2e.ts proves it never navigates off its own page. */
const axe = (page: Page) => new AxeBuilder({ page }).setLegacyMode(true);

/** Kill transitions and animations for the whole sweep, before anything is scanned.
 *  app.css:542 puts `transition: ... color 120ms ease-out` on ~30 selectors. Forcing `data-theme` catches that
 *  transition mid-flight, and axe then reports contrast for colours that never settle. This is not theoretical:
 *  `.teach-pill` (now `.btn-compact`, bug 35) was reported at 1.03:1 (#fbfbfb on #ffffff) on one run
 *  and was clean on the next, while its settled colours are #0C0C0C on #ffffff (light) and #ededed on #0b0b0b (dark) — a false positive of exactly
 *  the kind docs/ui-audit-playbook.md says never to file. A sweep that reports animation timing as a defect
 *  gets ignored within a week. */
const freezeAnimations = (page: Page) =>
  page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

type Node = { target: string; summary: string };
type Finding = { surface: string; id: string; impact: string; help: string; helpUrl: string; nodes: Node[] };
type Baseline = {
  _README: string[];
  neverBaseline: { selector: string; why: string }[];
  entries: Record<string, { nodes: number; impact: string; help: string; note?: string }>;
};

const findings: Finding[] = [];
const surfaces: string[] = [];
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Baseline;
const key = (f: Finding) => `${f.surface} :: ${f.id}`;

/** Record a violation set against `surface`. Never throws: one verdict at the end of the spec beats stopping
 *  at the first bad surface, because a sweep that stops early hides the rest of the app (the fuzzing skill's
 *  "0 findings with tiny coverage" trap). */
function record(surface: string, violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): void {
  for (const v of violations) {
    findings.push({
      surface,
      id: v.id,
      impact: v.impact ?? "unknown",
      help: v.help,
      helpUrl: v.helpUrl,
      // Selector + failure summary is the repro trail; truncate the summary so the report stays readable.
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 240) })),
    });
  }
}

async function scan(page: Page, surface: string): Promise<void> {
  surfaces.push(surface);
  record(surface, (await axe(page).withTags(TAGS).analyze()).violations);
}

/** Contrast is the one rule class that is theme-dependent, so re-run colour-contrast alone per theme rather
 *  than re-running the whole ruleset three times. Restores the app's own theme when done. */
async function scanThemes(page: Page, surface: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(150);
    surfaces.push(`${surface} [${theme}]`);
    record(`${surface} [${theme}]`, (await axe(page).withRules(["color-contrast"]).analyze()).violations);
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

type Verdict = { failures: string[]; shrunk: string[]; baselined: number };

/** Compare this run against the debt ledger. Three ways to fail, and only three:
 *   1. a node matching `neverBaseline` — a plain bug someone decided must never be filed as debt;
 *   2. a surface/rule pair absent from the ledger — a new violation;
 *   3. more nodes than the ledger records for a pair — existing debt that grew.
 *  Fewer nodes than recorded is not a failure; it is reported so the ledger gets trimmed. */
function judge(): Verdict {
  const failures: string[] = [];
  const shrunk: string[] = [];
  let baselined = 0;
  const seen = new Map<string, number>();

  for (const f of findings) {
    const banned = f.nodes.filter((n) => baseline.neverBaseline.some((b) => n.target.includes(b.selector)));
    for (const n of banned) {
      const why = baseline.neverBaseline.find((b) => n.target.includes(b.selector))!.why;
      failures.push(`NEVER-BASELINED  ${f.surface} :: ${f.id} :: ${n.target} — ${why}`);
    }
    // Banned nodes are judged on their own and kept out of the counted total, so the ledger entry for the
    // rest of that surface still shrinks to zero when the token debt is paid.
    seen.set(key(f), (seen.get(key(f)) ?? 0) + f.nodes.length - banned.length);
  }

  for (const [k, count] of seen) {
    const entry = baseline.entries[k];
    if (count === 0) continue;
    if (!entry) { failures.push(`NEW  ${k} — ${count} node(s), not in the baseline`); continue; }
    baselined += count;
    if (count > entry.nodes) failures.push(`GREW  ${k} — ${count} node(s), baseline allows ${entry.nodes}`);
    else if (count < entry.nodes) shrunk.push(`${k} — ${count} node(s), baseline still records ${entry.nodes}`);
  }
  for (const k of Object.keys(baseline.entries)) {
    if (!seen.has(k) || seen.get(k) === 0) shrunk.push(`${k} — fixed, delete this entry from app/e2e/a11y-baseline.json`);
  }
  return { failures, shrunk, baselined };
}

function writeReport(v: Verdict): void {
  const bySeverity = (i: string) => findings.filter((f) => f.impact === i).length;
  const nodes = findings.reduce((n, f) => n + f.nodes.length, 0);
  const lines = [
    `# Accessibility sweep — ${new Date().toISOString()}`,
    "",
    `axe-core via @axe-core/playwright, tags: ${TAGS.join(", ")}.`,
    `${surfaces.length} surface passes, ${findings.length} violation groups / ${nodes} nodes: ` +
      `${bySeverity("critical")} critical, ${bySeverity("serious")} serious, ${bySeverity("moderate")} moderate, ${bySeverity("minor")} minor.`,
    `${v.baselined} node(s) recorded as known debt in app/e2e/a11y-baseline.json. ${v.failures.length} failure(s).`,
    "",
    "Automated rules cover roughly half of real accessibility defects and about a third of WCAG success",
    "criteria (see docs/ui-audit-playbook.md, Sources). A clean run here is a floor, not a pass.",
    "",
    "## Verdict",
    ...(v.failures.length ? v.failures.map((f) => `- FAIL ${f}`) : ["- No new or grown violations."]),
    ...(v.shrunk.length ? ["", "### Debt paid down — trim the baseline", ...v.shrunk.map((s) => `- ${s}`)] : []),
    "",
    "## Surfaces scanned",
    ...surfaces.map((s) => `- ${s}`),
    "",
    "## All findings (known debt included)",
  ];
  if (findings.length === 0) lines.push("None.");
  for (const f of findings) {
    lines.push(`\n### ${f.surface} — ${f.id} (${f.impact})`, f.help, f.helpUrl, ...f.nodes.map((n) => `- \`${n.target}\` — ${n.summary}`));
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify({ tags: TAGS, surfaces, verdict: v, findings }, null, 2) + "\n");
}

test("a11y: no new accessibility violations on any reachable surface", async () => {
  const { app, win } = await launch(`e2e-a11y-${Date.now()}`, { onboard: false });
  try {
    // Onboarding (ONB-01…05), scanned step by step: it is the only surface every first-run user must pass.
    await expect(win.getByRole("button", { name: "Add API key" })).toBeVisible({ timeout: 30_000 });
    await freezeAnimations(win);
    await scan(win, "onboarding/sign-in");
    await win.getByRole("button", { name: "Add API key" }).click();
    // synapse-public: the Anthropic API key is the only sign-in (a stand-in key; the fake brain never calls out).
    await win.getByLabel("Anthropic API key").fill(E2E_TEST_API_KEY);
    await scan(win, "onboarding/api-key");
    await win.getByRole("button", { name: "Save key" }).click();
    await expect(win.getByRole("heading", { name: "Meet Synapse" })).toBeVisible();
    await scan(win, "onboarding/meet-bots");
    for (let i = 0; i < 3; i++) await win.getByRole("button", { name: "Next" }).click();
    await scan(win, "onboarding/connectors");
    await win.getByRole("button", { name: "Next" }).click();
    await win.getByLabel("Name").fill("Auditor");
    await scan(win, "onboarding/first-bot");
    await win.getByRole("button", { name: "Get started" }).click();

    // Main window with a conversation open — the surface the user spends all day in.
    await expect(win.getByRole("link", { name: /Auditor/ }).first()).toBeVisible();
    await scan(win, "main/conversation");
    await scanThemes(win, "main/conversation");

    // Marketplace dialog + its Your plugins tab (PLG-01, PLG-04).
    await win.getByRole("button", { name: "Marketplace", exact: true }).click();
    const dlg = win.getByRole("dialog", { name: "Marketplace" });
    await expect(dlg).toBeVisible();
    await scan(win, "main/marketplace");
    await dlg.getByRole("link", { name: /^Your plugins/ }).click();
    await scan(win, "main/marketplace-your-plugins");
    await dlg.getByRole("button", { name: "Close Marketplace" }).click();

    // Command palette (PAL-04): a modal over the whole app, the classic focus-trap/contrast offender.
    await win.keyboard.press("Meta+k");
    await expect(win.getByRole("dialog", { name: "Search" })).toBeVisible();
    await scan(win, "main/palette");
    await win.keyboard.press("Escape");

    // Settings, reached the way a user reaches it.
    await win.getByRole("button", { name: "Open account menu" }).click();
    await win.getByRole("menuitem", { name: "Settings" }).click();
    await scan(win, "main/settings");
    await scanThemes(win, "main/settings");
  } finally {
    const verdict = judge();
    writeReport(verdict);
    await app.close();
    if (verdict.shrunk.length) console.log(`a11y debt paid down — trim app/e2e/a11y-baseline.json:\n  ${verdict.shrunk.join("\n  ")}`);
    expect(verdict.failures, `See test-reports/a11y/latest/report.md. Known debt is listed in app/e2e/a11y-baseline.json; it may shrink, never grow.`).toEqual([]);
  }
});
