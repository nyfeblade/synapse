import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Phase 3 journey in FUZZ mode: Computer card → take over → I'm done; Secrets section; Updates", async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-p3-${Date.now()}` } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, "computer");
  await completeOnboarding(win); // Phase 5: a fresh FUZZ profile opens on onboarding
  await expect(win.getByRole("button", { name: "New chat" })).toBeEnabled({ timeout: 30_000 });

  await win.getByRole("button", { name: "New chat" }).click();
  await win.getByLabel("To:").fill("Scout");
  await win.getByRole("option", { name: 'Create "Scout" Bot' }).click();

  const composer = win.getByPlaceholder("Message Scout");
  await composer.fill("computer: hold the Denver fare");
  await composer.press("Enter");

  const card = win.getByRole("region", { name: "Computer" });
  await expect(card.getByText("Action needed")).toBeVisible();
  await expect(win.getByText("Needs your attention")).toBeVisible();
  await card.getByRole("button", { name: "Take over" }).click();

  const view = win.getByRole("dialog", { name: "Bots' computer" });
  await expect(view.getByRole("status")).toContainText("You're in control");
  await expect(view.getByRole("status")).toContainText("Scout is paused until you hand it back");
  await view.getByRole("button", { name: "I'm done" }).click();
  await expect(view).toBeHidden();

  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  await expect(transcript.getByText("Thanks for handing the computer back. The fare is on hold.")).toBeVisible();
  await expect(win.getByRole("button", { name: "Open computer" })).toBeEnabled();

  await win.getByRole("button", { name: "Bot settings" }).click();
  await win.getByRole("button", { name: "Add secret" }).click();
  await win.getByLabel("Name").last().fill("API_KEY");
  await win.getByLabel("Description (visible to your Bot)").fill("Demo key");
  await win.getByLabel("Value").fill("value-123456");
  await win.getByRole("button", { name: "Save secret" }).click();
  await expect(win.getByText("API_KEY")).toBeVisible();
  await expect(win.locator("body")).not.toContainText("value-123456");

  await win.keyboard.press("Meta+,");
  await win.getByRole("button", { name: "Updates" }).click();
  await expect(win.getByRole("heading", { name: "Update Bots' computer" })).toBeVisible();
  await app.close();
});
