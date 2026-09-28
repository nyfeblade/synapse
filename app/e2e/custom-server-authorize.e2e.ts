import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { E2E_TEST_API_KEY } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * ⚠️ NOT RUN as part of the change that added it. This spec launches a real Electron window, which
 * the author of this branch was asked not to do on the user's screen. It is written, it collects
 * (`app/test/e2e-collection.test.ts` imports it on every `npm test`), and it has NEVER BEEN
 * EXECUTED — treat every assertion below as unverified until someone runs `npm run e2e` in app/ and
 * reports the result.
 *
 * What it is for (bug 53): `server-row-actions.test.tsx` proves the row offers the control and that
 * pressing it issues the command, but it proves it against a mocked bridge. This proves the part
 * the unit test cannot reach — that a server the USER adds through the form, against an endpoint
 * that really answers 401, lands in the Installed list in a state the user can act on. The whole
 * bug was that the two halves (the host's correct `needs-auth`, the renderer's row) had never been
 * put on screen together.
 */
test("a custom MCP server that needs signing in can be signed in to from Manage plugins", async () => {
  // An endpoint that answers 401 to everything: the host reads that as `needs-auth` (McpProxyPool
  // .ensure → isAuthError), which is exactly the state the user reported against Composio.
  const unauthorized = http.createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); });
  await new Promise<void>((r) => unauthorized.listen(0, "127.0.0.1", r));
  const port = (unauthorized.address() as { port: number }).port;

  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-auth-${Date.now()}` } });
  const page = await app.firstWindow();
  watchPageErrors(app, page, "custom server authorize", { console: true });

  // Onboarding, the same opening as mcp-header-auth.e2e.ts.
  await page.getByRole("button", { name: "Input API Key →" }).click();
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

  // The user's own server — in no catalog, so the Marketplace pill that used to carry the only
  // Authorize button in the app can never render for it.
  await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
  await dlg.getByLabel("Name").fill("Composio");
  await dlg.getByLabel("Server URL").fill(`https://127.0.0.1:${port}/mcp`);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();

  const card = dlg.getByRole("group", { name: "Composio" });
  await expect(card.getByText("Needs sign-in")).toBeVisible();

  // THE POINT OF BUG 53: there is a way to sign in, in the list the server actually appears in.
  const authorize = card.getByRole("button", { name: "Authorize Composio" });
  await expect(authorize).toBeEnabled();
  await authorize.click();

  // And the row stops claiming the user has not started. Either the flow opened (the row says so
  // and offers the way back to a lost tab) or the host refused and said why — never silence, and
  // never "Needs sign-in" over a sign-in that is already under way.
  await expect(card.getByText("Waiting for authorization").or(card.getByRole("alert"))).toBeVisible();

  // The neighbouring state, from the same list: an endpoint that is simply not there reads Failed,
  // and Failed is something the user can retry without deleting and re-adding the server.
  await dlg.getByRole("button", { name: "Add custom MCP server" }).click();
  await dlg.getByLabel("Name").fill("Gone");
  await dlg.getByLabel("Server URL").fill("https://connect.example.invalid/mcp");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  const gone = dlg.getByRole("group", { name: "Gone" });
  await expect(gone.getByText("Failed")).toBeVisible();
  await expect(gone.getByRole("button", { name: "Retry Gone" })).toBeEnabled();
  await gone.getByRole("button", { name: "Retry Gone" }).click();
  await expect(gone.getByText("Failed")).toBeVisible();

  await app.close();
  await new Promise<void>((r) => unauthorized.close(() => r()));
});
