import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { BotSummary, GoogleStatusView } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * 4.3 Email in, photographed in light and dark in the real app (FUZZ local host) with an ISOLATED userData
 * (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME: Bot settings (the Email in switch, the Bot's address and
 * label), the card a Bot's send to that address always raises, and the emailed task in the chat. The owner's own
 * approved send lands in their Sent folder and inbox (the fake Google does what Gmail does), and the next Gmail
 * poll (60 s) turns it into a task. The Mac account name is checked absent and masked.
 *
 *   EMAIL_IN_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts email-in-shots
 */
const OUT = process.env.EMAIL_IN_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "screenshots only when EMAIL_IN_SHOTS names an output folder");

test("Email in: settings, the card, and the emailed task, light and dark", async () => {
  test.setTimeout(360_000);
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username;
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("email-in-shots");
    await win.addLocatorHandler(win.locator(".key-prompts .key-prompt").first(), async () => {
      await win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first().click({ timeout: 3000 }).catch(() => {});
    });
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await createBot(win, "Scout");
    const scout = (await api<{ agents: { id: string; profile: { name: string } }[] }>("listAgents")).agents.find((b) => b.profile.name === "Scout")!.id;

    await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
    await api("setAgentGoogle", { id: scout, enabled: true });
    const g = await api<{ authorizationUrl: string }>("startGoogleAuth");
    await api("completeMcpOAuth", { state: new URL(g.authorizationUrl).searchParams.get("state")!, code: "fuzz" });
    expect((await api<GoogleStatusView>("getGoogleStatus")).accounts!.map((a) => a.email)).toEqual(["me@example.com"]);

    const shoot = async (sel: string, name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.mouse.move(1, 1);
        await win.waitForTimeout(350);
        expect((await win.locator(sel).first().innerText()).toLowerCase()).not.toContain(realUser.toLowerCase());
        await win.locator(sel).first().screenshot({ path: path.join(out, `${name}-${scheme}.png`), mask: [win.getByText(realUser, { exact: false })] });
      }
    };

    // Bot settings: Email in is off by default; on, it shows the address and the label.
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const panel = win.locator("[data-bot-settings]");
    const sw = panel.getByRole("switch", { name: "Email in" });
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await shoot('[data-bot-settings] .settings-card:has([data-setting="google"])', "bot-email-in-off");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByText("me+scout@example.com")).toBeVisible();
    await expect(panel.getByText("Synapse/Scout")).toBeVisible();
    await shoot('[data-bot-settings] .settings-card:has([data-setting="google"])', "bot-email-in-on");
    const agent = (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((b) => b.id === scout)!;
    expect(agent.settings.emailInTag).toBe("scout");
    await win.getByRole("button", { name: "Close details" }).click();

    // The Gmail poll takes its baseline (one poll interval) before the owner's mail is sent.
    await win.waitForTimeout(65_000);

    // A Bot's send to an email-in address is always a card. The owner approves it: now it's their own mail.
    await win.getByRole("textbox", { name: "Message Scout" }).fill("mail: me+scout@example.com | Fwd: Your trip to Denver | Can you add this flight to my calendar?\\n\\n---------- Forwarded message ---------\\nFrom: Northwind Air <no-reply@northwind-air.example>\\nFlight UA 512 departs 9:10 AM on Oct 14.");
    await win.keyboard.press("Enter");
    const card = win.getByRole("region", { name: "Approval needed" });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await shoot('section.card.pending[aria-label="Approval needed"]', "card-email-in");
    await card.getByRole("button", { name: "Allow once" }).click();

    // The next poll: the owner's own mail to Scout's address becomes a task in Scout's chat.
    const chip = win.locator("[data-email-in]").first();
    await expect(chip).toBeVisible({ timeout: 150_000 });
    await expect(chip).toContainText("Fwd: Your trip to Denver");
    const msg = win.locator(".msg.user").filter({ has: win.locator("[data-email-in]") }).first();
    await expect(msg).toContainText("Can you add this flight to my calendar?");
    await expect(msg).not.toContainText("Northwind");
    await win.waitForTimeout(1500);
    await shoot('.msg.user:has([data-email-in])', "chat-email-task");
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
