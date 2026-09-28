/**
 * The LOOK harness (dev only, never shipped): photographs the REAL renderer over the canned rich
 * state in look/seed.ts, in both themes, at a fixed size — so a visual pass can be judged against
 * the look study instead of against an empty app.
 *
 *   node app/look/shoot.mjs [outDir] [width] [height]
 *
 * No Electron, no host, no window on the user's screen: Vite serves the renderer, seed.ts stands in
 * for the preload bridge, and headless Chromium takes the picture.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "bots-look"));
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);

fs.mkdirSync(out, { recursive: true });

const bundled = await build({ entryPoints: [path.join(appDir, "look", "seed.ts")], bundle: true, write: false, format: "iife", target: "esnext" });
const shim = bundled.outputFiles[0].text;

const vite = await createServer({
  configFile: path.join(appDir, "vite.config.ts"),
  root: path.join(appDir, "src", "renderer"),
  logLevel: "error",
  cacheDir: path.join(os.tmpdir(), "bots-look-vite"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
await vite.listen();
const url = vite.resolvedUrls?.local[0];
if (!url) throw new Error("vite did not report a URL");

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, bypassCSP: true, colorScheme: scheme, reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${scheme}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${scheme} console: ${m.text()}`); });
    await page.addInitScript(shim);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".chat-header", { timeout: 20_000 });
    await page.evaluate(() => window.__look?.typing());
    await page.waitForTimeout(1400); // every entrance and stagger has settled
    await page.screenshot({ path: path.join(out, `app-${scheme}.png`) });
    // Task 5: the panel starts closed, so a second shot opens it the way the user does (the header's
    // own toggle) so the panel's "sections by space" look is also on record.
    await page.evaluate(() => window.__look?.openPanel());
    await page.waitForTimeout(300); // panel content settles; its width never animates (Task 8)
    await page.screenshot({ path: path.join(out, `app-${scheme}-panel.png`) });
    // bug 198: a third shot — the Q3 activity group's steps open, and its long Read step's own body
    // expanded — proves the step-body card (StepBody.tsx) next to the fenced-block one bug 193 shot.
    await page.evaluate(() => window.__look?.openSteps());
    await page.waitForTimeout(300); // .steps mounts and its entrance stagger settles
    await page.evaluate(() => window.__look?.expandStepBody());
    await page.waitForTimeout(300); // the step-body card mounts
    await page.screenshot({ path: path.join(out, `steps-${scheme}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
if (errors.length) console.error(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`shot ${width}x${height} -> ${out}`);
