import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { MCP_HEADER_REDACTED } from "@synapse/shared";
import { E2E_TEST_API_KEY } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * ⚠️ NOT RUN as part of the change that added it. This spec launches a real Electron window (and can
 * touch the keychain), which the author of this branch was asked not to do on the user's screen. It
 * is written, it collects (`app/test/e2e-collection.test.ts` imports it on every `npm test`), and it
 * has never been executed — treat every assertion below as unverified until someone runs
 * `npm run e2e` in app/ and reports the result.
 *
 * What it is for: the unit tests prove the credential does not reach disk, the logs or the published
 * view, but they prove it about functions. This proves it about the window the user actually types
 * into — that the key they paste is not sitting in the DOM afterwards, which is the one place the
 * unit tests cannot look.
 */
test("a header-authenticated remote MCP server: added from the form, shown as set, replaced, removed", async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-hdr-${Date.now()}` } });
  const page = await app.firstWindow();
  watchPageErrors(app, page, "mcp header auth", { console: true });

  const KEY = "e2e-canary-key-do-not-persist";

  // Onboarding, the same opening as phase5.e2e.ts.
  await page.getByRole("button", { name: "Add API key" }).click();
  // synapse-public: the Anthropic API key is the only sign-in (a stand-in key; the fake brain never calls out).
  await page.getByLabel("Anthropic API key").fill(E2E_TEST_API_KEY);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("heading", { name: "Meet Synapse" })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Name").fill("Scout");
  await page.getByRole("button", { name: "Get started" }).click();

  await page.getByRole("button", { name: "Marketplace" }).click();
  const dlg = page.getByRole("dialog", { name: "Marketplace" });
  await dlg.getByRole("link", { name: /Your plugins, \d+ installed/ }).click();

  // Add the server with its key in one step.
  await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
  await dlg.getByLabel("Name").fill("Keyed");
  await dlg.getByLabel("Server URL").fill("https://connect.example.invalid/mcp");
  await dlg.getByLabel("Header name").fill("x-consumer-api-key");
  await dlg.getByLabel("Header value").fill(KEY);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();

  // The card says the key is set, and says it with a redaction.
  const card = dlg.getByRole("group", { name: "Keyed" });
  await expect(card.getByText("x-consumer-api-key")).toBeVisible();
  await expect(card.getByText(MCP_HEADER_REDACTED)).toBeVisible();

  // THE POINT: the value is nowhere in the window any more. Not in the DOM, not in a React prop
  // serialized into it, not left in the add form. The host never sent it back, so there is nothing
  // for the renderer to be holding.
  expect(await page.content()).not.toContain(KEY);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(KEY);

  // Replace: the field starts empty (a full one would mean the value came back from the host).
  await card.getByRole("button", { name: "Replace x-consumer-api-key" }).click();
  await expect(card.getByLabel("Header value")).toHaveValue("");
  await card.getByLabel("Header value").fill(`${KEY}-rotated`);
  await card.getByRole("button", { name: "Save header" }).click();
  await expect(card.getByText(MCP_HEADER_REDACTED)).toBeVisible();
  expect(await page.content()).not.toContain(KEY);

  // Remove: the row goes, and the server keeps working as an unauthenticated one.
  await card.getByRole("button", { name: "Remove x-consumer-api-key" }).click();
  await expect(card.getByText("x-consumer-api-key")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Add header" })).toBeVisible();

  // http is refused with the reason, so a credential can never be paired with a plaintext url.
  await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
  await dlg.getByLabel("Name").fill("Plaintext");
  await dlg.getByLabel("Server URL").fill("http://connect.example.invalid/mcp");
  await dlg.getByLabel("Header name").fill("x-consumer-api-key");
  await dlg.getByLabel("Header value").fill(KEY);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByRole("alert")).toContainText("https");

  await app.close();
});
