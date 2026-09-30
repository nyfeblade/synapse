// Bot sharing: /bots in a real browser. Search and tool chips filter on the page, a card opens its Bot in a
// dialog with no page load (and #slug to share it), the creator is "Synapse", no analytics, the CSP is on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { expect, test } from "@playwright/test";
// @ts-expect-error plain ESM, no types
import { build, loadCatalogue } from "../../site/build.mjs";
// @ts-expect-error plain ESM, no types
import { serve } from "./serve.mjs";

let dir = "", server: Server, base = "";
const { entries } = loadCatalogue() as { entries: { slug: string; payload: { name: string; tools: { name: string }[] }; fragment: string }[] };
test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-bots-e2e-"));
  build("2026-09-29", dir);
  const s = await serve(dir);
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});
test.afterAll(async () => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("lists the catalogue with Synapse as the creator, with the CSP and no analytics", async ({ page }) => {
  const res = await page.goto(`${base}/bots`);
  expect(res!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator(".bcard")).toHaveCount(entries.length);
  await expect(page.locator(".bcard-by")).toHaveText(entries.map(() => "Synapse"));
  expect(await page.locator("script[src*='_vercel']").count()).toBe(0);
});

test("search and tool chips filter instantly, on the page", async ({ page }) => {
  await page.goto(`${base}/bots`);
  // No page load: a marker on the window survives.
  await page.evaluate(() => { (window as unknown as { __same?: number }).__same = 1; });
  const samePage = () => page.evaluate(() => (window as unknown as { __same?: number }).__same === 1);
  await page.getByRole("searchbox", { name: "Search Bots" }).fill("meeting");
  await expect(page.locator(".bcard:visible")).toHaveCount(1);
  await expect(page.locator(".bcard:visible h3")).toHaveText("Meeting Prep");
  await page.getByRole("searchbox", { name: "Search Bots" }).fill("zzzz");
  await expect(page.getByText("No Bots match.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Bots" }).fill("");
  await page.getByRole("button", { name: "Gmail" }).click();
  const withGmail = entries.filter((e) => e.payload.tools.some((t) => t.name === "Gmail")).length;
  await expect(page.locator(".bcard:visible")).toHaveCount(withGmail);
  await expect(page.getByRole("button", { name: "Gmail" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Gmail" }).click();
  await expect(page.locator(".bcard:visible")).toHaveCount(entries.length);
  expect(await samePage()).toBe(true);
});

test("a card opens its Bot in a dialog with no page load, sets #slug, and Add to Synapse is there", async ({ page }) => {
  await page.goto(`${base}/bots`);
  // No page load: a marker on the window survives.
  await page.evaluate(() => { (window as unknown as { __same?: number }).__same = 1; });
  const samePage = () => page.evaluate(() => (window as unknown as { __same?: number }).__same === 1);
  const first = entries[0]!;
  await page.locator(".bcard", { hasText: first.payload.name }).locator("a").click();
  const dialog = page.getByRole("dialog", { name: first.payload.name });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to Synapse" })).toBeVisible();
  await expect(dialog.locator("[data-instructions]")).not.toBeEmpty();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${first.slug}`);
  expect(await samePage()).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  // A shared #slug opens straight to that Bot.
  await page.goto(`${base}/bots#${entries[1]!.slug}`);
  await expect(page.getByRole("dialog", { name: entries[1]!.payload.name })).toBeVisible();
});

test("every catalogue link decodes on /bot", async ({ page }) => {
  for (const e of entries) {
    await page.goto(`${base}/bot#${e.fragment}`);
    await expect(page.locator("h1")).toHaveText(e.payload.name);
  }
});

test("a Bot kept from before the app was installed is offered again on /bots", async ({ page }) => {
  await page.goto(`${base}/bots`);
  await page.evaluate((f) => localStorage.setItem("pendingBot", JSON.stringify({ fragment: f, name: "Research Scout", at: Date.now() })), entries[0]!.fragment);
  await page.reload();
  await expect(page.getByRole("button", { name: "Add Research Scout to Synapse" })).toBeVisible();
});
