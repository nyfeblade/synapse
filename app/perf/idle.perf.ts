import fs from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { startRig, type Rig } from "../motion/harness";

/**
 * THE IDLE-CPU GUARD (`npm run perf:idle -w @synapse/app`). Ten Bots in the sidebar, one chat open with a
 * finished reply, the header avatar, the pointer parked off every avatar, then nothing happens for
 * IDLE_MS. Main-thread busy time (CDP Performance.TaskDuration) over that window must stay under a
 * budget calibrated to catch a regression back to every avatar re-rendering every display frame
 * (Bug #100: ~48% of a core in the real app, idle).
 *
 * PERF_REPORT=1 prints without failing; PERF_PROFILE=1 adds a CPU profile's top self-time functions;
 * PERF_OUT=<file> keeps the numbers as JSON.
 */
const IDLE_MS = Number(process.env.PERF_IDLE_MS ?? 10_000);
const REPORT_ONLY = process.env.PERF_REPORT === "1";
/** Bots in the sidebar (PERF_BOTS, default 10). */
const BOTS = Math.min(10, Math.max(1, Number(process.env.PERF_BOTS ?? 10)));
// Budgets, calibrated on headless Chromium (60 Hz) with this scene (bug #100, 2026-09-21):
//   every avatar re-rendered every frame (the regression): main thread 0.159, 120 paints/s, 60 rAF/s;
//   the fix: main thread ~0.05, ~60 paints/s, 30 rAF/s.
/** Main-thread busy fraction while idle. */
const MAX_MAIN_THREAD = 0.12; // TaskDuration inflates on a loaded machine; the rAF budget below is the exact signal
/** Paints per second while idle. */
const MAX_PAINTS_PER_S = 90;
/** Animation-frame callbacks per second: the ambient cadence is 30; per-frame rendering is the display rate. */
const MAX_RAF_PER_S = 45;

test.describe.configure({ mode: "serial" });
let rig: Rig;
let page: Page;

test.beforeAll(async () => {
  rig = await startRig();
  page = rig.page;
  const names = ["Ada", "Bea", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo"].slice(0, BOTS);
  for (const n of names) await rig.call("createAgent", { name: n });
  await page.getByRole("link", { name: new RegExp(names[names.length - 1]!) }).first().waitFor({ timeout: 90_000 });
  await page.getByRole("link", { name: /Ada/ }).first().click({ timeout: 30_000 });
  const box = page.getByRole("textbox", { name: "Message Ada" });
  await box.waitFor({ timeout: 30_000 });
  await box.fill("hello there");
  await box.press("Enter");
  await page.waitForTimeout(6000); // the fake brain's reply streams and finishes
  await page.mouse.move(900, 700); // off every avatar
  if (process.env.PERF_SHOT) await page.screenshot({ path: process.env.PERF_SHOT });
});
test.afterAll(async () => { await rig?.close(); });

interface Idle { phases: string[]; mainThread: number; scriptMs: number; layouts: number; styles: number; paints: number; paintsPerS: number; commits: number; rafs: number; avatars: number; overlays: string[]; top?: string[] }

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const r = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}

async function measureIdle(ms: number): Promise<Idle> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
  const events: { name: string; dur?: number; ph?: string }[] = [];
  cdp.on("Tracing.dataCollected", (d) => { for (const e of d.value as unknown as typeof events) events.push(e); });
  const done = new Promise<void>((res) => cdp.once("Tracing.tracingComplete", () => res()));
  const profile = process.env.PERF_PROFILE === "1";
  if (profile) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"], excludedCategories: ["*"] } } as never);
  const a = await metrics(cdp);
  await page.waitForTimeout(ms);
  const b = await metrics(cdp);
  await cdp.send("Tracing.end");
  await done;
  let top: string[] | undefined;
  if (profile) {
    const { profile: p } = await cdp.send("Profiler.stop");
    const self = new Map<string, number>();
    const dt = p.timeDeltas ?? [];
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    (p.samples ?? []).forEach((id, i) => {
      const n = byId.get(id)!;
      const f = n.callFrame;
      const key = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/(src|node_modules)\//, "$1/").split("?")[0]}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    top = [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(1)}ms ${k}`);
  }
  await cdp.detach();
  const wall = (b.Timestamp! - a.Timestamp!) * 1000;
  const count = (n: string) => events.filter((e) => e.name === n).length;
  const paints = count("Paint");
  const by = new Map<string, number>();
  for (const e of events) if (e.ph === "X" && e.dur) by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
  const phases = [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${v.toFixed(0)}ms ${k}`);
  return {
    phases,
    mainThread: ((b.TaskDuration! - a.TaskDuration!) * 1000) / wall,
    scriptMs: (b.ScriptDuration! - a.ScriptDuration!) * 1000,
    layouts: b.LayoutCount! - a.LayoutCount!, styles: b.RecalcStyleCount! - a.RecalcStyleCount!,
    paints, paintsPerS: paints / (wall / 1000), commits: count("Commit"), rafs: count("FireAnimationFrame"),
    avatars: await page.locator("svg.face-avatar").count(),
    overlays: await page.evaluate(() => [...document.querySelectorAll<SVGSVGElement>("svg.face-avatar")].map((s) => `${s.getAttribute("class")}:${s.dataset.mouth ?? "-"}`)),
    top,
  };
}

test("idle: ten Bots, an open chat, nothing happening", async () => {
  await page.waitForTimeout(2000); // entry blinks and presence hops settle
  if (process.env.PERF_MUTATIONS === "1") {
    // Diagnostics: which avatar attributes change while idle (2 s of MutationObserver records).
    console.log(await page.evaluate(() => new Promise<string>((res) => {
      const svgs = [...document.querySelectorAll("svg.face-avatar")];
      const counts: Record<string, number> = {};
      const mo = new MutationObserver((recs) => { for (const r of recs) { const svg = (r.target as Element).closest("svg.face-avatar"); const k = `${svgs.indexOf(svg!)}:${(r.target as Element).getAttribute("data-part") ?? "svg"}.${r.attributeName ?? r.type}`; counts[k] = (counts[k] ?? 0) + 1; } });
      mo.observe(document.body, { subtree: true, attributes: true, childList: true });
      setTimeout(() => { mo.disconnect(); res(JSON.stringify(counts)); }, 2000);
    })));
  }
  const r = await measureIdle(IDLE_MS);
  console.log(JSON.stringify(r, null, 1));
  if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(r, null, 1));
  expect(r.avatars, "the scene has its avatars").toBeGreaterThanOrEqual(BOTS);
  if (REPORT_ONLY) return;
  expect(r.mainThread, "main-thread busy fraction while idle").toBeLessThan(MAX_MAIN_THREAD);
  expect(r.paintsPerS, "paints per second while idle").toBeLessThan(MAX_PAINTS_PER_S);
  expect(r.rafs / (IDLE_MS / 1000), "animation frames per second while idle").toBeLessThan(MAX_RAF_PER_S);
});
