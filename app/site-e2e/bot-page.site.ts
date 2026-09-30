// Bot sharing: /bot in a real browser. Decodes and renders a real share link, stays inert on script-injection
// strings, falls back without the app after 1.5 s, loads no analytics and is served with the CSP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
// @ts-expect-error plain ESM, no types
import { build } from "../../site/build.mjs";
// @ts-expect-error plain ESM, no types
import { serve } from "./serve.mjs";
import { encodeShare } from "../../shared/src/bot-share.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const starters = JSON.parse(fs.readFileSync(path.join(here, "../../host/templates/starters.json"), "utf8")) as { name: string; title: string; description: string; avatarShape: string; avatarColor: string; tools: string[] }[];
const s0 = starters[0]!;
const payload = { v: 1, name: s0.name, title: s0.title, instructions: s0.description, shape: s0.avatarShape, color: s0.avatarColor, tools: s0.tools.map((t) => ({ catalogId: `curated:${t}`, name: t })), skills: [{ id: "notes", name: "notes", description: "Keeps notes", files: { "SKILL.md": "---\nname: notes\n---\n```bash\necho hi\n```" } }] };
const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

let dir = "", server: Server, base = "";
test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-e2e-"));
  build("2026-09-29", dir);
  const s = await serve(dir);
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});
test.afterAll(async () => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Requests leaving the site (fonts aside) and console errors. */
function watch(page: Page) {
  const out = { external: [] as string[], errors: [] as string[] };
  page.on("request", (r) => { const u = new URL(r.url()); if (u.origin !== base && !/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) && u.protocol !== "data:" && u.protocol !== "blob:") out.external.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") out.errors.push(m.text()); });
  page.on("pageerror", (e) => out.errors.push(String(e)));
  return out;
}

test("decodes and renders a real share link, with the CSP and no analytics", async ({ page }) => {
  const frag = await encodeShare(payload);
  const w = watch(page);
  const res = await page.goto(`${base}/bot#${frag}`);
  expect(res!.headers()["content-security-policy"]).toContain("connect-src 'self'");
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByRole("heading", { level: 1, name: "Chief of Staff" })).toBeVisible();
  const ms = await page.evaluate(() => performance.getEntriesByName("bot-rendered")[0]?.startTime ?? -1);
  expect(ms).toBeGreaterThan(0);
  await expect(page.locator("[data-tools] .bp-chip")).toHaveText(["Gmail", "Google Calendar"]);
  await expect(page.locator(".bp-skill")).toContainText(["notes"]);
  await expect(page.locator(".bp-skill .bp-chip")).toHaveText("Runs code");
  await expect(page.locator("[data-instructions]")).toHaveText(s0.description);
  await expect(page.locator("[data-face] svg.bot use")).toHaveAttribute("fill", "#3674d8");
  expect(await page.locator("script[src*='_vercel']").count()).toBe(0);
  await expect(page.getByRole("button", { name: "Add to Synapse" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Synapse" })).toBeHidden();
  expect(w.external).toEqual([]);
  expect(w.errors).toEqual([]);
});

test("script-injection strings in every field render as inert text", async ({ page }) => {
  const frag = await encodeShare({ ...payload, name: XSS.slice(0, 80), title: XSS.slice(0, 80), instructions: XSS, tools: [{ catalogId: XSS.slice(0, 80), name: XSS.slice(0, 80) }], skills: [{ id: "x", name: XSS.slice(0, 80), description: XSS, files: { "SKILL.md": XSS } }] });
  const w = watch(page);
  await page.goto(`${base}/bot#${frag}`);
  await expect(page.locator("h1")).toHaveText(XSS.slice(0, 80));
  await expect(page.locator("[data-instructions]")).toHaveText(XSS);
  expect(await page.locator(".bp img, .bp script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(w.external).toEqual([]);
});

test("a damaged or newer link shows one calm line", async ({ page }) => {
  await page.goto(`${base}/bot#b1.AAAA`);
  await expect(page.getByRole("alert")).toHaveText("This link is damaged.");
  await page.goto(`${base}/bot#b7.AAAA`);
  await expect(page.getByRole("alert")).toHaveText("This Bot needs a newer Synapse.");
});

test("without the app: Download and Save .botpack after 1.5 s, the Bot kept for later, the link copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const frag = await encodeShare(payload);
  await page.goto(`${base}/bot#${frag}`);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Add to Synapse" }).click();
  const dl = page.getByRole("link", { name: "Download Synapse" });
  await expect(dl).toBeVisible({ timeout: 4000 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
  await expect(page.getByRole("button", { name: "Save .botpack" })).toBeVisible();
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem("pendingBot") ?? "null"));
  expect(pending).toMatchObject({ fragment: frag, name: "Chief of Staff" });
  const popup = context.waitForEvent("page");
  await dl.click();
  await (await popup).close();
  await expect(page.getByText("Link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${base}/bot#${frag}`);
  // Back on /bot with no link: it offers the saved Bot.
  await page.goto(`${base}/bot`);
  await expect(page.getByRole("button", { name: "Add Chief of Staff to Synapse" })).toBeVisible();
});

test("Save .botpack downloads a zip named after the Bot", async ({ page }) => {
  await page.goto(`${base}/bot#${await encodeShare(payload)}`);
  const d = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save .botpack" }).click();
  const file = await d;
  expect(file.suggestedFilename()).toBe("chief-of-staff.botpack");
  const p = await file.path();
  expect(fs.readFileSync(p).subarray(0, 2).toString()).toBe("PK");
});

test("security review: a crafted skill can't stall the page (runsCode is linear in the browser too)", async ({ page }) => {
  const crafted = { ...payload, skills: [{ id: "nl", name: "nl", description: "", files: { "SKILL.md": "\n".repeat(63_000) } }, { id: "curl", name: "curl", description: "", files: { "SKILL.md": "curl ".repeat(12_000) } }] };
  await page.goto(`${base}/bot#${await encodeShare(crafted)}`);
  await expect(page.locator("h1")).toHaveText("Chief of Staff");
  const mod = fs.readdirSync(path.join(dir, "assets")).find((f) => /^bot-share\.[0-9a-f]{10}\.js$/.test(f))!;
  const ms = await page.evaluate(async (m) => {
    const { runsCode } = await import(`/assets/${m}`);
    let worst = 0;
    for (const t of ["\n".repeat(65_536), "curl ".repeat(65_536), "curl ".repeat(65_536) + "|"]) { const t0 = performance.now(); runsCode({ "SKILL.md": t }); worst = Math.max(worst, performance.now() - t0); }
    return worst;
  }, mod);
  expect(ms).toBeLessThan(100);
});
