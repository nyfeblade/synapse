import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { launch } from "./fuzz-helpers";
import { completeOnboarding } from "./onboarding";
import { test } from "./page-errors";

/**
 * The README's screenshots, from the real app (FUZZ local host, scripted brain, no model calls) with an ISOLATED
 * userData (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME, in light mode, with a neutral account name.
 * The coding turn is host/brain/demo-script.ts's README scene. Run on purpose only:
 *
 *   README_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts readme-shots
 *
 * Writes screenshot-code.png, screenshot-models.png and screenshot-call.png (1120×700 at 2x).
 */
const OUT = process.env.README_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "shots only when README_SHOTS names an output folder");

async function dismissPrompts(win: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
    if (!(await notNow.isVisible({ timeout: 1000 }).catch(() => false))) break;
    await notNow.click({ timeout: 3000 }).catch(() => {});
    await win.waitForTimeout(400);
  }
}

test("README screenshots: coding, the model picker, a call", async () => {
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username.toLowerCase();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win } = await launch("readme-shots", { onboard: false });
    await completeOnboarding(win, "Nova");
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("app-info"); ipcMain.handle("app-info", () => ({ userName: "Sam Lee" })); });
    await win.reload();
    await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1120, 700); w.center(); });
    await win.emulateMedia({ colorScheme: "light" });
    await dismissPrompts(win);
    const shot = async (name: string) => {
      await win.mouse.move(1110, 690);
      await win.waitForTimeout(600);
      expect((await win.locator("body").innerText()).toLowerCase()).not.toContain(realUser);
      await win.screenshot({ path: path.join(out, name), animations: "disabled" });
    };

    // 1. Coding: a Bot fixes a failing test (the scripted README scene).
    const composer = win.getByPlaceholder("Message Nova");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Fix the failing date test in weather-app, then run all the tests.");
    await composer.press("Enter");
    const transcript = win.getByRole("log", { name: "Conversation transcript" });
    // Ask mode: each command shows a card; allow them as they come.
    const done = transcript.getByText("All 48 tests pass.");
    for (let i = 0; i < 10 && !(await done.isVisible().catch(() => false)); i++) {
      const allow = win.getByRole("region", { name: "Approval needed" }).getByRole("button", { name: "Allow once" }).first();
      if (await allow.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) { await dismissPrompts(win); await allow.click({ timeout: 5000 }).catch(() => {}); }
    }
    await expect(done).toBeVisible({ timeout: 20_000 });
    await dismissPrompts(win);
    const newer = win.getByRole("button", { name: /New messages/ });
    if (await newer.isVisible().catch(() => false)) await newer.click();
    await transcript.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await win.waitForTimeout(800);
    await shot("screenshot-code.png");

    // 2. The model picker, with OpenAI (a made-up key; FUZZ answers the key test offline) and Ollama allowed.
    await win.getByRole("button", { name: "Open account menu" }).click();
    await win.getByRole("menuitem", { name: "Settings" }).click();
    await win.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account" }).click();
    await dismissPrompts(win);
    const openai = win.getByLabel("OpenAI", { exact: true });
    await openai.getByRole("button", { name: "Allow" }).click();
    await win.getByRole("region", { name: "Use OpenAI?" }).getByRole("button", { name: "Allow" }).click();
    await win.getByLabel("OpenAI key").fill("sk-e2e-screenshot-0123456789abcd");
    await openai.getByRole("button", { name: "Save" }).click();
    await expect(openai.getByText("sk-…abcd")).toBeVisible({ timeout: 10_000 });
    const ollama = win.getByLabel("Ollama", { exact: true });
    await ollama.getByRole("button", { name: "Allow" }).click();
    await win.getByRole("region", { name: "Use Ollama?" }).getByRole("button", { name: "Allow" }).click();
    await expect(ollama.getByText("Allowed")).toBeVisible();
    await dismissPrompts(win);
    await win.keyboard.press("Escape");
    await dismissPrompts(win);
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    await win.getByRole("button", { name: /^Model: / }).evaluate((el) => { el.scrollIntoView({ block: "start" }); el.closest(".panel")?.scrollBy(0, -48); });
    await win.getByRole("button", { name: /^Model: / }).click();
    await expect(win.getByRole("listbox", { name: "Model" })).toBeVisible();
    const cur = await win.getByRole("option", { name: /GPT-6\.1 Sol/ }).boundingBox();
    await win.mouse.move(cur!.x + cur!.width / 2, cur!.y + cur!.height / 2);
    await win.waitForTimeout(600);
    await win.screenshot({ path: path.join(out, "screenshot-models.png"), animations: "disabled" });
    await win.keyboard.press("Escape");
    await win.keyboard.press("Escape");

    // 3. A call.
    await win.getByRole("button", { name: "Start a voice call" }).click();
    await win.waitForTimeout(3000);
    await shot("screenshot-call.png");
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
