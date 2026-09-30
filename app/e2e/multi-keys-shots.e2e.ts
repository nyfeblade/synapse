import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createBot, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * 0.1.7: several keys per provider and the one searchable model picker, photographed in light and dark in the real app
 * (FUZZ local host, fake brain) with an ISOLATED userData (globalSetup's SYNAPSE_APP_DATA) and a throwaway HOME. The
 * keys are made up (FUZZ answers key tests offline) and go in through the real sealed IPC path; nothing reaches a
 * provider. Local models are the live list of whatever answers on this Mac. The Mac account name is replaced and masked.
 *
 *   MULTI_KEYS_SHOTS=<outDir> npx playwright test -c e2e/playwright.config.ts multi-keys-shots
 */
const OUT = process.env.MULTI_KEYS_SHOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
test.skip(!OUT, "screenshots only when MULTI_KEYS_SHOTS names an output folder");

async function dismissPrompts(win: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const notNow = win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first();
    if (!(await notNow.isVisible({ timeout: 1500 }).catch(() => false))) break;
    await notNow.click({ timeout: 3000 }).catch(() => {});
    await win.waitForTimeout(300);
  }
}

test("keys in Settings, the full picker, search, and the Composer's compact picker, light and dark", async () => {
  test.setTimeout(240_000);
  const out = path.resolve(path.join(__dirname, ".."), OUT!);
  fs.mkdirSync(out, { recursive: true });
  const realUser = os.userInfo().username;
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-home-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { app, win, api } = await launch("multi-keys-shots");
    expect((await app.evaluate(({ app: a }) => a.getPath("userData"))).startsWith(process.env.SYNAPSE_APP_DATA!)).toBe(true);
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("app-info"); ipcMain.handle("app-info", () => ({ userName: "Alex Morgan" })); });
    await win.reload();
    await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    await win.addLocatorHandler(win.locator(".key-prompts .key-prompt").first(), async () => {
      await win.locator(".key-prompts").getByRole("button", { name: "Not now" }).first().click({ timeout: 3000 }).catch(() => {});
    });
    await win.setViewportSize({ width: 1280, height: 820 });
    await dismissPrompts(win);

    // Providers allowed, then keys through the sealed IPC path: two OpenAI keys, one Gemini key; Ollama on this Mac.
    for (const provider of ["openai", "gemini", "ollama"]) await api("consentProvider", { provider, textVersion: 1 });
    const add = (p: string, key: string, label: string) => win.evaluate(([a, b, c]) => (window as unknown as { synapse: { providers: { addKey(p: string, k: string, l: string): Promise<unknown> } } }).synapse.providers.addKey(a!, b!, c!), [p, key, label]);
    await add("openai", "sk-proj-e2ePersonal0123456789abcd", "Personal");
    await add("openai", "sk-proj-e2eWorkKey0123456789wxyz", "Work");
    await add("gemini", "AIzaSyE2E-screenshot-0123456789abcdef", "Gemini");

    // Two Bots with turns, so Recent has something: Iris on GPT-6.1 Sol paid by Work, Scout on Opus.
    await createBot(win, "Scout");
    await dismissPrompts(win);
    await createBot(win, "Iris");
    await dismissPrompts(win);
    const bots = await api<{ agents: { id: string; profile: { name: string } }[] }>("listAgents");
    const id = (n: string) => bots.agents.find((b) => b.profile.name === n)!.id;
    const keys = await api<{ rings: { provider: string; keys: { id: string; label: string }[] }[] }>("getKeys");
    const work = keys.rings.find((r) => r.provider === "openai")!.keys.find((k) => k.label === "Work")!.id;
    await api("pickAgentModel", { id: id("Scout"), model: "claude-opus-5-5", keyId: null });
    await api("pickAgentModel", { id: id("Iris"), model: "openai:gpt-6.1-sol", keyId: work });
    // A model on this Mac: the FUZZ host can't reach Ollama's live list from here (it asks the Bots' computer's
    // address for this Mac), so a Bot that uses a local model puts it in the picker the way the live list would.
    const onboarded = bots.agents.find((b) => !["Scout", "Iris"].includes(b.profile.name));
    if (onboarded) await api("pickAgentModel", { id: onboarded.id, model: "ollama:qwen3:4b" });
    // Both turns run offline: Scout on the fake brain, Iris on the in-process fake OpenAI (auth/fake-providers.ts).
    for (const n of ["Scout", "Iris"]) await api("sendPrompt", { id: id(n), text: "Say hi.", clientNonce: `n-${n}` });
    await expect(win.getByText("stand-in reply", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const shoot = async (sel: string, name: string, full = false) => {
      for (const scheme of ["light", "dark"] as const) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.waitForTimeout(350);
        const text = await win.locator(full ? "body" : sel).first().innerText();
        expect(text.toLowerCase()).not.toContain(realUser.toLowerCase());
        const mask = [win.getByText(realUser, { exact: false })];
        if (full) await win.screenshot({ path: path.join(out, `${name}-${scheme}.png`), animations: "disabled", mask });
        else await win.locator(sel).first().screenshot({ path: path.join(out, `${name}-${scheme}.png`), animations: "disabled", mask });
      }
      await win.emulateMedia({ colorScheme: "light" });
    };

    // Settings → Account: the Anthropic key list, and each provider's keys.
    await win.getByRole("button", { name: "Open account menu" }).click();
    await win.getByRole("menuitem", { name: "Settings" }).click();
    await win.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account" }).click();
    await dismissPrompts(win);
    await expect(win.getByLabel("Work", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await shoot(".account-panel", "accounts-anthropic");
    await win.locator(".providers-block").first().scrollIntoViewIfNeeded();
    await shoot(".providers-block", "accounts-keys");
    await win.keyboard.press("Escape");
    await win.keyboard.press("Escape");

    // Bot settings (Iris): the full picker — Recent, Anthropic, OpenAI once per key, Gemini, local models.
    await expect(win.getByRole("button", { name: "Bot settings" }).or(win.getByRole("button", { name: "View conversation details" })).first()).toBeVisible();
    if (!(await win.getByRole("button", { name: "Bot settings" }).isVisible())) await win.getByRole("button", { name: "View conversation details" }).click();
    await win.getByRole("button", { name: "Bot settings" }).click();
    const trigger = win.getByRole("button", { name: /^Model: / });
    await trigger.evaluate((el) => { el.scrollIntoView({ block: "start" }); el.closest(".panel")?.scrollBy(0, -48); });
    await trigger.click();
    const list = win.getByRole("listbox", { name: "Model" });
    await expect(list.getByRole("group", { name: "Recent" })).toBeVisible({ timeout: 10_000 });
    await expect(list.getByRole("option", { name: "GPT-6.1 Sol · Work" }).first()).toBeVisible();
    // The open picker keeps its whole trigger in view (the panel isn't scrolled under it).
    const triggerFits = async () => trigger.evaluate((el) => { const p = el.closest(".panel")!.getBoundingClientRect(); const r = el.getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom; });
    expect(await triggerFits()).toBe(true);
    await shoot("body", "picker-full", true);
    // The foot of the same list: Gemini and the model on this Mac.
    await list.getByRole("group", { name: "Ollama" }).evaluate((el) => { const box = el.closest(".model-pop") as HTMLElement; box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2; });
    expect(await triggerFits()).toBe(true);
    await shoot("body", "picker-full-local", true);
    await list.evaluate((el) => { (el.closest(".model-pop") as HTMLElement | null)?.scrollTo({ top: 0 }); });

    // Search: typing narrows every provider and key at once.
    await win.keyboard.type("work");
    await expect(list.getByRole("group", { name: "Recent" })).toHaveCount(0);
    await shoot("body", "picker-search", true);
    await win.keyboard.press("Escape");

    // The Composer's model chip: the same picker, compact — recent and in-use models, then All models….
    await win.getByRole("button", { name: /^GPT-6\.1 Sol · OpenAI/ }).first().click();
    await expect(win.locator(".composer-model-pop").getByRole("option", { name: "All models…" })).toBeVisible();
    await shoot("body", "composer-compact", true);
    await win.locator(".composer-model-pop").getByRole("option", { name: "All models…" }).click();
    await expect(win.locator(".composer-model-pop").getByRole("group", { name: "OpenAI" })).toBeVisible();
    await shoot("body", "composer-all-models", true);
    await win.keyboard.press("Escape");

    // Creating a Bot: its model, and with two OpenAI keys, which one pays (the default preselected).
    await win.getByRole("button", { name: "New chat", exact: true }).click();
    const step = win.getByRole("group", { name: "Model" });
    await step.getByRole("button", { name: /^Model: / }).click();
    await step.getByRole("option", { name: "All models…" }).click();
    await step.getByRole("combobox", { name: "Search models" }).fill("sol");
    await step.getByRole("option", { name: "GPT-6.1 Sol · Personal" }).click();
    await expect(step.getByRole("radio", { name: "Personal" })).toHaveAttribute("aria-checked", "true");
    await shoot("body", "create-bot-step", true);
    await step.getByRole("button", { name: /^Model: / }).click();
    await shoot("body", "create-bot-picker", true);
    await win.keyboard.press("Escape");
    await win.getByRole("button", { name: "Cancel new chat" }).click();

    // The minimum window: no sideways scroll in the picker.
    await win.setViewportSize({ width: 1024, height: 680 });
    await win.getByRole("button", { name: /^GPT-6\.1 Sol · OpenAI/ }).first().click();
    await win.locator(".composer-model-pop").getByRole("option", { name: "All models…" }).click();
    const overflow = await win.evaluate(() => {
      const pop = document.querySelector(".composer-model-pop") as HTMLElement;
      return { page: document.documentElement.scrollWidth > window.innerWidth, pop: pop.scrollWidth > pop.clientWidth };
    });
    expect(overflow).toEqual({ page: false, pop: false });
    await shoot("body", "composer-min-width", true);
    await app.close();
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
