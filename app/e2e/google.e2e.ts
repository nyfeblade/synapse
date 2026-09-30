import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ORIG-GOOGLE: the built-in Google connector against the local fake Google (FUZZ never opens a browser: the guarded
// openExternal completes the loopback itself). Connect → a Bot reads mail → sending raises a card → Allow once.
test("Google: connect from the Marketplace, turn it on for a Bot, read mail, send after Allow once", async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-google-"));
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-google-${Date.now()}`, E2E_SAVE_DIR: saveDir } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, "google", { console: true });
  // Count "browser tabs": in FUZZ the consent page is completed by a fetch to the loopback, never a real browser.
  await app.evaluate(() => {
    const g = globalThis as unknown as { fetch: typeof fetch; __oauthTabs?: number };
    const real = g.fetch;
    g.__oauthTabs = 0;
    g.fetch = ((u: string | URL | Request, init?: RequestInit) => { if (String(u).includes("/mcp/oauth/callback")) g.__oauthTabs! += 1; return real(u, init); }) as typeof fetch;
  });
  try {
    await completeOnboarding(win, "Scout");

    // Marketplace → Gmail opens the Connect Google sheet (not claude.ai)
    await win.getByRole("button", { name: "Marketplace", exact: true }).click();
    const mkt = win.getByRole("dialog", { name: "Marketplace" });
    await mkt.getByRole("region", { name: "Featured plugins" }).getByRole("button", { name: "Connect directly Gmail" }).click();
    const sheet = win.getByRole("dialog", { name: "Connect Google" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("list", { name: "Setup steps" }).getByRole("listitem")).toHaveCount(6);
    await sheet.getByLabel("Client ID", { exact: true }).fill("123-e2e.apps.googleusercontent.com");
    await sheet.getByLabel("Client secret", { exact: true }).fill("GOCSPX-e2e-secret");
    await sheet.getByRole("button", { name: "Connect" }).click();
    await expect(sheet.getByText("Connected as me@example.com")).toBeVisible();
    await expect(sheet.getByText("Access to Gmail, Calendar, Drive")).toBeVisible();
    expect(await app.evaluate(() => (globalThis as unknown as { __oauthTabs?: number }).__oauthTabs ?? 0)).toBe(1);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(mkt.getByRole("region", { name: "Featured plugins" }).getByRole("button", { name: "Manage Gmail" })).toBeVisible();
    await mkt.getByRole("button", { name: "Close Marketplace" }).click();

    // Settings → Connected accounts shows the account
    await win.getByRole("button", { name: /Open account menu/ }).click();
    await win.getByRole("menuitem", { name: "Settings" }).click();
    const accounts = win.getByRole("region", { name: "Connected accounts" });
    await expect(accounts.getByText("me@example.com")).toBeVisible();
    await win.getByRole("button", { name: "Close settings" }).click();

    // Bot Settings → Google on (default off)
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const toggle = win.getByRole("switch", { name: "Google" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await win.getByRole("button", { name: "Close details" }).click();

    // The Bot reads mail (no card)
    const log = win.getByRole("log", { name: "Conversation transcript" });
    await win.getByRole("textbox", { name: "Message Scout" }).fill("gmail: deck");
    await win.keyboard.press("Enter");
    await expect(log.getByText(/Subject: Q3 deck/).first()).toBeVisible();
    await expect(win.getByRole("region", { name: "Approval needed" })).toHaveCount(0);

    // Sending raises a card even though it's the user's own account; Allow once sends it
    await win.getByRole("textbox", { name: "Message Scout" }).fill("mail: dana@example.org | Deck | Looks good.");
    await win.keyboard.press("Enter");
    const card = win.getByRole("region", { name: "Approval needed" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("From me@example.com"); // 4.3b: the card names the sending account
    await expect(card).toContainText("dana@example.org");
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(log.getByText(/Sent \(message id/).first()).toBeVisible();

  } finally {
    await app.close();
  }
});
