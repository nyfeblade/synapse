import { expect } from "@playwright/test";
import type { BotSummary, HostSettingsView } from "@synapse/shared";
import { createBot, killLocalHost, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

// Task 35 fuzz pass: Layer 2 (driven journeys + abuse cases) from
// .claude/skills/fuzzing-the-app, covering traceability rows B1-B4, N10-N12, T3/T5,
// and the skill's abuse table (speed, input, order, lifecycle, environment).
// Each test launches its own app instance against the throwaway FUZZ profile/local host.

test("B1-B4/N10-N12: Bot settings edits and avatar editor round-trip through the host", async () => {
  const { app, win, api } = await launch("fuzz-b1b4");
  await createBot(win, "Tutor");
  const agentOf = async (name: string) => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === name);

  // The conversation-details panel is open by default (S13); go straight to the gear.
  await win.getByRole("button", { name: "Bot settings" }).click();
  const nameField = win.getByRole("textbox", { name: "Bot name" });
  await nameField.fill("Tutor Prime");
  await nameField.blur();
  await win.getByRole("button", { name: "Back to details" }).click();
  await expect(win.locator(".chat-header").getByText("Tutor Prime")).toBeVisible();
  // Host-state assertion (finding #2): the rename must be persisted by the host, not just shown by
  // the (optimistic) UI — fetched straight from the gateway, bypassing the renderer entirely.
  await expect(async () => expect(await agentOf("Tutor Prime")).toBeTruthy()).toPass({ timeout: 5000 });

  await win.getByRole("button", { name: "Bot settings" }).click();
  const descField = win.getByRole("textbox", { name: "Bot instructions" });
  await descField.fill("A patient tutor.");
  await descField.blur();

  const modelBtn = win.locator(".model-field button[aria-haspopup='listbox']");
  await modelBtn.click();
  await win.getByRole("option", { name: /Opus/ }).click();
  await expect(modelBtn).toContainText("Opus");
  // Host-state assertion (finding #2): description and model, same round trip.
  await expect(async () => {
    const agent = await agentOf("Tutor Prime");
    expect(agent?.profile.description).toBe("A patient tutor.");
    expect(agent?.profile.model).toBe("claude-opus-5");
  }).toPass({ timeout: 5000 });

  await win.getByRole("button", { name: "Edit avatar" }).click();
  // N11: 11 color swatches, 8 shapes — assert the editor actually opened with selectable controls.
  const editorControls = win.locator(".avatar-editor, [class*='avatar-editor']").locator("button");
  await expect(async () => expect(await editorControls.count()).toBeGreaterThan(0)).toPass({ timeout: 5000 });

  await app.close();
});

test("abuse: giant/unicode/HTML composer input, triple-click approval, deny-then-allow, resize, theme", async () => {
  const { app, win } = await launch("fuzz-abuse");
  await createBot(win, "Tutor");
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  const composer = win.getByPlaceholder("Message Tutor");

  // Input abuse: 5,000 chars, emoji/RTL, pasted HTML — none of these may crash the renderer or execute as markup.
  await composer.fill("y".repeat(5000));
  await composer.press("Enter");
  await composer.fill("Ünïcödé 日本語 👋🏽 ‮right-to-left");
  await composer.press("Enter");
  await composer.fill("<img src=x onerror=window.__xss=true>");
  await composer.press("Enter");
  await win.waitForTimeout(500);
  expect(await win.evaluate(() => Boolean((window as unknown as { __xss?: boolean }).__xss))).toBe(false);

  // Speed abuse: triple-click Allow once must resolve the approval exactly once.
  await composer.fill("please run: rm -rf /workspace/tmp/triple");
  await composer.press("Enter");
  const card = win.getByRole("region", { name: "Approval needed" });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByRole("button", { name: "Allow once" }).click({ clickCount: 3, delay: 30 });
  await expect(transcript.getByText("Done: rm -rf /workspace/tmp/triple")).toBeVisible();
  expect(await transcript.getByText("Done: rm -rf /workspace/tmp/triple").count()).toBe(1);

  // Order abuse: deny, then the settled card must not still offer Allow once.
  await composer.fill("please run: rm -rf /workspace/tmp/denythenallow");
  await composer.press("Enter");
  await win.getByRole("region", { name: "Approval needed" }).getByRole("button", { name: "Deny" }).click();
  const settled = win.getByRole("region", { name: "Denied action" });
  await expect(settled).toBeVisible();
  await expect(settled.getByRole("button", { name: "Allow once" })).toHaveCount(0);

  // Environment abuse: the declared minimum window size must not scroll horizontally.
  await win.setViewportSize({ width: 1024, height: 680 });
  await win.waitForTimeout(200);
  expect(await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await win.setViewportSize({ width: 1440, height: 900 });

  // Environment abuse: dark/light must render without throwing.
  await win.emulateMedia({ colorScheme: "dark" });
  await win.waitForTimeout(200);
  await win.emulateMedia({ colorScheme: "light" });

  await app.close();
});

test("T3/T5: Auto-review toggle and rules table round-trip through the host", async () => {
  const { app, win, api } = await launch("fuzz-settings");
  await createBot(win, "Tutor");
  const hostSettings = () => api<HostSettingsView>("getHostSettings");

  await win.getByRole("button", { name: "Open account menu" }).click();
  await win.getByRole("menuitem", { name: "Settings" }).click();
  await win.getByRole("button", { name: "Auto-review", exact: true }).click(); // new-user walk finding 22: its own section

  const sw = win.getByRole("switch", { name: "Auto-review" });
  const before = await sw.getAttribute("aria-checked");
  await sw.click();
  await expect(sw).not.toHaveAttribute("aria-checked", before ?? "");
  // Host-state assertion (finding #2): the toggle must actually flip the host's stored setting,
  // not just the switch's aria-checked attribute (a class/attribute-only UI change the crawler's own
  // dead-control heuristic — SUMMARY.md finding #7 — already can't see, which is exactly why this
  // needs a host-side check rather than another pixel/DOM one).
  await expect(async () => expect((await hostSettings()).autoReviewEnabled).toBe(before !== "true")).toPass({ timeout: 5000 });
  await sw.click(); // restore
  await expect(async () => expect((await hostSettings()).autoReviewEnabled).toBe(before === "true")).toPass({ timeout: 5000 });

  await win.getByLabel("When Bots wants to:").fill("Use the Shell tool to run journey-test commands.");
  await win.getByRole("button", { name: "Add rule" }).click();
  const table = win.getByRole("table", { name: "Auto-review rules" });
  await expect(table.getByText("journey-test commands")).toBeVisible();
  // Host-state assertion (finding #2): the rule must land in the host's allowInstructions list.
  await expect(async () => expect((await hostSettings()).allowInstructions).toContain("Use the Shell tool to run journey-test commands.")).toPass({ timeout: 5000 });
  await table.getByRole("button", { name: "Delete rule" }).last().click();
  await expect(table.getByText("journey-test commands")).toHaveCount(0);
  await expect(async () => expect((await hostSettings()).allowInstructions).not.toContain("Use the Shell tool to run journey-test commands.")).toPass({ timeout: 5000 });

  await app.close();
});

test("lifecycle: killing the local host mid-turn shows Reconnecting/Unreachable, Retry recovers", async () => {
  const { app, win } = await launch("fuzz-lifecycle");
  await createBot(win, "Tutor");

  // Kill only this app's own host (its Electron main's child). The old "exactly one host.mjs process on the
  // machine" check skipped whenever another app ran a fuzz host — and the skip leaked this app open (Task 50).
  killLocalHost(app);

  await expect(win.locator(".connection")).toBeVisible();
  await win.waitForFunction(() => (document.querySelector(".connection")?.textContent ?? "").includes("Reach"), { timeout: 20_000 });
  await win.getByRole("button", { name: "Retry" }).click();
  await win.locator(".connection").waitFor({ state: "detached", timeout: 15_000 });

  await app.close();
});
