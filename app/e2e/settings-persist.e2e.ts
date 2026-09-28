import { expect, type Page } from "@playwright/test";
import type { BotSummary } from "@synapse/shared";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

// settings-persist: "Settings in the app need to stay persistent. You switch something on, it stays on through
// reloads." Bot settings switches — the two ability switches kept on this Mac, and three kept by the host — are
// turned on, then the window is reloaded (⌘R), and every one of them must come back on, in the UI and in storage.

async function openBotSettings(win: Page): Promise<void> {
  if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
  await win.getByRole("button", { name: "Bot settings" }).click();
}

const SWITCHES = ["May use the browser on your Mac", "May use the apps on your Mac", "Engineering mode"];

test("Bot settings switches stay on through a window reload", async () => {
  const { app, win, api } = await launch("settings-persist");
  await createBot(win, "Keeper");
  const agent = async () => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === "Keeper")!;
  await openBotSettings(win);

  for (const name of SWITCHES) {
    const sw = win.getByRole("switch", { name, exact: false }).first();
    await expect(sw).toBeEnabled();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
  }
  const notify = win.getByRole("switch", { name: "Notifications" });
  await expect(notify).toHaveAttribute("aria-checked", "true");
  await notify.click();
  await expect(notify).toHaveAttribute("aria-checked", "false");
  // No switch reported a failed save.
  await expect(win.locator("[data-bot-settings] .error")).toHaveCount(0);
  await expect(async () => {
    const a = await agent();
    expect(a.settings.engineeringMode).toBe(true);
    expect(a.settings.notifyOnAgentUpdates).toBe(false);
  }).toPass({ timeout: 5000 });

  await win.reload();
  await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await expect(win.locator(".chat-header").getByText("Keeper")).toBeVisible({ timeout: 10_000 });
  await openBotSettings(win);
  for (const name of SWITCHES) {
    const sw = win.getByRole("switch", { name, exact: false }).first();
    await expect(sw).toBeEnabled();
    await expect(sw, `${name} after reload`).toHaveAttribute("aria-checked", "true");
  }
  await expect(win.getByRole("switch", { name: "Notifications" })).toHaveAttribute("aria-checked", "false");
  await app.close();
});
