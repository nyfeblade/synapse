/**
 * The LOOK harness, polish-pass edition (dev only, never shipped): the same real renderer over the
 * canned state in look/seed.ts as shoot.mjs, but walked through every surface the UI polish pass
 * touches, in both themes, so a before/after pair can be laid side by side.
 *
 *   node app/look/shoot-polish.mjs <outDir> [only-substring]
 *
 * Extra canned data (a stocked Marketplace, the Computer stage's absence states, a live Bot cursor)
 * is layered over seed.ts's bridge here, per session, rather than edited into seed.ts, so shoot.mjs's
 * own pictures stay what they were.
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
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "bots-look-polish"));
const only = process.argv[3] ?? "";
const width = 1440, height = 900;
fs.mkdirSync(out, { recursive: true });

const shim = (await build({ entryPoints: [path.join(appDir, "look", "seed.ts")], bundle: true, write: false, format: "iife", target: "esnext" })).outputFiles[0].text;
const vite = await createServer({
  configFile: path.join(appDir, "vite.config.ts"), root: path.join(appDir, "src", "renderer"), logLevel: "error",
  cacheDir: path.join(os.tmpdir(), "bots-look-vite-polish"), server: { host: "127.0.0.1", port: 0, hmr: false },
});
await vite.listen();
const url = vite.resolvedUrls.local[0];

// A VNC endpoint that accepts the socket and never speaks: the stage stays "connecting".
const silent = http.createServer();
const wss = new WebSocketServer({ server: silent });
wss.on("connection", () => {});
await new Promise((r) => silent.listen(0, "127.0.0.1", r));
const silentPort = silent.address().port;

const entry = (id, name, description, state, action = "add", kind = "plugin", category = "Productivity") =>
  ({ id, kind, source: "curated", name, description, category, logo: null, action, state });
const MARKET = {
  installed: { count: 3, logos: [{ name: "Linear", logo: null }, { name: "Notion", logo: null }, { name: "GitHub", logo: null }] },
  featuredBots: [],
  forYou: null,
  fromTeam: [],
  featuredPlugins: [
    entry("curated:linear", "Linear", "Issues, projects and cycles", "installed"),
    entry("curated:notion", "Notion", "Pages and databases", "needs-auth", "connect"),
    entry("curated:github", "GitHub", "Repos, pull requests and issues", "connected", "connect"),
    entry("curated:slack", "Slack", "Channels and messages", "available", "connect"),
    entry("curated:figma", "Figma", "Files and comments", "available"),
    entry("curated:stripe", "Stripe", "Payments and invoices", "available"),
    entry("curated:asana", "Asana", "Tasks and projects", "available"),
    entry("curated:hubspot", "HubSpot", "Contacts and deals", "available"),
  ],
  categories: [
    { name: "Data", total: 7, entries: ["Snowflake", "BigQuery", "Postgres", "Airtable", "Sheets", "Mode", "dbt"].map((n, i) => entry(`curated:d${i}`, n, `${n} queries and tables`, i === 1 ? "installed" : "available", "add", "plugin", "Data")) },
  ],
};

const wrap = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const b = window.synapse; const orig = b.call;
  b.call = async (cmd, args) => {
    if (cmd === "search") return { ok: true, result: { results: [] } };
    if (cmd === "getMarketplace") return { ok: true, result: ${JSON.stringify(MARKET)} };
    if (cmd === "searchCatalog") return { ok: true, result: { plugins: [], bots: [] } };
    if (cmd === "getDisplays") {
      if (mode === "unreachable") return { ok: false, error: { code: "UNREACHABLE", message: "host offline" } };
      if (mode === "waiting") return { ok: true, result: { displays: [], waiting: ["bot-1"] } };
      if (mode === "connecting" || mode === "dial-failed") return { ok: true, result: { displays: [{ botId: "bot-1", index: 1, display: ":1", cdpPort: 9222, running: true, generation: 1 }], waiting: [] } };
    }
    if (cmd === "requestDisplay") return { ok: true, result: {} };
    if (mode === "empty" && cmd === "getAgentTranscriptTail") return { ok: true, result: { entries: [] } };
    if (mode === "empty" && (cmd === "listAgents" || cmd === "openAgent")) {
      // An idle Bot, so the empty chat is not also showing its typing dots.
      const r = await orig(cmd, args); const idle = (a) => ({ ...a, presence: "idle", running: false, activity: null, marker: null });
      return cmd === "listAgents" ? { ok: true, result: { ...r.result, agents: r.result.agents.map((a, i) => (i === 0 ? idle(a) : a)) } } : { ok: true, result: { agent: idle(r.result.agent) } };
    }
    return orig(cmd, args);
  };
  if (mode === "connecting") b.vncUrl = () => "ws://127.0.0.1:${silentPort}/vnc";
  if (mode === "dial-failed") b.vncUrl = () => "ws://127.0.0.1:9/vnc";
})();`;

const browser = await chromium.launch({ headless: true });
const errors = [];

async function session(scheme, mode, fn) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, bypassCSP: true, colorScheme: scheme, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(`${scheme}/${mode}: ${e.message}`));
  await page.addInitScript(shim);
  await page.addInitScript(wrap(mode));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".chat-header", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const shot = async (name) => {
    if (only && !name.includes(only)) return;
    await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
    console.log("shot", name, scheme);
  };
  const step = async (name, f) => { try { await f(); } catch (e) { errors.push(`${scheme} ${name}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
  try { await fn(page, shot, step); } finally { await ctx.close(); }
}

const openComputer = async (page) => {
  await page.evaluate(() => window.__look.openPanel());
  await page.waitForTimeout(400);
  await page.locator(".screen-thumb").first().click();
  await page.waitForSelector(".computer-view");
  await page.waitForTimeout(500);
};

try {
  for (const scheme of ["dark", "light"]) {
    await session(scheme, "rich", async (page, shot, step) => {
      await step("chat-idle", async () => { await shot("01-chat-idle"); });
      await step("chat-streaming", async () => {
        await page.evaluate(() => window.__look.typing());
        await page.waitForTimeout(900);
        await shot("02-chat-streaming");
      });
      await step("composer-typed", async () => {
        await page.locator(".composer-input").focus();
        await page.keyboard.type("Draft the reply to Priya");
        await page.waitForTimeout(250);
        await shot("03-composer-typed");
        await page.locator(".composer-input").fill("");
        await page.locator(".composer-input").blur();
      });
      await step("sidebar-hover", async () => {
        await page.locator(".sidebar .row").nth(2).hover();
        await page.waitForTimeout(400);
        await shot("04-sidebar-hover");
        await page.mouse.move(900, 450);
      });
      await step("account-menu", async () => {
        await page.locator(".sidebar-account").click();
        await page.waitForTimeout(500);
        await shot("05-account-menu");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("palette", async () => {
        await page.keyboard.press("Meta+k");
        await page.waitForTimeout(450);
        await shot("06-palette");
        await page.keyboard.type("set");
        await page.waitForTimeout(300);
        await shot("07-palette-typed");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("new-chat", async () => {
        await page.locator('[aria-label="New chat"]').click();
        await page.waitForTimeout(500);
        await shot("08-new-chat");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("header-more", async () => {
        await page.getByRole("button", { name: "More actions" }).click();
        await page.waitForTimeout(400);
        await shot("09-header-more");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("code-card", async () => {
        await page.evaluate(() => window.__look.openSteps());
        await page.waitForTimeout(400);
        await page.evaluate(() => window.__look.expandStepBody());
        await page.waitForTimeout(400);
        await shot("10-code-card");
      });
      await step("panel", async () => {
        await page.evaluate(() => window.__look.openPanel());
        await page.waitForTimeout(500);
        await shot("11-panel");
        const tabs = page.locator('.panel [role="tab"]');
        const n = await tabs.count();
        for (let i = 0; i < Math.min(n, 4); i++) {
          await tabs.nth(i).click();
          await page.waitForTimeout(400);
          await shot(`12-panel-tab${i}`);
        }
      });
      // Start the remaining surfaces from a clean page: a panel tab can open further layers.
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".chat-header", { timeout: 20000 });
      await page.waitForTimeout(1200);
      await step("bot-settings", async () => {
        await page.locator(".chat-header").getByRole("button", { name: /^(Bot settings|Bot)$/ }).first().click();
        await page.waitForTimeout(500);
        await shot("13-bot-panel");
        await page.locator(".chat-header").getByRole("button", { name: /^(Bot settings|Bot)$/ }).first().click();
        await page.waitForTimeout(300);
      });
      await step("settings", async () => {
        await page.keyboard.press("Meta+,");
        await page.waitForSelector(".settings-dialog", { timeout: 8000 });
        await page.waitForTimeout(700);
        await shot("20-settings-general");
        await page.locator(".settings-content").evaluate((el) => el.scrollTo(0, 99999));
        await page.waitForTimeout(300);
        await shot("20b-settings-general-bottom");
        for (const name of ["Account", "Voice", "Computer", "Schedules", "System"]) {
          await page.locator(".settings-nav").getByRole("button", { name, exact: true }).first().click();
          await page.waitForTimeout(600);
          await shot(`21-settings-${name.toLowerCase()}`);
        }
        // Settings search exists only after the polish pass; the before run simply has no such shot.
        const search = page.locator(".settings-search input");
        if (await search.count()) {
          await search.fill("voice");
          await page.waitForTimeout(300);
          await shot("22-settings-search");
          await search.fill("zzzz");
          await page.waitForTimeout(300);
          await shot("22-settings-search-miss");
          await search.fill("");
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("connectors", async () => {
        await page.locator(".sidebar-account").click();
        await page.waitForTimeout(400);
        await page.getByRole("menuitem", { name: /marketplace/i }).click();
        await page.waitForSelector(".mkt-dialog");
        await page.waitForTimeout(800);
        await shot("30-connectors");
        const q = page.getByRole("combobox", { name: "Search plugins and Bots" });
        await q.fill("zzzz");
        await page.waitForTimeout(300);
        await q.press("Enter");
        await page.waitForTimeout(400);
        await shot("31-connectors-miss");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        if (await page.locator(".mkt-dialog").count()) await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      });
      await step("computer-none", async () => {
        await openComputer(page);
        await shot("40-computer-none");
      });
    });
    await session(scheme, "empty", async (page, shot, step) => {
      await step("empty-chat", async () => { await shot("44-empty-chat"); });
    });
    for (const mode of ["waiting", "unreachable", "dial-failed", "connecting"]) {
      await session(scheme, mode, async (page, shot, step) => {
        await step(`computer-${mode}`, async () => {
          await openComputer(page);
          await page.waitForTimeout(mode === "dial-failed" ? 1500 : 200);
          await shot(`41-computer-${mode}`);
          if (mode === "connecting") {
            await page.waitForTimeout(11000);
            await shot("42-computer-connecting-11s");
          }
        });
        if (mode === "waiting") {
          await step("cursor-label", async () => {
            // A split light/dark picture behind the Bot's cursor: its label must read on both halves.
            await page.addStyleTag({ content: ".cv-canvas { background: linear-gradient(90deg, #FFFFFF 0 50%, #111111 50% 100%), #888 !important; } .screen-absence { display: none !important; }" });
            await page.evaluate(() => window.__look.cursor?.(600, 400));
            await page.waitForTimeout(600);
            await shot("43-computer-cursor");
          });
        }
      });
    }
  }
} finally {
  await browser.close();
  await vite.close();
  wss.close();
  silent.close();
}
console.log(errors.length ? `ERRORS:\n  ${errors.join("\n  ")}` : "no errors");
