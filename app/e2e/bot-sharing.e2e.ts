import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { decodeShare, type BotSummary } from "@synapse/shared";
// @ts-expect-error plain ESM build script, no types
import { loadCatalogue } from "../../site/build.mjs";
import { completeOnboarding } from "./onboarding";
import { step, test, watchPageErrors } from "./page-errors";

// Bot sharing, phase 5: the whole path in the real app (FUZZ=1: the fake brain, a disposable host, no real
// clipboard — the renderer's and the main process's clipboard are stubbed — and no share menu, which is recorded).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.BOT_SHARING_SHOTS ?? "";
const timings: Record<string, number> = {};
const SITE = "https://synapse-site-virid.vercel.app";

type Api = <T>(cmd: string, args?: unknown) => Promise<T>;
async function gatewayApi(app: ElectronApplication): Promise<Api> {
  const read = () => app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  let gw = await read();
  const deadline = Date.now() + 10_000;
  while (!gw && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); gw = await read(); }
  if (!gw) throw new Error("expected globalThis.__fuzzGateway in the FUZZ main process");
  return async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    const r = await fetch(`${gw.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${gw.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
}

interface Launched { app: ElectronApplication; win: Page; saveDir: string }
async function launch(tag: string, o: { onboard?: boolean; env?: Record<string, string> } = {}): Promise<Launched> {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), `share-e2e-${tag}-`));
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `share-e2e-${tag}-${Date.now()}`, E2E_SAVE_DIR: saveDir, ...o.env } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, `share:${tag}`, { console: true });
  if (o.onboard !== false) await completeOnboarding(win, "Scout");
  return { app, win, saveDir };
}
/** One link, as a click would deliver it. Links closer than 1 s are one click (security review), so each waits its turn. */
let lastLink = 0;
const openUrl = async (app: ElectronApplication, url: string, o: { flood?: boolean } = {}) => {
  if (!o.flood) { const wait = lastLink + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
  lastLink = Date.now();
  await app.evaluate(({ app: a }, u) => { a.emit("open-url", { preventDefault() {} }, u); }, url);
};
const agents = async (api: Api) => (await api<{ agents: BotSummary[] }>("listAgents")).agents;
/** After the surfaces' entrance and exit motion has settled. */
const shot = async (win: Page, name: string) => {
  if (!SHOTS) return;
  // FUZZ's monthly-budget prompt (not part of sharing) would sit over the sheet in the picture.
  const notNow = win.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click({ force: true }).catch(() => {});
  await win.waitForTimeout(900); await win.screenshot({ path: path.join(SHOTS, name) }); };
const stubRendererClipboard = (win: Page) => win.evaluate(() => {
  const w = window as unknown as { __copied?: string };
  navigator.clipboard.writeText = async (t: string) => { w.__copied = t; };
});
const copied = (win: Page) => win.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? null);

test.afterAll(() => { if (SHOTS) fs.writeFileSync(path.join(SHOTS, "e2e-timings.json"), `${JSON.stringify(timings, null, 2)}\n`); });

test("share, copy, open the link, add in Ask mode; duplicates, cancel, bad links, twenty clicks, in-chat links, too big, catalogue, export for website", async () => {
  test.setTimeout(240_000);
  const { app, win, saveDir } = await launch("main", { env: { SYNAPSE_OWNER: "1" } });
  try {
    const api = await gatewayApi(app);
    await stubRendererClipboard(win);
    await api("createWorkflow", { name: "field-notes", description: "Keeps research notes", body: "Write notes in the workspace.\n\n```bash\nls notes\n```\n" });
    const scout = (await agents(api)).find((a) => a.profile.name === "Scout")!;
    await api("updateAgent", { id: scout.id, title: "Research", description: "Research questions and write short reports with sources. Keep notes in the workspace and say when evidence is thin." });

    let link = "";
    await step("Share Bot, Copy link", async () => {
      await win.getByRole("button", { name: "More actions" }).click();
      await win.getByRole("menuitem", { name: "Share Bot…" }).click();
      const sheet = win.getByRole("dialog", { name: "Scout" });
      await expect(sheet.getByText("Never included: memory, chats, keys, accounts.")).toBeVisible();
      await expect(sheet.getByText("Runs code")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Copy link" })).toBeFocused(); // the default on Enter
      // Security review: only a Bot's own skills and tools start ticked; the shared library's start unticked.
      const notes = sheet.getByRole("checkbox", { name: /^field-notes/ });
      await expect(notes).not.toBeChecked();
      await notes.check();
      await expect(notes).toBeChecked();
      await sheet.getByRole("button", { name: "Copy link" }).focus();
      await shot(win, "app-share-sheet.png");
      await sheet.getByRole("button", { name: "Copy link" }).focus(); // the shot's dismissal of the budget prompt moved focus
      await win.keyboard.press("Enter"); // Copy link is the default
      await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
      await sheet.getByRole("button", { name: "Share…" }).click();
      link = (await copied(win))!;
      expect(link.startsWith(`${SITE}/bot#b1.`)).toBe(true);
      const menuCalls = await app.evaluate(() => (globalThis as unknown as { __shareMenuCalls?: { url: string }[] }).__shareMenuCalls ?? []);
      expect(menuCalls).toEqual([{ url: link }]);
      const d = await decodeShare(link);
      expect(d.ok).toBe(true);
      expect(d.payload).toMatchObject({ name: "Scout", shape: scout.profile.avatarShape, color: scout.profile.avatarColor });
      expect(d.payload!.skills.map((s) => s.name)).toContain("field-notes");
      expect(JSON.stringify(d.payload)).not.toMatch(/memor|routine|author|sourceBot|avatar\./i);
      await sheet.getByRole("button", { name: "Close" }).click();
    });

    await step("the menu's one-click Copy link", async () => {
      await win.evaluate(() => { (window as unknown as { __copied?: string }).__copied = ""; });
      await win.getByRole("button", { name: "More actions" }).click();
      await win.getByRole("menuitem", { name: "Copy link" }).click();
      await expect.poll(() => copied(win)).toBe(link);
    });

    const fragment = link.slice(link.indexOf("#") + 1);
    const appLink = `synapse://import#${fragment}`;
    await step("open-url shows the sheet within 1 s; Cancel adds nothing", async () => {
      const before = (await agents(api)).length;
      const t0 = Date.now();
      await openUrl(app, appLink);
      const sheet = win.getByRole("dialog", { name: "Scout" });
      await expect(sheet.getByRole("button", { name: /Add/ })).toBeVisible();
      timings.sheetAfterOpenUrlMs = Date.now() - t0;
      expect(timings.sheetAfterOpenUrlMs).toBeLessThan(1000);
      await expect(sheet.getByText("You already have this Bot.")).toHaveCount(0); // the sharer's own Bot isn't an import
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toBeHidden();
      expect((await agents(api)).length).toBe(before);
    });

    await step("Add: the Bot is in the sidebar, in Ask, not kickstarted, skills kept to itself", async () => {
      await openUrl(app, appLink);
      const sheet = win.getByRole("dialog", { name: "Scout" });
      await expect(sheet.getByRole("button", { name: "Add Bot" })).toBeVisible();
      await expect(sheet.getByText("Runs code")).toBeVisible();
      const t0 = Date.now();
      await sheet.getByRole("button", { name: "Add Bot" }).click();
      await expect(win.getByRole("link", { name: /Scout 2/ }).first()).toBeVisible();
      timings.addToSidebarMs = Date.now() - t0;
      const added = (await agents(api)).find((a) => a.profile.name === "Scout 2")!;
      expect(added.settings.permMode).toBe("ask");
      await openUrl(app, appLink);
      await expect(win.getByRole("dialog", { name: "Scout" }).getByText("You already have this Bot.")).toBeVisible();
      await win.getByRole("dialog", { name: "Scout" }).getByRole("button", { name: "Add a copy" }).click();
      await expect(win.getByRole("link", { name: /Scout 3/ }).first()).toBeVisible();
    });

    await step("damaged, newer and unknown links: one calm line each", async () => {
      for (const [url, line] of [[`synapse://import#b1.${fragment.slice(3, 30)}`, "This link is damaged."], [`synapse://import#b9.${fragment.slice(3)}`, "This Bot needs a newer Synapse."], ["synapse://someday/new", "This link needs a newer Synapse."]] as const) {
        await openUrl(app, url);
        const d = win.getByRole("dialog", { name: line });
        await expect(d.getByRole("alert")).toHaveText(line);
        await d.getByRole("button", { name: "Close" }).click();
        await expect(d).toBeHidden();
      }
    });

    await step("twenty fast clicks give one sheet", async () => {
      const before = (await agents(api)).length;
      await openUrl(app, appLink);
      for (let i = 0; i < 19; i++) await openUrl(app, appLink, { flood: true });
      await expect(win.getByRole("dialog", { name: "Scout" })).toBeVisible();
      await win.waitForTimeout(600);
      // One sheet (the line sheet before it may still be fading out, so this waits for the stack to settle).
      await expect.poll(() => win.getByRole("dialog").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Scout"]);
      await win.getByRole("dialog", { name: "Scout" }).getByRole("button", { name: "Cancel" }).click();
      expect((await agents(api)).length).toBe(before);
    });

    await step("a share link in a Bot's reply still needs the confirm", async () => {
      const before = (await agents(api)).length;
      const open = (await agents(api)).find((a) => a.profile.name === "Scout 3")!; // the chat on screen
      await api("sendPrompt", { id: open.id, text: `say link: ${appLink}`, clientNonce: crypto.randomUUID() });
      const a = win.getByRole("link", { name: "Add this Bot", exact: true });
      await expect(a).toBeVisible({ timeout: 15_000 });
      await a.click();
      const sheet = win.getByRole("dialog", { name: "Scout" });
      await expect(sheet).toBeVisible();
      expect((await agents(api)).length).toBe(before);
      await sheet.getByRole("button", { name: "Cancel" }).click();
    });

    await step("every catalogue link opens and imports", async () => {
      const { entries } = loadCatalogue() as { entries: { payload: { name: string }; links: { app: string } }[] };
      for (const [i, e] of entries.entries()) {
        await openUrl(app, e.links.app);
        const sheet = win.getByRole("dialog", { name: e.payload.name });
        if (i === 0) { await expect(sheet.getByText("Apps it can use")).toBeVisible(); await shot(win, "app-import-sheet.png"); }
        await sheet.getByRole("button", { name: "Add Bot" }).click();
        await expect(sheet).toBeHidden();
      }
      const names = (await agents(api)).map((a) => a.profile.name);
      for (const e of entries) expect(names).toContain(e.payload.name);
      for (const a of (await agents(api)).filter((x) => entries.some((e) => e.payload.name === x.profile.name))) expect(a.settings.permMode).toBe("ask");
    });

    await step("Export for website writes an entry the site build accepts", async () => {
      // The chat on screen is the last catalogue Bot added.
      await win.getByRole("button", { name: "More actions" }).click();
      await win.getByRole("menuitem", { name: "Export for website" }).click();
      const sheet = win.getByRole("dialog");
      await sheet.getByRole("textbox", { name: "Blurb" }).fill("Researches anything and keeps notes.");
      await sheet.getByRole("button", { name: "Save entry" }).click();
      await expect(sheet.getByRole("status")).toBeVisible();
      const file = fs.readdirSync(saveDir).find((f) => f.endsWith(".json"))!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-e2e-entry-"));
      fs.copyFileSync(path.join(saveDir, file), path.join(dir, file));
      const { entries, warnings } = loadCatalogue(dir);
      expect(warnings).toEqual([]);
      expect(entries).toHaveLength(1);
      fs.rmSync(dir, { recursive: true, force: true });
      await sheet.getByRole("button", { name: "Close" }).click();
    });

    await step("a Bot too big for a link saves a .botpack instead", async () => {
      for (const n of ["a", "b", "c"]) await api("createWorkflow", { name: `bulk-${n}`, description: "Big", body: crypto.randomBytes(12_000).toString("hex") });
      await win.getByRole("button", { name: "More actions" }).click();
      await win.getByRole("menuitem", { name: "Share Bot…" }).click();
      const sheet = win.getByRole("dialog");
      for (const n of ["a", "b", "c"]) await sheet.getByRole("checkbox", { name: new RegExp(`^bulk-${n}`) }).check();
      await expect(sheet.getByText("Too big for a link.")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Copy link" })).toHaveCount(0);
      await sheet.getByRole("button", { name: "Save .botpack" }).click();
      await expect.poll(() => fs.readdirSync(saveDir).some((f) => f.endsWith(".botpack")), { timeout: 10_000 }).toBe(true);
      await sheet.getByRole("button", { name: "Close" }).click();
    });
  } finally {
    await app.close();
    fs.rmSync(saveDir, { recursive: true, force: true });
  }
});

test("a link during onboarding waits for it; Paste a Bot link adds and finishes onboarding", async () => {
  test.setTimeout(180_000);
  const frag = (loadCatalogue() as { entries: { fragment: string; payload: { name: string } }[] }).entries[0]!;
  {
    const { app, win, saveDir } = await launch("defer", { onboard: false });
    try {
      await win.getByRole("button", { name: "Add API key" }).waitFor({ timeout: 30_000 });
      await openUrl(app, `synapse://import#${frag.fragment}`);
      await win.waitForTimeout(800);
      expect(await win.getByRole("dialog", { name: frag.payload.name }).count()).toBe(0);
      await completeOnboarding(win, "Helper");
      await expect(win.getByRole("dialog", { name: frag.payload.name })).toBeVisible();
    } finally { await app.close(); fs.rmSync(saveDir, { recursive: true, force: true }); }
  }
  {
    const { app, win, saveDir } = await launch("paste", { onboard: false });
    try {
      // The main process reads the clipboard; stub it there (the real one is never touched).
      await app.evaluate(({ clipboard }, t) => { (clipboard as unknown as { readText: () => string }).readText = () => t; }, `${SITE}/bot#${frag.fragment}`);
      await win.getByRole("button", { name: "Add API key" }).click({ timeout: 30_000 });
      await win.getByLabel("Anthropic API key").fill("sk-ant-api03-" + "e2eFakeKeyNeverValid".repeat(3));
      await win.getByRole("button", { name: "Save key" }).click();
      for (let i = 0; i < 4; i++) await win.getByRole("button", { name: "Next" }).click();
      await win.getByRole("button", { name: "Paste a Bot link" }).click();
      const sheet = win.getByRole("dialog", { name: frag.payload.name });
      await sheet.getByRole("button", { name: "Add Bot" }).click();
      await expect(win.getByRole("link", { name: new RegExp(frag.payload.name) }).first()).toBeVisible();
    } finally { await app.close(); fs.rmSync(saveDir, { recursive: true, force: true }); }
  }
});
