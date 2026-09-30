import { expect, type Page } from "@playwright/test";
import { step } from "./page-errors";

/** A stand-in Anthropic API key for FUZZ onboarding: key-shaped, never valid, never sent anywhere (the fake brain). */
export const E2E_TEST_API_KEY = "sk-ant-api03-" + "e2eFakeKeyNeverValid".repeat(3);

/** A fresh FUZZ profile opens on onboarding (ONB-01…05). Walk it with a stand-in API key and a
 *  first Bot so the Phase 1 journeys start from the main window, as they did before onboarding existed. */
export async function completeOnboarding(page: Page, name = "Onboarded"): Promise<void> {
  // In `step()` so a renderer error during the five onboarding screens is reported against
  // onboarding, which every journey walks through before it reaches the surface it is about.
  await step("walk onboarding", async () => {
    await page.getByRole("button", { name: "Add API key" }).click({ timeout: 30_000 });
    // synapse-public: the Anthropic API key is the only sign-in (a stand-in key; the fake brain never calls out).
    await page.getByLabel("Anthropic API key").fill(E2E_TEST_API_KEY);
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByRole("heading", { name: "Meet Synapse" })).toBeVisible();
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByRole("link", { name: new RegExp(name) }).first()).toBeVisible();
  });
}
