import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import type { BotSummary } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * 5.6: Settings → Activity and a Bot's Dry run row, photographed in light and dark in the real app (FUZZ local host)
 * with an ISOLATED userData (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME. The action log is seeded the way
 * the coordinator writes it, and one real Undo is clicked through. Run on purpose only:
 *
 *   ACTION_LOG_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts action-log-shots
 */
const OUT = process.env.ACTION_LOG_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "screenshots only when ACTION_LOG_SHOTS names an output folder");

test("Activity and Dry run, light and dark", async () => {
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username;
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("action-log-shots");
    // First-run prompts (monthly budget, the Mac's key copy) sit over the window: dismiss them.
    for (let i = 0; i < 8; i++) {
      const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
      if (!(await notNow.isVisible({ timeout: 1500 }).catch(() => false))) break;
      await notNow.click({ timeout: 3000 }).catch(() => {});
      await win.waitForTimeout(500);
    }
    await createBot(win, "Nova");
    await createBot(win, "Scout");
    const agents = (await api<{ agents: BotSummary[] }>("listAgents")).agents;
    const id = (n: string) => agents.find((a) => a.profile.name === n)!.id;
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);

    // One real, undoable change: a file in a project folder under the throwaway HOME, its prior version cloned.
    const proj = path.join(home, "Projects", "site", "src");
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, "index.html");
    const dir = path.join(userData, "action-log");
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const snap = `${now - 60_000}-0123456789abcdef`;
    fs.writeFileSync(path.join(dir, "snapshots", snap), "<h1>Before</h1>\n");
    fs.writeFileSync(file, "<h1>After</h1>\n");
    const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const at = (minAgo: number) => now - minAgo * 60_000;
    const rec = (o: Record<string, unknown>) => JSON.stringify({ via: "full-auto", outcome: "done", ...o });
    const lines = [
      rec({ id: "r1", at: at(52), botId: id("Scout"), kind: "read", op: "read-file", targets: [path.join(home, "Projects", "site", "README.md")] }),
      rec({ id: "r2", at: at(47), botId: id("Scout"), kind: "command", op: "run-command", targets: ["npm test"], detail: "Exit 0", noUndo: "Commands can't be undone" }),
      rec({ id: "r3", at: at(40), botId: id("Nova"), kind: "browser", op: "browser", act: "click", targets: ["https://example.com/pricing"], via: "permission" }),
      rec({ id: "r4", at: at(33), botId: id("Nova"), kind: "app", op: "mac-app", act: "notes.create", targets: ["Notes"], via: "card" }),
      rec({ id: "r5", at: at(25), botId: id("Scout"), kind: "delete", op: "run-command", targets: [path.join(home, "Projects", "site", "old.css")], command: "rm old.css", via: "card", files: [{ path: path.join(home, "Projects", "site", "old.css"), before: { snap: `${now - 25 * 60_000}-fedcba9876543210` }, after: null }] }),
      rec({ id: "r6", at: at(12), botId: id("Scout"), kind: "write", op: "write-file", targets: [path.join(home, "Projects", "site", "notes.md")], dryRun: true, outcome: "simulated", detail: "Would create notes.md (120 bytes)." }),
      rec({ id: "r7", at: at(11), botId: id("Scout"), kind: "command", op: "run-command", targets: ["git push"], dryRun: true, outcome: "refused", via: "none", detail: "Would run the command." }),
      rec({ id: "r8", at: at(4), botId: id("Nova"), kind: "command", op: "run-command", targets: ["curl -X POST https://api.example.com/deploy"], outcome: "refused", via: "none", detail: "Refused" }),
      rec({ id: "r9", at: at(1), botId: id("Nova"), kind: "edit", op: "edit-file", targets: [file], files: [{ path: file, before: { snap, mode: 0o644 }, after: { size: 15, ino: "0", mtimeNs: "0", ctimeNs: "0", hash } }] }),
    ];
    fs.writeFileSync(path.join(dir, "actions.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });

    const openActivity = async (p: Page) => {
      await p.keyboard.press("Meta+Comma");
      await p.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(p.locator('[data-setting="activity"] .macact-row').first()).toBeVisible({ timeout: 10_000 });
    };
    const noAccountName = async (sel: string) => {
      const text = await win.locator(sel).innerText();
      expect(text.toLowerCase()).not.toContain(realUser.toLowerCase());
    };
    const shoot = async (scheme: "light" | "dark") => {
      await win.emulateMedia({ colorScheme: scheme });
      await win.mouse.move(1, 1);
      await win.waitForTimeout(300);
      await noAccountName(".settings-dialog");
      await win.locator(".settings-dialog").screenshot({ path: path.join(out, `activity-${scheme}.png`) });
    };

    await openActivity(win);
    // A real Undo: confirm, and the file is back to its prior version.
    await win.getByRole("button", { name: /^Undo Edited/ }).click();
    // The confirm commits with the neutral primary button.
    await expect(win.locator(".confirm-dialog .btn-primary")).toHaveText("Undo");
    for (const scheme of ["light", "dark"] as const) {
      await win.emulateMedia({ colorScheme: scheme });
      await win.mouse.move(1, 1);
      await win.waitForTimeout(300);
      await win.locator(".confirm-dialog").screenshot({ path: path.join(out, `undo-confirm-${scheme}.png`) });
    }
    await win.locator(".confirm-dialog").getByRole("button", { name: "Undo", exact: true }).click();
    await expect(win.locator('[data-action-id="r9"]')).toContainText("Undone", { timeout: 10_000 });
    expect(fs.readFileSync(file, "utf8")).toBe("<h1>Before</h1>\n");
    await shoot("light");
    await shoot("dark");
    // The Dry run filter with its tally.
    await win.getByRole("radio", { name: "Dry run" }).click();
    await expect(win.locator(".macact-tally")).toContainText("Would write 1 file, run 1 command");
    for (const scheme of ["light", "dark"] as const) {
      await win.emulateMedia({ colorScheme: scheme });
      await win.mouse.move(1, 1);
      await win.waitForTimeout(300);
      await win.locator(".settings-dialog").screenshot({ path: path.join(out, `activity-dry-run-${scheme}.png`) });
    }
    await win.keyboard.press("Escape");

    // A Bot's settings: the Dry run row and its Activity link.
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const panel = win.locator("[data-bot-settings]");
    await panel.locator('[data-setting="dry-run"]').getByRole("radio", { name: "Next turn" }).click();
    await expect(panel.locator('[data-setting="dry-run"]').getByRole("radio", { name: "Next turn" })).toHaveAttribute("aria-checked", "true");
    await panel.locator('[data-setting="dry-run"]').scrollIntoViewIfNeeded();
    const card = panel.locator(".settings-card", { has: win.locator('[data-setting="dry-run"]') });
    for (const scheme of ["light", "dark"] as const) {
      await win.emulateMedia({ colorScheme: scheme });
      await win.mouse.move(1, 1);
      await win.waitForTimeout(300);
      await noAccountName("[data-bot-settings]");
      await card.screenshot({ path: path.join(out, `bot-dry-run-${scheme}.png`) });
    }
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
