import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * Screens for the owner's review of the multi-provider UI (spec §10), light and dark, into
 * test-reports/providers-ui-2026-09-30/. The app runs in FUZZ mode with its data in the run's ISOLATED temp folder
 * (isolated-app-data.ts sets SYNAPSE_APP_DATA): never the real ~/Library/Application Support/Synapse. The OpenAI key is
 * a made-up one (FUZZ answers the key test offline) and nothing reaches a provider.
 *
 * The model badges come from the host's evidence file; this run writes measured-looking records into the isolated
 * host's copy (one model per state) so every badge is on screen. Real records come from runProviderConformance and
 * npm run bench:provider-gate.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../test-reports/providers-ui-2026-09-30");

function findHostPrivate(root: string): string | null {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    if (es.some((e) => e.isDirectory() && e.name === "provider-auth")) return d;
    for (const e of es) if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(d, e.name));
  }
  return null;
}

function seedEvidence(hostPrivate: string): void {
  const now = Date.now();
  const flags = { parallelTools: true, cachedTokens: true, vision: true, toolImages: true, reasoningEffort: true, structuredOutput: true, streamedArgs: true };
  const pass = (ids: string[]) => ids.map((id) => ({ id, status: "pass", detail: "", ms: 1 }));
  const all = Array.from({ length: 15 }, (_, i) => `PC-${String(i + 1).padStart(2, "0")}`);
  const conformance = {
    "openai:gpt-6.1-sol": { ref: "openai:gpt-6.1-sol", at: now, version: 1, results: pass(all), mustPass: true, flags },
    "openai:gpt-6-luna": { ref: "openai:gpt-6-luna", at: now, version: 1, results: pass(all), mustPass: true, flags },
    "openai:gpt-6-astra": { ref: "openai:gpt-6-astra", at: now, version: 1, results: [...pass(all.filter((x) => x !== "PC-11")), { id: "PC-11", status: "fail", detail: "kept streaming", ms: 1 }], mustPass: false, flags },
  };
  const bench = { "openai:gpt-6.1-sol": { ref: "openai:gpt-6.1-sol", at: now, passRate: 0.85, claudePassRate: 0.92, ratio: 0.92, trapsOk: true, passed: true, tasks: 13, report: "" } };
  fs.writeFileSync(path.join(hostPrivate, "provider-evidence.json"), JSON.stringify({ conformance, bench }));
}

async function shot(win: Page, name: string, scheme: "light" | "dark"): Promise<void> {
  await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`), animations: "disabled" });
}

/** The first-run prompts (a monthly budget after a key is saved) sit over the page: "Not now". */
async function dismissPrompts(win: Page): Promise<void> {
  const prompts = win.locator(".key-prompts");
  for (let i = 0; i < 3 && (await prompts.isVisible().catch(() => false)); i++) {
    await prompts.getByRole("button", { name: "Not now" }).first().click().catch(() => {});
    await win.waitForTimeout(200);
  }
}

test("providers UI: Accounts, consent, the grouped model picker, the Composer menu and the safety reviewer", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataRoot = process.env.SYNAPSE_APP_DATA!;
  expect(dataRoot, "isolated app data").toBeTruthy();
  expect(dataRoot.includes("Library/Application Support")).toBe(false);
  const { app, win } = await launch("providers-ui");
  // The sidebar's account button shows the Mac's user name. The screens use a neutral one instead (an earlier run
  // masked the button, which left a grey block in the corner): main's app-info answer is replaced, then reloaded.
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("app-info"); ipcMain.handle("app-info", () => ({ userName: "Alex Morgan" })); });
  await win.reload();
  await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await expect(win.getByRole("button", { name: "Open account menu" })).toContainText("Alex Morgan", { timeout: 10_000 });
  await win.setViewportSize({ width: 1280, height: 820 });

  // Settings → Account: allow OpenAI (the consent sheet), save a made-up key, allow Ollama.
  await win.getByRole("button", { name: "Open account menu" }).click();
  await win.getByRole("menuitem", { name: "Settings" }).click();
  await win.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account" }).click();
  await dismissPrompts(win);
  const openai = win.getByLabel("OpenAI", { exact: true });
  await openai.getByRole("button", { name: "Allow" }).click();
  const sheet = win.getByRole("region", { name: "Use OpenAI?" });
  await expect(sheet).toBeVisible();
  await sheet.scrollIntoViewIfNeeded();
  for (const scheme of ["light", "dark"] as const) { await win.emulateMedia({ colorScheme: scheme }); await shot(win, "01-consent-sheet", scheme); }
  await win.emulateMedia({ colorScheme: "light" });
  await sheet.getByRole("button", { name: "Allow" }).click();
  await win.getByLabel("OpenAI key").fill("sk-e2e-screenshot-0123456789abcd");
  await openai.getByRole("button", { name: "Save" }).click();
  await expect(openai.getByText("sk-…abcd")).toBeVisible({ timeout: 10_000 });
  const ollama = win.getByLabel("Ollama", { exact: true });
  await ollama.getByRole("button", { name: "Allow" }).click();
  await win.getByRole("region", { name: "Use Ollama?" }).getByRole("button", { name: "Allow" }).click();
  await expect(ollama.getByText("Allowed")).toBeVisible();
  await dismissPrompts(win);
  const block = win.locator(".providers-block");
  await block.scrollIntoViewIfNeeded();
  for (const scheme of ["light", "dark"] as const) { await win.emulateMedia({ colorScheme: scheme }); await shot(win, "02-accounts", scheme); }
  await win.emulateMedia({ colorScheme: "light" });

  // The measured evidence (one model per badge state), in the isolated host's private folder.
  // The FUZZ local host keeps its own data in a disposable temp folder (local-host.ts: synapse-fuzz-*), not in Library.
  const fuzzRoots = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("synapse-fuzz-")).map((n) => path.join(os.tmpdir(), n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const hp = fuzzRoots.map((r) => findHostPrivate(r)).find(Boolean) ?? null;
  expect(hp, "the isolated host's private folder").toBeTruthy();
  seedEvidence(hp!);

  // Settings → Auto-review → Safety reviewer.
  await win.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Auto-review" }).click();
  const safety = win.getByLabel("Safety reviewer");
  await expect(safety).toBeVisible();
  await dismissPrompts(win);
  // The reviewer on OpenAI's small model: not checked yet, so ask-only until its safety check passes.
  await safety.getByLabel("Reviewer model").selectOption({ label: "GPT-6 Luna · OpenAI" });
  await expect(safety.getByRole("status")).toHaveText("Not checked");
  await safety.scrollIntoViewIfNeeded();
  for (const scheme of ["light", "dark"] as const) { await win.emulateMedia({ colorScheme: scheme }); await shot(win, "03-safety-reviewer", scheme); }
  await win.emulateMedia({ colorScheme: "light" });
  await win.keyboard.press("Escape");

  await dismissPrompts(win);
  // A Bot on OpenAI: the grouped picker in Bot settings, with What works and the cost line.
  await createBot(win, "Iris");
  if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
  await win.getByRole("button", { name: "Bot settings" }).click();
  await win.getByRole("button", { name: /^Model: / }).click();
  await win.getByRole("option", { name: /GPT-6\.1 Sol/ }).click();
  await expect(win.getByRole("button", { name: "Model: GPT-6.1 Sol · OpenAI" })).toBeVisible();
  // The field near the top of the panel, as a user scrolls to it, so the whole list fits below it.
  await win.getByRole("button", { name: /^Model: / }).evaluate((el) => { el.scrollIntoView({ block: "start" }); el.closest(".panel")?.scrollBy(0, -48); });
  await win.getByRole("button", { name: /^Model: / }).click();
  // The list opens on the current model (it scrolls inside itself); a pointer move, not hover(), so nothing scrolls.
  const sol = await win.getByRole("option", { name: /GPT-6\.1 Sol/ }).boundingBox();
  await win.mouse.move(sol!.x + sol!.width / 2, sol!.y + sol!.height / 2);
  await expect(win.getByRole("region", { name: "GPT-6.1 Sol: what works" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) { await win.emulateMedia({ colorScheme: scheme }); await shot(win, "04-model-picker", scheme); }
  await win.emulateMedia({ colorScheme: "light" });
  await win.keyboard.press("Escape");

  // The Composer's model menu, grouped, with badges.
  await win.getByRole("button", { name: "GPT-6.1 Sol · OpenAI", exact: true }).click();
  await expect(win.getByRole("menuitemradio", { name: /GPT-6 Astra/ })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) { await win.emulateMedia({ colorScheme: scheme }); await shot(win, "05-composer-menu", scheme); }
  await win.emulateMedia({ colorScheme: "light" });
  await win.keyboard.press("Escape");
  await app.close();
});
