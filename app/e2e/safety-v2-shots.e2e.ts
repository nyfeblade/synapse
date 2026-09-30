import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import type { BotSummary } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * Safety v2: Settings → Rules (preset, rules, add a rule with its compiled matcher and preview, guidelines) and a
 * Bot's own rules and network, in light and dark, in the real app (FUZZ local host) with an ISOLATED userData
 * (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME. Run on purpose only:
 *
 *   SAFETY_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts safety-v2-shots
 */
const OUT = process.env.SAFETY_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "screenshots only when SAFETY_SHOTS names an output folder");

test("Rules home and a Bot's rules, light and dark", async () => {
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username.toLowerCase();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("safety-v2-shots");
    // First-run prompts (monthly budget, the Mac's key copy) arrive a moment after launch: dismiss them until none show.
    for (let quiet = 0, i = 0; quiet < 2 && i < 12; i++) {
      const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
      if (!(await notNow.isVisible({ timeout: 1500 }).catch(() => false))) { quiet++; continue; }
      quiet = 0;
      await notNow.click({ timeout: 3000 }).catch(() => {});
      await win.waitForTimeout(500);
    }
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1180, 820); w.center(); });
    await createBot(win, "Nova");
    const nova = (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === "Nova")!.id;
    // The owner's own rules, a guideline, and Nova's network list and rule, through the same commands the screen uses.
    for (const text of ["Never email eve@evil.example", "Ask me before anything over $50", "At most 5 sends an hour", "No sends between 22:00 and 07:00"]) await api("addSafetyRule", { text });
    await api("setGuidelines", { guidelines: [{ text: "Draft, don't send.", botId: null }, { text: "Cite sources for numbers.", botId: null }, { text: "Keep replies short.", botId: nova }] });
    await api("setBotNetwork", { botId: nova, mode: "only", hosts: ["github.com", "pypi.org"] });
    await api("addSafetyRule", { text: "Ask before deletes", botId: nova });

    const shoot = async (loc: Locator, name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.mouse.move(1, 1);
        await win.waitForTimeout(350);
        expect((await loc.innerText()).toLowerCase()).not.toContain(realUser);
        await loc.screenshot({ path: path.join(out, `${name}-${scheme}.png`), animations: "disabled" });
      }
    };
    const openRules = async (p: Page) => {
      await p.keyboard.press("Meta+Comma");
      await p.getByRole("button", { name: "Rules", exact: true }).click();
      await expect(p.getByRole("switch", { name: "Rule on: Sends" })).toBeVisible({ timeout: 10_000 });
    };

    await openRules(win);
    const dialog = win.locator(".settings-dialog");
    await shoot(dialog, "rules-home");

    // Add a rule: the compiled matcher, the preview and the Ask-first-wins exception offer.
    const field = win.getByLabel("Add rule");
    await field.fill("Always allow sends to bob@acme.example");
    await expect(win.getByLabel("Compiled rule")).toContainText("to bob@acme.example", { timeout: 10_000 });
    await shoot(dialog, "rules-add");
    await field.fill("Ask before emailing my boss");
    await expect(win.locator(".rule-reason")).toContainText("boss", { timeout: 10_000 });
    await shoot(dialog, "rules-add-rejected");
    await field.fill("");

    // Picking a preset shows what changes first.
    await win.getByRole("radio", { name: "Hands-off" }).click();
    await expect(win.getByRole("group", { name: "Switch to Hands-off" })).toBeVisible();
    await shoot(dialog, "rules-preset-diff");
    await win.getByRole("button", { name: "Cancel", exact: true }).click();

    // Scroll to the guidelines.
    await win.getByRole("heading", { name: "Guidelines" }).scrollIntoViewIfNeeded();
    await shoot(dialog, "rules-guidelines");
    await win.keyboard.press("Escape");

    // Nova's settings: its network list, its own rule and its guideline.
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const block = win.locator('[data-setting="bot-rules"]');
    await block.scrollIntoViewIfNeeded();
    await expect(block.getByLabel("Network")).toHaveValue("only");
    await shoot(block, "bot-rules");
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
