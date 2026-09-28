/**
 * Living Bots in the REAL renderer (bug 226; dev only, never shipped): the look harness's canned state
 * (look/seed.ts), with each seed Bot put into a different living pose by the same SSE events the host
 * sends. Photographs the sidebar and header in both themes, catches a hand-off orb mid-flight, and
 * measures main-thread CPU per visible avatar over CDP.
 *
 *   node app/look/living-app.mjs [outDir]
 *
 * Writes app-light.png / app-dark.png, handoff-light.png / handoff-dark.png, reduced-motion.png and
 * cpu.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(appDir, "..", "test-reports", "living-avatars"));
const MEASURE_MS = Number(process.env.LIVING_MEASURE_MS ?? 10_000);
fs.mkdirSync(out, { recursive: true });

const bundled = await build({ entryPoints: [path.join(appDir, "look", "seed.ts")], bundle: true, write: false, format: "iife", target: "esnext" });
const shim = bundled.outputFiles[0].text;
const vite = await createServer({
  configFile: path.join(appDir, "vite.config.ts"), root: path.join(appDir, "src", "renderer"), logLevel: "error",
  cacheDir: path.join(os.tmpdir(), "bots-look-vite"), server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
await vite.listen();
const url = vite.resolvedUrls?.local[0];

/** Every seed Bot into a pose: write (open chat), think, needs-you, rest, run, read. */
const POSES = () => {
  const L = window.__look, now = Date.now();
  const tools = [{ tool: "Edit", detail: "q4-plan.md" }, { thinking: true }, null, null, { tool: "Bash", detail: "npm test" }, { tool: "Read", detail: "notes.md" }];
  L.agents().slice(0, 6).forEach((a, i) => {
    const agent = { ...a, updatedAt: i === 3 ? now - 3 * 3600_000 : now, lastBotMessageAt: i === 3 ? now - 3 * 3600_000 : now,
      running: i !== 2 && i !== 3, presence: i === 1 ? "thinking" : i === 2 || i === 3 ? "idle" : "working", activity: tools[i],
      marker: i === 2 ? "blocked" : i === 3 ? null : "working", awaiting: i === 2 ? { tabId: "auto-review", reason: "Send an iMessage?", since: now } : null };
    L.emit({ channel: "agent-upserted", payload: { agent } });
  });
};
const IDLE = () => {
  const L = window.__look, now = Date.now();
  L.agents().slice(0, 6).forEach((a) => L.emit({ channel: "agent-upserted", payload: { agent: { ...a, updatedAt: now, lastBotMessageAt: now, running: false, presence: "idle", activity: null, marker: null, awaiting: null } } }));
};

async function cpu(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
  const m = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const a = await m();
  await page.waitForTimeout(ms);
  const b = await m();
  await cdp.detach();
  const wall = (b.Timestamp - a.Timestamp) * 1000;
  return { mainThread: ((b.TaskDuration - a.TaskDuration) * 1000) / wall, scriptMs: (b.ScriptDuration - a.ScriptDuration) * 1000, wallMs: wall };
}
const visibleAvatars = (page) => page.evaluate(() => [...document.querySelectorAll("svg.face-avatar")].filter((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }).length);

const browser = await chromium.launch({ headless: true });
const result = {};
try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.addInitScript(shim);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".chat-header", { timeout: 20_000 });
    await page.evaluate(POSES);
    await page.mouse.move(700, 450);
    await page.waitForTimeout(2200);
    await page.screenshot({ path: path.join(out, `app-${scheme}.png`), clip: { x: 0, y: 0, width: 900, height: 420 } });
    // A hand-off from Chief of Staff (the open chat's header) to Otto (a sidebar row), caught mid-flight.
    await page.evaluate(() => {
      const [a, , , , otto] = window.__look.agents();
      window.__look.emit({ channel: "transcript", payload: { botId: a.id, op: "append", entry: { kind: "message", id: `h${Date.now()}`, role: "assistant", content: "Over to you", chainId: "c1", createdAt: Date.now(), toAgent: { id: otto.id, name: otto.profile.name, kind: "delegate" } } } });
    });
    await page.waitForTimeout(330);
    await page.screenshot({ path: path.join(out, `handoff-${scheme}.png`), clip: { x: 0, y: 0, width: 900, height: 420 } });
    await page.waitForTimeout(1500);
    if (scheme === "light") {
      // CPU: the pointer parked away from every avatar, every pose playing; then everyone idle.
      await page.mouse.move(1200, 780);
      await page.waitForTimeout(1500);
      const n = await visibleAvatars(page);
      const posed = await cpu(page, MEASURE_MS);
      await page.evaluate(IDLE);
      await page.waitForTimeout(2500);
      const idle = await cpu(page, MEASURE_MS);
      // The pointer moving through the sidebar (the gaze sweep on every frame).
      await page.evaluate(POSES);
      await page.waitForTimeout(1500);
      const cdpStart = cpu(page, 4000);
      for (let i = 0; i < 80; i++) { await page.mouse.move(40 + (i % 20) * 12, 120 + (i % 40) * 8); await page.waitForTimeout(45); }
      const pointer = await cdpStart;
      result.cpu = {
        visibleAvatars: n,
        posed: { ...posed, perAvatarPctOfCore: +(100 * posed.mainThread / n).toFixed(3) },
        idle: { ...idle, perAvatarPctOfCore: +(100 * idle.mainThread / n).toFixed(3) },
        pointerSweep: { ...pointer, perAvatarPctOfCore: +(100 * pointer.mainThread / n).toFixed(3) },
        note: "mainThread is the WHOLE renderer's busy fraction (one core = 1.0) in headless Chromium at 60 Hz, 2x DPR; per-avatar divides it all by the visible avatars, so it is an upper bound",
      };
    }
    await ctx.close();
  }
  // Reduced motion: the same poses, still.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript(shim);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".chat-header", { timeout: 20_000 });
  await page.evaluate(POSES);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, "reduced-motion.png"), clip: { x: 0, y: 0, width: 900, height: 420 } });
  await ctx.close();
} finally {
  await browser.close();
  await vite.close();
}
fs.writeFileSync(path.join(out, "cpu.json"), JSON.stringify(result.cpu, null, 1));
console.log(JSON.stringify(result.cpu, null, 1));
