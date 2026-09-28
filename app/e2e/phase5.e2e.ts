import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { E2E_TEST_API_KEY } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Phase 5 journey: onboarding → Marketplace connect → local command → template → usage → settings", async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-save-"));
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-p5-${Date.now()}`, E2E_SAVE_DIR: saveDir } });
  const page = await app.firstWindow();
  // Page errors as well as console errors: this journey watched only the console, so a render throw
  // during onboarding was invisible to it.
  watchPageErrors(app, page, "phase5 journey", { console: true });

  // Onboarding (ONB-01…05): a stand-in API key
  await page.getByRole("button", { name: "Input API Key →" }).click();
  // synapse-public: the Anthropic API key is the only sign-in (a stand-in key; the fake brain never calls out).
  await page.getByLabel("Anthropic API key").fill(E2E_TEST_API_KEY);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("heading", { name: "Meet Synapse" })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("checkbox", { name: "Slack" }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Name").fill("Scout");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("link", { name: /Scout/ }).first()).toBeVisible();

  // Marketplace (PLG-01, PLG-04): add a curated connector; FUZZ completes the fake OAuth
  await page.getByRole("button", { name: "Marketplace" }).click();
  const dlg = page.getByRole("dialog", { name: "Marketplace" });
  await dlg.getByRole("button", { name: "Add Linear" }).click();
  await expect(dlg.getByRole("button", { name: /Linear: ✓ (Added|Connected)/ })).toBeVisible();
  await dlg.getByRole("link", { name: /Your plugins, \d+ installed/ }).click();
  await expect(dlg.getByRole("group", { name: "Linear" })).toBeVisible();
  await dlg.getByRole("group", { name: "Linear" }).getByRole("switch", { name: "delete_item" }).click();
  await dlg.getByRole("button", { name: "Close Marketplace" }).click();

  // Palette (PAL-04): catalog results come from the Marketplace; choosing one opens its detail
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Linear");
  await palette.getByRole("option", { name: /Linear/ }).first().click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Close Marketplace" }).click();

  // Local execution (LOC-04): card → Allow once → output relayed
  await page.getByRole("textbox", { name: "Message Scout" }).fill("local: echo hello-from-e2e");
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Local computer request" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow once" }).click();
  // Scope to the transcript: the sidebar row also mirrors the latest text.
  await expect(page.getByRole("log", { name: "Conversation transcript" }).getByText("Done on your Mac.")).toBeVisible();

  // Template (TPL-01): Share as Template → Save → file written; then add a starter from the Marketplace (TPL-02)
  await page.getByRole("button", { name: "Template actions" }).click();
  await page.getByRole("menuitem", { name: "Share as Template" }).click();
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText(/Saved to .*scout\.botpack/)).toBeVisible();
  expect(fs.existsSync(path.join(saveDir, "scout.botpack"))).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Marketplace" }).click();
  await page.getByRole("button", { name: "Add Inbox Triage" }).click();
  await expect(page.getByText("Jobs that run on their own").or(page.getByText("Facts it already knows")).or(page.getByRole("button", { name: "Add Bot" }))).toBeVisible();
  await page.getByRole("button", { name: "Add Bot" }).click();
  await expect(page.getByRole("link", { name: /Inbox Triage/ }).first()).toBeVisible();

  // Usage (USE-01, USE-06): the demo turn reported 42 %
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Weekly usage 42%" }).click();
  await expect(page.getByRole("progressbar", { name: "Weekly usage" })).toHaveAttribute("aria-valuenow", "42");

  // Settings: Computer, Security Key (D15-B), Updates (no feed in FUZZ)
  await page.getByRole("button", { name: "Computer", exact: true }).click();
  // Bug 39 (7) — STALE SPEC, not a broken app. Commit 5548c45 ("show locked network routing as status,
  // not a dead switch", bug 9) replaced the permanently-disabled switch with a status readout, because
  // there is no routing logic behind it and "a control that can never be operated shouldn't be drawn as
  // one". Both halves of the original claim are kept and neither is loosened: the setting is still not
  // operable (no switch exists at all — strictly stronger than a switch that exists and is disabled),
  // and it now also has to SAY what it is, which a disabled switch never did.
  await expect(page.getByRole("switch", { name: "Route traffic through this computer" })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Route traffic through this computer: On" })).toBeVisible();
  await page.getByRole("button", { name: "General" }).click();
  await expect(page.getByRole("switch", { name: "Use hardware security keys" })).toBeDisabled();
  await expect(page.getByText("Coming later")).toBeVisible();
  await page.getByRole("button", { name: "Updates" }).click();
  await expect(page.getByRole("button", { name: "Check for Updates" })).toBeVisible();

  await app.close();
});
