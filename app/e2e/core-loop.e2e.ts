import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("create Bot → chat → live step → approval card → Allow once / Always allow / Deny → reply", async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: "e2e" } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, "core-loop");
  await completeOnboarding(win);
  await expect(win.getByRole("button", { name: "New chat" })).toBeEnabled({ timeout: 30_000 });

  await win.getByRole("button", { name: "New chat" }).click();
  await win.getByLabel("To:").fill("Tutor");
  await win.getByRole("option", { name: 'Create "Tutor" Bot' }).click();
  // Scope message-content checks to the transcript: the sidebar row also mirrors the latest text.
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  await expect(transcript.getByText("Hi! Tell me what you'd like help with")).toBeVisible();
  await expect(win.getByRole("link", { name: /Tutor/ })).toBeVisible();

  const composer = win.getByPlaceholder("Message Tutor");
  await composer.fill("please run: rm -rf /workspace/tmp/x");
  await composer.press("Enter");
  await expect(transcript.getByText("On it.")).toBeVisible();
  const card = win.getByRole("region", { name: "Approval needed" });
  await expect(card).toContainText("Your Bot would like to run a command");
  await expect(win.getByRole("link", { name: /Tutor/ })).toContainText("Approval needed");
  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(win.getByRole("region", { name: "Approved action" })).toContainText("Allowed once");
  await expect(transcript.getByText("Done: rm -rf /workspace/tmp/x")).toBeVisible();

  await composer.fill("please run: rm -rf /workspace/tmp/y");
  await composer.press("Enter");
  await win.getByRole("region", { name: "Approval needed" }).getByRole("button", { name: "Always allow" }).click();
  await expect(transcript.getByText(/Added to your Auto-review rules as always allowed/)).toBeVisible();

  await composer.fill("please run: curl https://example.com");
  await composer.press("Enter");
  await win.getByRole("region", { name: "Approval needed" }).getByRole("button", { name: "Deny" }).click();
  await expect(win.getByRole("region", { name: "Denied action" })).toContainText("Denied");
  await expect(transcript.getByText("Done: curl https://example.com")).toBeVisible();

  await win.getByRole("button", { name: "Open account menu" }).click();
  await win.getByRole("menuitem", { name: "Settings" }).click();
  await expect(win.getByRole("table", { name: "Auto-review rules" })).toContainText("Use the Shell tool to delete scratch files in /workspace/tmp.");
  await app.close();
});
