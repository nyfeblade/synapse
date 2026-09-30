import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { budgetFrom, JOURNEYS, judge, type BudgetFile, type Sample } from "../../../scripts/journeys/budgets.ts";
import { writeReport, type HistoryRow } from "../../../scripts/journeys/report.ts";
import { calibrate, loadScaledBudget, median, quantile, type Calibration } from "../../../scripts/perf/robust-timing.ts";

/**
 * The cheap half of 5.9's gate, in `npm test`: every journey has a budget, the budget arithmetic judges medians the
 * load-robust way, and the dashboard renders. The journeys themselves launch Electron and take ~2 minutes, so they
 * are `npm run journeys` (scripts/journeys/README.md), which exits 1 on a regression.
 */
const budgets = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../scripts/journeys/budgets.json"), "utf8")) as BudgetFile;
const idle: Calibration = { wallMs: 14, cpuMs: 14, load: 1 };
const s = (wallMs: number, cpuMs = 5): Sample => ({ wallMs, cpuMs, longTasks: 0, longTaskMs: 0 });

describe("journey budgets", () => {
  it("every journey has a wall and a CPU budget, and there are 8-14 of them", () => {
    expect(JOURNEYS.length).toBeGreaterThanOrEqual(8);
    expect(JOURNEYS.length).toBeLessThanOrEqual(14);
    for (const j of JOURNEYS) {
      const b = budgets.journeys[j.id];
      expect(b, j.id).toBeDefined();
      expect(b!.wallMs, j.id).toBeGreaterThan(0);
      expect(b!.cpuMs, j.id).toBeGreaterThan(0);
    }
    expect(Object.keys(budgets.journeys).sort()).toEqual(JOURNEYS.map((j) => j.id).sort());
  });

  it("a budget is the median plus the margin, never tighter than median + floor", () => {
    expect(budgetFrom(8, 1.5, 30)).toBe(40);
    expect(budgetFrom(100, 1.5, 30)).toBe(150);
    expect(budgetFrom(1413, 1.25, 30)).toBe(1800);
  });

  it("judges the MEDIAN: one slow run does not fail a journey, a slow median does", () => {
    const b: BudgetFile = { ...budgets, calibration: { cpuMs: 14, wallMs: 14 }, journeys: { "switch-bot": { wallMs: 40, cpuMs: 35 } } };
    const ok = judge({ "switch-bot": [s(8), s(9), s(400), s(7), s(10)] }, idle, b, false);
    expect(ok[0]!.pass).toBe(true);
    const slow = judge({ "switch-bot": [s(60), s(61), s(9), s(70), s(55)] }, idle, b, false);
    expect(slow[0]!.pass).toBe(false);
    const cpu = judge({ "switch-bot": [s(8, 50), s(9, 60), s(7, 55)] }, idle, b, false);
    expect(cpu[0]!.pass, "more CPU work fails even when wall time is fine").toBe(false);
  });

  it("stretches the wall limit by the measured load (capped at ×4), never the CPU limit", () => {
    const b: BudgetFile = { ...budgets, calibration: { cpuMs: 14, wallMs: 14 }, journeys: { "switch-bot": { wallMs: 40, cpuMs: 35 } } };
    const loaded: Calibration = { wallMs: 42, cpuMs: 14, load: 3 };
    const r = judge({ "switch-bot": [s(100), s(110), s(90)] }, loaded, b, false)[0]!;
    expect(r.wallLimit).toBe(120);
    expect(r.pass).toBe(true);
    expect(r.cpuLimit).toBe(35);
    expect(judge({ "switch-bot": [s(100), s(110), s(90)] }, loaded, b, true)[0]!.pass, "--strict judges raw wall time").toBe(false);
    expect(loadScaledBudget(40, { wallMs: 140, cpuMs: 14, load: 10 })).toBe(160);
  });

  it("bug 442: the long-chat journeys are judged against their short twins in the same run (≤ ×1.5)", () => {
    expect(budgets.relative?.["long-reply"]).toEqual({ of: "first-reply", max: 1.5 });
    expect(budgets.relative?.["long-approve"]).toEqual({ of: "approve-card", max: 1.5 });
    for (const [id, r] of Object.entries(budgets.relative ?? {})) {
      expect(JOURNEYS.some((j) => j.id === id), id).toBe(true);
      expect(JOURNEYS.some((j) => j.id === r.of), r.of).toBe(true);
    }
    const b: BudgetFile = { ...budgets, journeys: { "first-reply": { wallMs: 170, cpuMs: 150 }, "long-reply": { wallMs: 170, cpuMs: 150 } }, relative: { "long-reply": { of: "first-reply", max: 1.5 } } };
    const near = judge({ "first-reply": [s(70), s(72)], "long-reply": [s(95), s(93)] }, idle, b, false).find((r) => r.id === "long-reply")!;
    expect(near.pass).toBe(true);
    const grown = judge({ "first-reply": [s(70), s(72)], "long-reply": [s(140), s(150)] }, idle, b, false).find((r) => r.id === "long-reply")!;
    expect(grown.pass, "within its own budget but 2× its short twin").toBe(false);
  });

  it("calibration and quantiles", () => {
    const c = calibrate(3);
    expect(c.cpuMs).toBeGreaterThan(0);
    expect(c.load).toBeGreaterThanOrEqual(1);
    expect(median([5, 1, 3])).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it("the dashboard: a markdown table and a self-contained HTML page with a sparkline per journey", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journeys-report-"));
    const row = (at: string, wall: number): HistoryRow => ({
      at, commit: "abc1234", branch: "t", runs: 5, strict: false, calibration: { cpuMs: 14, wallMs: 14, load: 1 },
      journeys: judge({ "switch-bot": [s(wall)], "cold-start": [s(1400, 120)] }, idle, budgets, false),
    });
    const out = writeReport([row("2026-09-29T10:00:00.000Z", 8), row("2026-09-30T10:00:00.000Z", 60)], dir);
    const md = fs.readFileSync(out.md, "utf8");
    const html = fs.readFileSync(out.html, "utf8");
    expect(path.basename(out.md)).toBe("2026-09-30.md");
    expect(md).toContain("| Switch Bot (`switch-bot`) | 60.0 ms |");
    expect(md).toContain("OVER");
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).not.toMatch(/<script|https?:\/\//);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
