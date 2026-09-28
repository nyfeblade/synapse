import { expect } from "@playwright/test";
import { createBot, killLocalHost, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/** The app-wide action-failure announcement, wherever bug 46's outlet has currently put it. */
const ERROR = '[data-announcement="action-error"]';

/**
 * Bug 46 — the app's error channel, driven in the real app while a surface covers it.
 *
 * `actionError` is the renderer's catch-all failure route (ten writers plus `call()`'s default
 * failure sink) and it had exactly one reader: a `role="alert"` inside `<nav class="sidebar">`,
 * which declares no `z-index`. `.scrim` is 50 and `.computer-view` is 40, so every failed action
 * announced itself under whatever was covering the screen — and covers are CORRELATED with
 * failures, not independent of them: three of the writers (`GoogleToggle`, `AdvancedSettingsCard`,
 * `theme.ts`) are controls that live inside Settings. This journey provokes exactly that case.
 *
 * WHY PLAYWRIGHT AND NOT jsdom: announcer-outlets.test.tsx asserts the alert is mounted INSIDE the
 * surface on top, which is the right claim but not proof — jsdom has no layout and no stacking, so
 * a merely-mounted alert passes there. Playwright refuses to act on an element that does not receive
 * pointer events, so the `Dismiss error` click below is the assertion that cannot be faked. Measured
 * on the old code, same steps: the alert's rect was (10, 844, 231x44), `elementFromPoint` at its
 * centre returned `DIV.scrim`, and this click timed out at 4s.
 *
 * The failure is provoked by killing this app's own FUZZ host and then saving a Settings value, so
 * it is a real rejected gateway write travelling the real channel, not an injected store value.
 *
 * NOT RUN ON THIS BRANCH. The e2e suite launches real Electron windows on the developer's screen and
 * was stopped part-way through this change at the operator's request; this spec is shipped unrun, and
 * the PR says so. What IS measured is the same provocation driven by hand in Chromium before and
 * after the fix: before, the alert's rect was (10, 844, 231x44), `elementFromPoint` at its centre
 * returned `DIV.scrim`, and a click on Dismiss timed out; after, the alert is inside the Settings
 * panel, is the topmost element at its own centre, and the click lands.
 */
test("a failed action while Settings covers the app is readable and dismissable, and survives the cover closing", async () => {
  const { app, win } = await launch(`e2e-covered-alert-${Date.now()}`);
  await createBot(win, "Scout");

  await win.keyboard.press("Meta+Comma");
  const settings = win.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();

  // The host this app owns, and only it: every save from here on is refused.
  killLocalHost(app);
  await expect(win.locator(".connection")).toBeVisible({ timeout: 20_000 });

  // SET-02's Appearance picker — a control INSIDE Settings whose save routes through `actionError`.
  await win.getByLabel("Theme").selectOption("dark");

  // Located by the `data-announcement` hook, not by `role=alert`: Settings can raise its own local
  // error, and this journey is about the app-wide channel, not whichever alert happens to be first.
  const alert = win.locator(ERROR);
  expect(await settings.locator(ERROR).count(), "and it is INSIDE the surface on top").toBe(1);
  await expect(alert, "the failure must announce itself on the surface the user is looking at").toBeVisible();
  const text = (await alert.textContent()) ?? "";
  expect(text.trim().length, "the alert must carry the host's reason, not an empty box").toBeGreaterThan(0);

  // THE PROOF. Playwright will not click an element something else is painting over, so this line
  // is the one that failed before the fix — with the alert in the DOM the whole time.
  await settings.getByRole("button", { name: "Dismiss error" }).click({ timeout: 5_000 });
  await expect(win.locator(ERROR)).toHaveCount(0);

  // An error raised BEHIND a cover and still unread when the cover closes: it follows the user out
  // rather than being lost with the surface it was shown on.
  await win.getByLabel("Theme").selectOption("light");
  await expect(settings.locator(ERROR)).toBeVisible();
  await win.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  const sidebar = win.getByRole("navigation", { name: "Bots" });
  await expect(sidebar.locator(ERROR), "the same message, now in the app's own chrome").toBeVisible();
  await expect(sidebar.locator(ERROR)).toHaveText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40)));
  await sidebar.getByRole("button", { name: "Dismiss error" }).click({ timeout: 5_000 });
  await expect(win.locator(ERROR)).toHaveCount(0);

  await app.close();
});
