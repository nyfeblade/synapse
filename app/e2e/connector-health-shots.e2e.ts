import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { ConnectorHealthView } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * 4.4: Settings → Connections, the broken-connector tray with Fix, and Settings → General → Work finished,
 * photographed in light and dark in the real app (FUZZ local host) with an ISOLATED userData (globalSetup's
 * SYNAPSE_APP_DATA) and a throwaway HOME. Connectors are set up through their real flows (the fake Google sign-in,
 * a custom MCP server's OAuth); Telegram's state comes in the way the app's main process reports it. Run on purpose:
 *
 *   CONNECTOR_HEALTH_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts connector-health-shots
 */
const OUT = process.env.CONNECTOR_HEALTH_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(!OUT, "screenshots only when CONNECTOR_HEALTH_SHOTS names an output folder");

test("Connections, the Fix tray and Work finished, light and dark", async () => {
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username;
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("connector-health-shots");
    // First-run prompts (monthly budget, the Mac's key copy) arrive a moment after launch and sit over the window.
    const dismissPrompts = async () => {
      for (let i = 0; i < 8; i++) {
        const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
        if (!(await notNow.isVisible({ timeout: 4000 }).catch(() => false))) break;
        await notNow.click({ timeout: 3000 }).catch(() => {});
        await win.waitForTimeout(500);
      }
    };
    await dismissPrompts();
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    expect(userData.startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await createBot(win, "Scout");
    await dismissPrompts();

    // Google, through the fake Google's real sign-in.
    await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
    const g = await api<{ authorizationUrl: string }>("startGoogleAuth");
    await api("completeMcpOAuth", { state: new URL(g.authorizationUrl).searchParams.get("state")!, code: "fuzz" });
    // Two custom MCP servers: Linear signed in (OK), Notion waiting for its first sign-in (setup, no tray).
    await api("addMcpServer", { name: "Linear", url: "https://mcp.linear.app/sse" });
    const l = await api<{ authorizationUrl: string }>("startMcpAuth", { serverId: "linear" });
    await api("completeMcpOAuth", { state: new URL(l.authorizationUrl).searchParams.get("state")!, code: "fuzz" });
    await api("addMcpServer", { name: "Notion", url: "https://mcp.notion.com/mcp" });
    // Telegram worked, then its token was revoked: a real break (one tray with Fix).
    await api("reportConnectorHealth", { id: "telegram", state: "ok" });
    await api("reportConnectorHealth", { id: "telegram", state: "needs-sign-in", reason: "Token rejected" });
    const list = (await api<{ connectors: ConnectorHealthView[] }>("getConnectorHealth")).connectors;
    // 4.3b: one Google row per account (google:<accountId>).
    expect(list.map((c) => [c.id.startsWith("google:") ? "google" : c.id, c.state])).toEqual(expect.arrayContaining([["google", "ok"], ["mcp:linear", "ok"], ["mcp:notion", "needs-sign-in"], ["telegram", "needs-sign-in"]]));

    const noAccountName = async (sel: string) => {
      const text = await win.locator(sel).innerText();
      expect(text.toLowerCase()).not.toContain(realUser.toLowerCase());
    };
    const shoot = async (sel: string, name: string) => {
      for (const scheme of ["light", "dark"] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.mouse.move(1, 1);
        await win.waitForTimeout(350);
        await noAccountName(sel);
        await win.locator(sel).screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
      }
    };

    // The tray, in the chat.
    const tray = win.locator(".tray").filter({ hasText: "Telegram needs you to sign in again" });
    await expect(tray).toBeVisible({ timeout: 10_000 });
    await expect(tray.getByRole("button", { name: "Fix" })).toBeVisible();
    await shoot(".trays", "tray");

    // Settings → Connections.
    await win.keyboard.press("Meta+Comma");
    await win.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(win.locator('.connection-row[data-connector="telegram"]')).toHaveAttribute("data-state", "needs-sign-in");
    await expect(win.locator('.connection-row[data-connector="mcp:linear"]')).toHaveAttribute("data-state", "ok");
    await shoot(".settings-dialog", "connections");

    // Settings → General → Notifications.
    await win.getByRole("button", { name: "General", exact: true }).click();
    const block = win.locator('[data-setting="work-finished"]');
    await block.scrollIntoViewIfNeeded();
    await block.getByRole("radio", { name: "Only long tasks" }).click();
    await expect(block.getByRole("radio", { name: "Only long tasks" })).toHaveAttribute("aria-checked", "true");
    await shoot(".settings-dialog", "work-finished");
    await win.keyboard.press("Escape");

    // Fix runs Telegram's own setup (Settings → System → Telegram).
    await win.locator(".tray").filter({ hasText: "Telegram" }).getByRole("button", { name: "Fix" }).click();
    await expect(win.locator('.settings-content[data-settings-section="system"]')).toBeVisible();
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
