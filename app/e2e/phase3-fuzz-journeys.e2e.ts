import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { AsyncTaskView, BotSummary, TranscriptEntry } from "@synapse/shared";
import { sidebarRow } from "./fuzz-helpers";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors, type PageErrors } from "./page-errors";

// Task 30 fuzz pass, Layer 2: the Phase 3 surfaces from the brief, each driven end to end in FUZZ mode (fake brain,
// throwaway local host, fake displays and a fake RFB server), with engine-state assertions, abuse cases and zero
// console/page errors.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Api = <T>(cmd: string, args?: unknown) => Promise<T>;
interface Ctx { app: ElectronApplication; win: Page; api: Api; errors: PageErrors }

async function launch(profile: string, env: Record<string, string> = {}): Promise<Ctx> {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `${profile}-${Date.now()}`, ...env } });
  const win = await app.firstWindow();
  await completeOnboarding(win); // Phase 5: a fresh FUZZ profile opens on onboarding
  const errors = watchPageErrors(app, win, `p3:${profile}`, { console: true });
  await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  const read = () => app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  let gw = await read();
  for (let t = Date.now() + 5000; !gw && Date.now() < t; ) { await new Promise((r) => setTimeout(r, 100)); gw = await read(); }
  if (!gw) throw new Error("no __fuzzGateway");
  // Read on every call: onboarding's token step can reconnect the host on a new port (as fuzz-helpers does).
  const api: Api = async <T>(cmd: string, args: unknown = {}) => {
    const g = (await read()) ?? gw!;
    const r = await fetch(`${g.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${g.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
  return { app, win, api, errors };
}

const log = (win: Page) => win.getByRole("log", { name: "Conversation transcript" });
async function createBot(win: Page, name: string): Promise<void> {
  await win.getByRole("button", { name: "New chat", exact: true }).click();
  await win.getByLabel("To:").fill(name);
  await win.getByRole("option", { name: `Create "${name}" Bot` }).click();
  await expect(log(win).getByText("Hi! Tell me what you'd like help with")).toBeVisible({ timeout: 10_000 });
}
async function say(win: Page, name: string, text: string): Promise<void> {
  const c = win.getByRole("textbox", { name: `Message ${name}` });
  await c.fill(text);
  await c.press("Enter");
}
// `sidebarRow` moved to fuzz-helpers.ts once bug 43 made a row's accessible name begin with its
// Bot's name in every marker state: it is now ANCHORED there (which phase4 needs to tell "Planner"
// from the group row "Planner, Scout & Ledger"), a strictly narrower match than the whole-word one
// this file used to carry.
const botId = async (api: Api, name: string) => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === name)!.id;
const tail = async (api: Api, id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
const boxHelps = async (api: Api, id: string) => (await tail(api, id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "box-help" ? [e.message.request] : []));

test("computer: card + banner + preview + glyph → view (Exit fullscreen, monitor switcher, arrow keys) → take over (double click, Cmd chords) → I'm done", async () => {
  const { app, win, api } = await launch("p3-computer");
  await createBot(win, "Scout");
  await say(win, "Scout", "computer: hold the Denver fare");
  const card = win.getByRole("region", { name: "Computer" });
  await expect(card.getByText("Action needed")).toBeVisible();
  await expect(win.getByRole("region", { name: "Needs your attention" })).toBeVisible();
  const scout = await botId(api, "Scout");
  expect((await boxHelps(api, scout)).at(-1)).toMatchObject({ status: "pending", inControl: false });

  // A second Bot with its own screen, so the monitor switcher and arrow keys have somewhere to go.
  await createBot(win, "Piper");
  await say(win, "Piper", "computer: check the calendar");
  await expect(win.getByRole("region", { name: "Computer" }).getByText("Action needed")).toBeVisible();
  await sidebarRow(win, "Scout").click();

  // Right-panel preview and the header glyph both open the computer view; Exit fullscreen closes it without handing back.
  await win.getByRole("button", { name: "Open computer" }).click();
  const view = win.getByRole("dialog", { name: "Bots' computer" });
  await expect(view).toBeVisible();
  await expect(view.getByRole("status")).toContainText("Sign in to Northwind Air");
  await view.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(view).toBeHidden();
  expect((await boxHelps(api, scout)).at(-1)!.status).toBe("pending");
  await win.getByRole("button", { name: "Computer activity" }).click();
  await expect(view).toBeVisible();

  // Monitor switcher: one chip per running screen; arrow keys cycle while not in control.
  const chips = view.getByRole("group", { name: "Screens" }).getByRole("button");
  // Only Bots that used the computer hold a screen: viewing a Bot's preview no longer claims one (final fuzz H1),
  // so the onboarding Bot has none. Scout and Piper are the two chips.
  await expect(chips).toHaveCount(2);
  const who = view.locator(".cv-name");
  await expect(who).toHaveText("Scout");
  await win.keyboard.press("ArrowRight");
  await expect(who).toHaveText("Piper");
  await win.keyboard.press("ArrowLeft");
  await expect(who).toHaveText("Scout");
  await chips.nth(1).click();
  await expect(who).toHaveText("Piper");
  await chips.nth(0).click();
  await expect(who).toHaveText("Scout");

  // Take over (abuse: triple click) → in control once.
  const take = view.getByRole("button", { name: "Take over" });
  await take.click();
  await take.click({ timeout: 1000 }).catch(() => {});
  await take.click({ timeout: 1000 }).catch(() => {});
  await expect(view.getByRole("status")).toContainText("You're in control");
  await expect(view.getByRole("status")).toContainText("Scout is paused until you hand it back");
  expect((await boxHelps(api, scout)).at(-1)).toMatchObject({ status: "pending", inControl: true });
  // Cmd chords go to the box as Ctrl chords and must not trigger app shortcuts (palette, new chat).
  // "Scout's screen", not "noVNC" — commit 037484c: "the computer viewport is announced as the Bot's
  // screen instead of 'noVNC'" (STR.screenCaption). Surfaced once the Scout row above stopped timing
  // out this journey at step 4; the spec was never updated with the copy (bug 39 (5)).
  await view.getByRole("application", { name: "Scout's screen" }).click();
  for (const k of ["Meta+c", "Meta+v", "Meta+a", "Meta+k", "Meta+n"]) await win.keyboard.press(k);
  await expect(win.getByRole("dialog", { name: "Bots' computer" })).toBeVisible();

  await view.getByRole("button", { name: "I'm done" }).click();
  await expect(view).toBeHidden();
  await expect(log(win).getByText("Thanks for handing the computer back. The fare is on hold.")).toBeVisible();
  expect((await boxHelps(api, scout)).at(-1)!.status).toBe("handed_back");
  // The resumed turn took a Screenshot: it shows as an activity step now (T29 fix).
  expect((await tail(api, scout)).some((e) => e.kind === "tool-call" && e.name === "mcp__bot__Screenshot")).toBe(true);
  await app.close();
});

test("secret card + Secrets section + form card, with abuse", async () => {
  const { app, win, api } = await launch("p3-secrets");
  await createBot(win, "Vault");
  const id = await botId(api, "Vault");
  await say(win, "Vault", "secret: I need the Stripe key");
  const card = win.getByRole("region", { name: "Stripe test key" });
  const save = card.getByRole("button", { name: "Save securely" });
  await expect(save).toBeDisabled(); // empty value
  await card.getByLabel("Stripe test key").fill("sk_test_fuzz_1234567890");
  await save.dblclick();
  await expect(log(win).getByText("Got it, saved securely.")).toHaveCount(1, { timeout: 10_000 });
  await expect(win.locator("body")).not.toContainText("sk_test_fuzz_1234567890");
  const status = await api<{ status: { name: string }[] }>("getBotSecretsStatus", { botId: id });
  expect(status.status.map((s) => s.name)).toContain("STRIPE_KEY");

  // Secrets section: reserved names are refused with a message; a normal one saves; remove works.
  await win.getByRole("button", { name: "Bot settings" }).click();
  const section = win.getByRole("region", { name: "Secrets" });
  await expect(section.getByText("STRIPE_KEY")).toBeVisible();
  await section.getByRole("button", { name: "Add secret" }).click();
  for (const bad of ["PATH", "GOFLAGS", "MY_OPTS"]) {
    await section.getByLabel("Name").fill(bad);
    await section.getByLabel("Description (visible to your Bot)").fill("x");
    await section.getByLabel("Value").fill("value-123456789");
    await section.getByRole("button", { name: "Save secret" }).click();
    await expect(section.getByText(/reserved/)).toBeVisible();
  }
  await section.getByLabel("Name").fill("DATABASE_URL");
  await section.getByLabel("Description (visible to your Bot)").fill("Postgres for the demo");
  await section.getByLabel("Value").fill("postgres://u:p@db/x");
  await section.getByRole("button", { name: "Save secret" }).click();
  await expect(section.getByText("DATABASE_URL")).toBeVisible();
  await expect(win.locator("body")).not.toContainText("postgres://u:p@db/x");
  expect((await api<{ status: { name: string }[] }>("getBotSecretsStatus", { botId: id })).status.map((s) => s.name).sort()).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  await win.getByRole("button", { name: "Close details" }).click().catch(() => {});

  // Form card: required field, double submit answers once.
  await say(win, "Vault", "card: form");
  const form = win.getByRole("form", { name: "Trip details" });
  await expect(form).toBeVisible();
  await form.getByLabel("City").fill("Denver");
  await form.getByRole("button", { name: /Submit|Send/ }).dblclick();
  await expect.poll(async () => (await tail(api, id)).filter((e) => e.kind === "send-message" && e.message.type === "card" && (e as { status?: string }).status === "answered").length).toBe(1);
  await app.close();
});

test("Settings → Updates: Update in FUZZ fails cleanly; Reset asks twice and Cancel backs out; background Shell revives the Bot", async () => {
  const { app, win, api } = await launch("p3-updates");
  await createBot(win, "Runner");
  const id = await botId(api, "Runner");
  await say(win, "Runner", "bg: sleep 1; echo fuzz-bg-done");
  await expect(log(win).getByText("Started that in the background")).toBeVisible();
  await expect(log(win).getByText(/The background command finished/)).toBeVisible({ timeout: 20_000 });
  const tasks = (await api<{ tasks: AsyncTaskView[] }>("getAsyncTasks", { id })).tasks;
  expect(tasks.some((t) => t.kind === "shell" && t.status === "done")).toBe(true);
  expect((await tail(api, id)).some((e) => e.kind === "tool-call" && e.name === "mcp__bot__Shell" && e.metric?.verb === "Ran")).toBe(true);

  await api("snapshotBoxStoreNow", { reason: "manual" }); // a backup exists, so Reset is offered
  await win.keyboard.press("Meta+,");
  await win.getByRole("button", { name: "Updates" }).click();
  await expect(win.getByRole("heading", { name: "Update Bots' computer" })).toBeVisible();
  const update = win.getByRole("button", { name: "Update", exact: true });
  if (await update.isVisible()) {
    await update.click();
    await expect(win.getByText(/Not available in FUZZ mode/)).toBeVisible();
  }
  await win.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(win.getByRole("button", { name: "Reset now" })).toBeVisible();
  await win.getByRole("button", { name: "Cancel" }).click();
  await expect(win.getByRole("button", { name: "Reset now" })).toHaveCount(0);
  await expect(win.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
  await win.setViewportSize({ width: 800, height: 600 }).catch(() => {});
  await app.close();
});

test("disk banner → Open Disk Saver opens the Disk Saver Bot", async () => {
  const pct = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p3-disk-")), "free-pct");
  fs.writeFileSync(pct, "3");
  const { app, win, api } = await launch("p3-disk", { FUZZ_DISK_FREE_FILE: pct });
  await createBot(win, "Filler");
  const banner = win.getByRole("region", { name: "Disk space" });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole("button", { name: "Open Disk Saver" }).dblclick();
  await expect.poll(async () => (await api<{ agents: BotSummary[] }>("listAgents")).agents.filter((a) => /Disk Saver/.test(a.profile.name)).length).toBe(1);
  await expect(win.getByRole("textbox", { name: /Message Disk Saver/ })).toBeVisible();
  await app.close();
});
