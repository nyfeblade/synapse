import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { ComposioStatusView, GoogleStatusView } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * 4.3b: more than one account per connected app, photographed in light and dark in the real app (FUZZ local host)
 * with an ISOLATED userData (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME: Settings → Connected accounts
 * (two Google accounts, Add account, Remove), Bot settings (account checkboxes per app) and the approval card that
 * names the sending account. Two Google accounts come from the fake Google's real sign-in (the code picks the
 * address); two Gmail accounts through the fake Composio. The Mac account name is checked absent and masked.
 *
 *   MULTI_ACCOUNTS_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts multi-accounts-shots
 */
const OUT = process.env.MULTI_ACCOUNTS_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "screenshots only when MULTI_ACCOUNTS_SHOTS names an output folder");

test("accounts in Settings, per-Bot account checkboxes and the card's From line, light and dark", async () => {
  test.setTimeout(180_000);
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username;
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("multi-accounts-shots");
    const dismissPrompts = async () => {
      for (let i = 0; i < 8; i++) {
        const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
        if (!(await notNow.isVisible({ timeout: 4000 }).catch(() => false))) break;
        await notNow.click({ timeout: 3000 }).catch(() => {});
        await win.waitForTimeout(500);
      }
    };
    // First-run prompts (monthly budget, the Mac's key copy) can arrive at any moment and sit over the window.
    await win.addLocatorHandler(win.locator(".key-prompts .key-prompt").first(), async () => {
      await win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first().click({ timeout: 3000 }).catch(() => {});
    });
    await dismissPrompts();
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await createBot(win, "Scout");
    await dismissPrompts();
    const bots = await api<{ agents: { id: string; profile: { name: string } }[] }>("listAgents");
    const scout = bots.agents.find((b) => b.profile.name === "Scout")!.id;

    // Two Google accounts through the fake Google's sign-in: the code names the address.
    await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
    await api("setAgentGoogle", { id: scout, enabled: true });
    for (const code of ["fuzz", "fuzz:work@acme.example"]) {
      const g = await api<{ authorizationUrl: string }>("startGoogleAuth");
      await api("completeMcpOAuth", { state: new URL(g.authorizationUrl).searchParams.get("state")!, code });
    }
    const gst = await api<GoogleStatusView>("getGoogleStatus");
    expect(gst.accounts!.map((a) => a.email)).toEqual(["me@example.com", "work@acme.example"]);
    const work = gst.accounts![1]!.id;
    await api("setAgentGoogleAccount", { id: scout, accountId: work, enabled: true });

    // Two Gmail accounts through the fake Composio (each activates after two status reads).
    await api("setComposioKey", { key: "ak_test_e2e_Zq81xYt4Lm0pRw2vK" });
    await api("acceptComposioDisclosure");
    for (let n = 1; n <= 2; n++) {
      await api("connectComposioApp", { toolkit: "gmail" });
      await expect.poll(async () => (await api<ComposioStatusView>("getComposioStatus")).apps.find((a) => a.toolkit === "gmail")!.accounts.filter((a) => a.state === "connected").length, { timeout: 30_000 }).toBe(n);
    }
    const cx = (await api<ComposioStatusView>("getComposioStatus")).apps.find((a) => a.toolkit === "gmail")!;
    await api("renameComposioAccount", { toolkit: "gmail", accountId: cx.accounts[1]!.id, label: "Work" });
    await api("setComposioGrant", { toolkit: "gmail", botId: scout, enabled: true, accountId: cx.accounts[0]!.id });

    const noAccountName = async (sel: string) => {
      const text = await win.locator(sel).first().innerText();
      expect(text.toLowerCase()).not.toContain(realUser.toLowerCase());
    };
    const shoot = async (sel: string, name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.mouse.move(1, 1);
        await win.waitForTimeout(350);
        await noAccountName(sel);
        await win.locator(sel).first().screenshot({ path: path.join(out, `${name}-${scheme}.png`), mask: [win.getByText(realUser, { exact: false })] });
      }
    };

    // Settings → General → Connected accounts: both Google accounts, Add account, Remove.
    await win.keyboard.press("Meta+Comma");
    await win.getByRole("button", { name: "General", exact: true }).click();
    const accounts = win.getByRole("region", { name: "Connected accounts" });
    await accounts.scrollIntoViewIfNeeded();
    await expect(accounts.getByText("work@acme.example")).toBeVisible();
    await expect(accounts.getByRole("button", { name: "Add account" })).toBeVisible();
    await expect(accounts.getByRole("button", { name: "Remove work@acme.example" })).toBeVisible();
    await shoot('section[aria-label="Connected accounts"]', "settings-accounts");

    // The Composio sheet: two Gmail accounts, each with its Bots and Remove.
    await accounts.getByRole("button", { name: "Manage Composio" }).click();
    const sheet = win.getByRole("dialog", { name: "Composio" });
    await expect(sheet.getByText("Work", { exact: true })).toBeVisible();
    await shoot(".composio-sheet", "composio-accounts");
    await sheet.getByRole("button", { name: "Close" }).click();
    await win.keyboard.press("Escape");

    // Bot settings: a checkbox per account, for Google and for Gmail through Composio.
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const panel = win.locator("[data-bot-settings]");
    const googleGroup = panel.getByRole("group", { name: "Accounts" });
    await expect(googleGroup.getByRole("checkbox", { name: "work@acme.example" })).toBeChecked();
    await expect(panel.getByRole("group", { name: "Gmail" }).getByRole("checkbox", { name: "Work" })).not.toBeChecked();
    await googleGroup.scrollIntoViewIfNeeded();
    const rows = win.locator("[data-bot-settings] .settings-card").filter({ has: win.locator('[data-setting="google"]') });
    await shoot("[data-bot-settings] .settings-card:has([data-setting=\"google\"])", "bot-google-accounts");
    await shoot("[data-bot-settings] .settings-card:has([data-setting^=\"composio-\"])", "bot-composio-accounts");
    expect(await rows.count()).toBe(1);
    // Scout sends from its work account only: untick the personal one, so the send's account is implied.
    await googleGroup.getByRole("checkbox", { name: "me@example.com" }).click();
    await expect(googleGroup.getByRole("checkbox", { name: "me@example.com" })).not.toBeChecked();
    await win.getByRole("button", { name: "Close details" }).click();

    // The card names the sending account.
    await win.getByRole("textbox", { name: "Message Scout" }).fill("mail: dana@example.org | Deck | Looks good.");
    await win.keyboard.press("Enter");
    const card = win.getByRole("region", { name: "Approval needed" });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("From work@acme.example");
    await shoot('section.card.pending[aria-label="Approval needed"]', "card-from-account");
    await card.getByRole("button", { name: "Deny" }).click().catch(() => {});
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
