/**
 * Full-size before/after pairs for review (dev only): the real renderer over look/seed.ts, 1440×900
 * at 1×, saved as JPEG (quality 85) so each picture is readable on its own.
 *
 *   node app/look/shoot-pairs.mjs <outDir> <before|after>
 *
 * Writes `<screen>-<dark|light>-<label>.jpg`. Run it once from a checkout without the change
 * ("before") and once with it ("after"), into the same folder.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? "pairs");
const label = process.argv[3] ?? "after";
fs.mkdirSync(out, { recursive: true });

const shim = (await build({ entryPoints: [path.join(appDir, "look", "seed.ts")], bundle: true, write: false, format: "iife", target: "esnext" })).outputFiles[0].text;
const vite = await createServer({
  configFile: path.join(appDir, "vite.config.ts"), root: path.join(appDir, "src", "renderer"), logLevel: "error",
  cacheDir: path.join(os.tmpdir(), `bots-look-vite-pairs-${label}`), server: { host: "127.0.0.1", port: 0, hmr: false },
});
await vite.listen();
const url = vite.resolvedUrls.local[0];

// A VNC endpoint that accepts the socket and never speaks: the stage stays "connecting".
const silent = http.createServer();
const wss = new WebSocketServer({ server: silent });
wss.on("connection", () => {});
await new Promise((r) => silent.listen(0, "127.0.0.1", r));
const silentPort = silent.address().port;

const entry = (id, name, description, state, action = "add", category = "Productivity") =>
  ({ id, kind: "plugin", source: "curated", name, description, category, logo: null, action, state });
const MARKET = {
  installed: { count: 3, logos: [{ name: "Linear", logo: null }, { name: "Notion", logo: null }, { name: "GitHub", logo: null }] },
  featuredBots: [], forYou: null, fromTeam: [],
  featuredPlugins: [
    entry("curated:linear", "Linear", "Issues, projects and cycles", "installed"),
    entry("curated:notion", "Notion", "Pages and databases", "needs-auth", "connect"),
    entry("curated:github", "GitHub", "Repos, pull requests and issues", "connected", "connect"),
    entry("curated:slack", "Slack", "Channels and messages", "available", "connect"),
    entry("curated:figma", "Figma", "Files and comments", "available"),
    entry("curated:stripe", "Stripe", "Payments and invoices", "available"),
    entry("curated:asana", "Asana", "Tasks and projects", "available"),
  ],
  categories: [{ name: "Data", total: 7, entries: ["Snowflake", "BigQuery", "Postgres", "Airtable", "Sheets", "Mode", "dbt"].map((n, i) => entry(`curated:d${i}`, n, `${n} queries and tables`, i === 1 ? "installed" : "available", "add", "Data")) }],
};

const wrap = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const b = window.synapse; const orig = b.call;
  b.call = async (cmd, args) => {
    if (cmd === "search") return { ok: true, result: { results: [] } };
    if (cmd === "getMarketplace") return { ok: true, result: ${JSON.stringify(MARKET)} };
    if (cmd === "searchCatalog") return { ok: true, result: { plugins: [], bots: [] } };
    if (cmd === "requestDisplay") return { ok: true, result: {} };
    if (mode === "connecting" && cmd === "getDisplays") return { ok: true, result: { displays: [{ botId: "bot-1", index: 1, display: ":1", cdpPort: 9222, running: true, generation: 1 }], waiting: [] } };
    if (mode === "empty" && cmd === "getAgentTranscriptTail") return { ok: true, result: { entries: [] } };
    if (mode === "empty" && (cmd === "listAgents" || cmd === "openAgent")) {
      const r = await orig(cmd, args); const idle = (a) => ({ ...a, presence: "idle", running: false, activity: null, marker: null });
      return cmd === "listAgents" ? { ok: true, result: { ...r.result, agents: r.result.agents.map((a, i) => (i === 0 ? idle(a) : a)) } } : { ok: true, result: { agent: idle(r.result.agent) } };
    }
    return orig(cmd, args);
  };
  if (mode === "connecting") b.vncUrl = () => "ws://127.0.0.1:${silentPort}/vnc";
})();`;

const browser = await chromium.launch({ headless: true });
const errors = [];

async function session(scheme, mode, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, bypassCSP: true, colorScheme: scheme, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(`${scheme}/${mode}: ${e.message}`));
  await page.addInitScript(shim);
  await page.addInitScript(wrap(mode));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".chat-header", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const shot = async (name) => {
    await page.screenshot({ path: path.join(out, `${name}-${scheme}-${label}.jpg`), type: "jpeg", quality: 85 });
    console.log("shot", name, scheme, label);
  };
  const step = async (name, f) => { try { await f(); } catch (e) { errors.push(`${scheme} ${name}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
  try { await fn(page, shot, step); } finally { await ctx.close(); }
}
const reset = async (page) => {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".chat-header", { timeout: 20000 });
  await page.waitForTimeout(1200);
};

try {
  for (const scheme of ["dark", "light"]) {
    await session(scheme, "rich", async (page, shot, step) => {
      await step("chat-idle", () => shot("chat-idle"));
      await step("chat-streaming", async () => { await page.evaluate(() => window.__look.typing()); await page.waitForTimeout(900); await shot("chat-streaming"); });
      await reset(page);
      await step("account-menu", async () => { await page.locator(".sidebar-account").click(); await page.waitForTimeout(500); await shot("sidebar-account-menu"); await page.keyboard.press("Escape"); await page.waitForTimeout(300); });
      await step("palette", async () => { await page.keyboard.press("Meta+k"); await page.waitForTimeout(450); await shot("palette"); await page.keyboard.press("Escape"); await page.waitForTimeout(300); });
      await step("settings", async () => {
        await page.keyboard.press("Meta+,");
        await page.waitForSelector(".settings-dialog", { timeout: 8000 });
        await page.waitForTimeout(700);
        await shot("settings-general");
        // The search field arrives with the polish pass; before it, this is the same dialog with no field.
        const search = page.locator(".settings-search input");
        if (await search.count()) { await search.fill("voice"); await page.waitForTimeout(300); }
        await shot("settings-search");
        await page.keyboard.press("Escape"); await page.waitForTimeout(200);
        if (await page.locator(".settings-dialog").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
      });
      await step("bot-panel", async () => {
        await page.locator(".chat-header").getByRole("button", { name: /^(Bot settings|Bot)$/ }).first().click();
        await page.waitForTimeout(600);
        await shot("bot-panel");
      });
      await reset(page);
      await step("connectors", async () => {
        await page.locator(".sidebar-account").click(); await page.waitForTimeout(400);
        await page.getByRole("menuitem", { name: /marketplace/i }).click();
        await page.waitForSelector(".mkt-dialog"); await page.waitForTimeout(800);
        await shot("connectors");
        await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      });
      await reset(page);
      await step("code-card", async () => {
        await page.evaluate(() => window.__look.openSteps()); await page.waitForTimeout(400);
        await page.evaluate(() => window.__look.expandStepBody()); await page.waitForTimeout(400);
        await shot("code-card");
      });
      await reset(page);
      await step("approval-confirm", async () => {
        await page.locator(".card").last().scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
        // Delete a Bot from its sidebar menu: after the pass this is the in-app confirm; before it,
        // window.confirm, which headless Chromium dismisses without drawing anything.
        await page.locator(".sidebar .row").nth(3).click({ button: "right" }); await page.waitForTimeout(300);
        await page.getByRole("menuitem", { name: "Delete Bot" }).click(); await page.waitForTimeout(500);
        await shot("approval-confirm");
      });
    });
    await session(scheme, "empty", async (page, shot, step) => { await step("empty-chat", () => shot("empty-chat")); });
    await session(scheme, "connecting", async (page, shot, step) => {
      await step("computer-connecting", async () => {
        await page.evaluate(() => window.__look.openPanel()); await page.waitForTimeout(400);
        await page.locator(".screen-thumb").first().click();
        await page.waitForSelector(".computer-view");
        await page.waitForTimeout(12000);
        await shot("computer-connecting");
      });
    });
  }
} finally {
  await browser.close(); await vite.close(); wss.close(); silent.close();
}
console.log(errors.length ? `ERRORS:\n  ${errors.join("\n  ")}` : "no errors");
