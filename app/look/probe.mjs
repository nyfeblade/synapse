/** The LOOK harness's measuring tape: prints the box and type of every selector given on stdin.
 *  node app/look/probe.mjs "sel1,sel2,..."   (dev only; see shoot.mjs) */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sels = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dumpTree = process.argv[3] === "tree";

const bundled = await build({ entryPoints: [path.join(appDir, "look", "seed.ts")], bundle: true, write: false, format: "iife", target: "esnext" });
const vite = await createServer({ configFile: path.join(appDir, "vite.config.ts"), root: path.join(appDir, "src", "renderer"), logLevel: "error", cacheDir: path.join(os.tmpdir(), "bots-look-vite"), server: { host: "127.0.0.1", port: 0, hmr: false } });
await vite.listen();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, colorScheme: "dark" });
const page = await ctx.newPage();
await page.addInitScript(bundled.outputFiles[0].text);
await page.goto(vite.resolvedUrls.local[0], { waitUntil: "networkidle" });
await page.waitForSelector(".chat-header");
await page.evaluate(() => window.__look?.typing());
await page.waitForTimeout(900);
const out = await page.evaluate(([sels, dumpTree]) => {
  const lines = [];
  if (dumpTree) {
    const walk = (el, d) => {
      const r = el.getBoundingClientRect();
      lines.push(`${"  ".repeat(d)}${el.tagName.toLowerCase()}.${[...el.classList].join(".")} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]`);
      if (d < 6) for (const c of el.children) walk(c, d + 1);
    };
    walk(document.querySelector(".transcript"), 0);
  }
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)];
    if (!els.length) { lines.push(`${s}: ABSENT`); continue; }
    for (const el of els.slice(0, 3)) {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      lines.push(`${s}: ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)} | font ${c.fontWeight} ${c.fontSize}/${c.lineHeight} ${c.letterSpacing} | pad ${c.padding} | gap ${c.gap} | radius ${c.borderRadius} | border ${c.borderWidth} ${c.borderColor} | bg ${c.backgroundColor} | color ${c.color}`);
    }
  }
  return lines.join("\n");
}, [sels, dumpTree]);
console.log(out);
await browser.close();
await vite.close();
