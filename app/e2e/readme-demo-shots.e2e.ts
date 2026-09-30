import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { launch } from "./fuzz-helpers";
import { completeOnboarding } from "./onboarding";
import { test } from "./page-errors";

/**
 * The README demo: a Bot takes a task, an approval card appears, Allow once, the result. Recorded from the real app
 * (FUZZ local host, scripted brain, no model calls) with an ISOLATED userData (globalSetup's SYNAPSE_APP_DATA) and a
 * throwaway HOME, in light mode. Frames come from a CDP screencast and are written with their timestamps; the GIF is
 * assembled by scripts/readme-demo.sh. Run on purpose only:
 *
 *   README_DEMO=<outDir> npx playwright test -c e2e/playwright.config.ts readme-demo-shots
 */
const OUT = process.env.README_DEMO;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "frames only when README_DEMO names an output folder");

test("README demo: task, approval card, Allow once, result", async () => {
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username.toLowerCase();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win } = await launch("readme-demo", { onboard: false });
    await completeOnboarding(win, "Nova");
    // Swap the Mac account name for a neutral one before recording: app-info answers "sam", then reload.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("app-info"); ipcMain.handle("app-info", () => ({ userName: "sam" })); });
    await win.reload();
    await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1120, 700); w.center(); });
    await win.emulateMedia({ colorScheme: "light" });
    for (let i = 0; i < 8; i++) {
      const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
      if (!(await notNow.isVisible({ timeout: 1500 }).catch(() => false))) break;
      await notNow.click({ timeout: 3000 }).catch(() => {});
      await win.waitForTimeout(500);
    }
    await expect(win.getByPlaceholder("Message Nova")).toBeVisible({ timeout: 15_000 });
    await win.mouse.move(1110, 690);
    await win.waitForTimeout(800);
    // Never show the Mac account name.
    expect((await win.locator("body").innerText()).toLowerCase()).not.toContain(realUser);

    const cdp = await win.context().newCDPSession(win);
    const frames: { file: string; t: number }[] = [];
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = `f${String(frames.length).padStart(4, "0")}.png`;
      fs.writeFileSync(path.join(out, file), Buffer.from(f.data, "base64"));
      frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await win.waitForTimeout(900);

    const composer = win.getByPlaceholder("Message Nova");
    await composer.click();
    await composer.pressSequentially("Clear out the old drafts. Run: rm -r ~/drafts/2025", { delay: 40 });
    await win.waitForTimeout(400);
    await composer.press("Enter");
    const card = win.getByRole("region", { name: "Approval needed" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await win.waitForTimeout(2200);
    const allow = card.getByRole("button", { name: "Allow once" });
    await allow.hover();
    await win.waitForTimeout(500);
    await allow.click();
    const transcript = win.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript.getByText("Done: rm -r ~/drafts/2025")).toBeVisible({ timeout: 15_000 });
    await win.mouse.move(1110, 690);
    await win.waitForTimeout(2600);
    await cdp.send("Page.stopScreencast");
    await win.waitForTimeout(300);

    expect((await win.locator("body").innerText()).toLowerCase()).not.toContain(realUser);
    fs.writeFileSync(path.join(out, "frames.json"), JSON.stringify(frames, null, 1));
    expect(frames.length).toBeGreaterThan(20);
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
