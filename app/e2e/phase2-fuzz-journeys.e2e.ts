import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { BotSummary, SkillView, TranscriptEntry } from "@synapse/shared";
import { completeOnboarding } from "./onboarding";
import { openPrivateSkills, surfaceAlerts } from "./fuzz-helpers";
import { test, watchPageErrors, type PageErrors } from "./page-errors";

// Task 39 fuzz pass, Layer 2: the Phase 2 surfaces from the brief, each driven end to end in FUZZ
// mode (fake brain, throwaway local host) with engine-state assertions and abuse cases.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "fixtures");

type Api = <T>(cmd: string, args?: unknown) => Promise<T>;
interface Ctx { app: ElectronApplication; win: Page; api: Api; errors: PageErrors }

async function launch(profile: string): Promise<Ctx> {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `${profile}-${Date.now()}` } });
  const win = await app.firstWindow();
  await completeOnboarding(win); // Phase 5: a fresh FUZZ profile opens on onboarding
  const errors = watchPageErrors(app, win, `p2:${profile}`, { console: true });
  await win.locator(".connection").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  const read = () => app.evaluate(() => (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway);
  let gw = await read();
  for (let t = Date.now() + 5000; !gw && Date.now() < t; ) { await new Promise((r) => setTimeout(r, 100)); gw = await read(); }
  if (!gw) throw new Error("no __fuzzGateway");
  const g = gw;
  const api: Api = async <T>(cmd: string, args: unknown = {}) => {
    const r = await fetch(`${g.baseUrl}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${g.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }) as never; });
  return { app, win, api, errors };
}

async function createBot(win: Page, name: string): Promise<void> {
  await win.getByRole("button", { name: "New chat", exact: true }).click();
  await win.getByLabel("To:").fill(name);
  await win.getByRole("option", { name: `Create "${name}" Bot` }).click();
  await expect(win.getByRole("log", { name: "Conversation transcript" }).getByText("Hi! Tell me what you'd like help with")).toBeVisible({ timeout: 10_000 });
}
const composer = (win: Page, name: string) => win.getByRole("textbox", { name: `Message ${name}` });
async function say(win: Page, name: string, text: string, expectText?: string | RegExp) {
  const c = composer(win, name);
  await c.fill(text);
  await c.press("Enter");
  if (expectText) await expect(win.getByRole("log", { name: "Conversation transcript" }).getByText(expectText).last()).toBeVisible({ timeout: 10_000 });
}
const botId = async (api: Api, name: string) => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === name)!.id;
const tail = async (api: Api, id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
async function attach(win: Page, file: string) {
  await win.getByRole("button", { name: "Attach file" }).click();
  const chooser = win.waitForEvent("filechooser");
  await win.getByRole("menuitem", { name: "Attach files…" }).click();
  await (await chooser).setFiles(file);
}
/** The HTML preview is a sandbox="" iframe on purpose: Chromium refuses to run the file's own <script>
 *  and logs it. Only the preview journey opens an HTML file, so only the preview journey declares it —
 *  this used to be excused for all six journeys in this file, which is a blanket allowlist by another
 *  name: an unrelated journey could have started logging the same text and nobody would have known. */
const SANDBOXED_PREVIEW_SCRIPT = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;
async function done(c: Ctx) {
  // No error assertion here on purpose: the page-error guard returns its verdict in teardown, so it
  // covers a journey that never reaches this line — which is the half the old assertion missed.
  await c.app.close();
}

test("palette: every row, ⌘1…⌘9, typing, Esc, abuse input", async () => {
  const c = await launch("fz2-palette");
  const { win } = c;
  await createBot(win, "Piper");
  await createBot(win, "Quill");
  const pal = win.getByRole("dialog", { name: "Search" });
  const box = pal.getByRole("textbox", { name: "Search" });
  // Every row by keyboard index; each must close the palette or change something visible.
  await win.keyboard.press("Meta+k");
  const rows = await pal.getByRole("option").all();
  const labels = await Promise.all(rows.map((r) => r.textContent()));
  await win.keyboard.press("Escape");
  await expect(pal).toBeHidden();
  for (let i = 1; i <= Math.min(9, labels.length); i++) {
    await win.keyboard.press("Meta+k");
    await expect(pal).toBeVisible();
    const disabled = await pal.getByRole("option").nth(i - 1).getAttribute("aria-disabled");
    await win.keyboard.press(`Meta+${i}`);
    if (disabled === "true" || /Theme/.test(labels[i - 1] ?? "")) { await win.keyboard.press("Escape"); }
    await win.keyboard.press("Escape"); // closes Settings / Marketplace overlays the row opened
    await win.keyboard.press("Escape");
  }
  // Typing, then a word from an old message.
  await win.getByRole("link", { name: /Quill/ }).first().click();
  await say(win, "Quill", "the pelican report is due Friday", "On it.");
  await win.keyboard.press("Meta+k");
  await box.fill("pelican");
  await pal.getByRole("option", { name: /pelican/i }).first().click();
  await expect(pal).toBeHidden();
  await expect(win.locator(".msg.highlight")).toContainText("pelican");
  // Abuse: huge, unicode, HTML and empty queries; double ⌘K; arrow keys past the ends.
  for (const q of ["x".repeat(5000), "Ünïcödé 日本語 👋🏽 ‮rtl", "<img src=x onerror=alert(1)>", "   ", ""]) {
    await win.keyboard.press("Meta+k");
    await box.fill(q);
    for (let k = 0; k < 12; k++) await win.keyboard.press("ArrowDown");
    for (let k = 0; k < 12; k++) await win.keyboard.press("ArrowUp");
    await win.keyboard.press("Escape");
    await expect(pal).toBeHidden();
  }
  await win.keyboard.press("Meta+k");
  await win.keyboard.press("Meta+k");
  await win.keyboard.press("Escape");
  await expect(pal).toBeHidden();
  await done(c);
});

test("Private skills: new, edit, delete, import each way, per-Bot switches (host state)", async () => {
  const c = await launch("fz2-skills");
  const { win, api } = c;
  await createBot(win, "Piper");
  await openPrivateSkills(win); // Phase 5: the Marketplace footer opens the full Marketplace
  const dlg = win.getByRole("dialog", { name: "Manage plugins and skills" });
  await expect(dlg.getByText("No private skills yet", { exact: false })).toBeVisible();
  // New
  const editor = async (name: string, description: string, bodyText: string) => {
    await dlg.getByLabel("Name").fill(name);
    await dlg.getByLabel("Description").fill(description);
    await dlg.getByRole("textbox", { name: "Skill body (Markdown)" }).fill(bodyText);
  };
  await dlg.getByRole("button", { name: "New skill" }).click();
  await editor("Morning brief", "Use when the user asks for the morning brief.", "1. Check the calendar\n2. Summarize");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg.getByText("Morning brief", { exact: true })).toBeVisible();
  expect((await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.map((w) => w.name)).toContain("Morning brief");
  // Abuse: double-click Save on an empty editor must not crash or create an empty skill.
  await dlg.getByRole("button", { name: "New skill" }).click();
  await editor("", "", "");
  await dlg.getByRole("button", { name: "Save" }).dblclick();
  await dlg.getByRole("button", { name: "Cancel" }).click().catch(() => {});
  expect((await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.filter((w) => !w.managed)).toHaveLength(1); // Phase 4 ships a managed teach skill
  // Edit
  await dlg.getByRole("button", { name: "Edit Morning brief" }).click();
  await dlg.getByLabel("Description").fill("Use for the daily brief.");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.find((w) => w.name === "Morning brief")?.description).toBe("Use for the daily brief.");
  // Import: pasted Markdown
  await dlg.getByRole("button", { name: "Import" }).click();
  await win.getByRole("menuitem", { name: "Paste Markdown…" }).click();
  await dlg.getByRole("textbox", { name: "Markdown" }).fill("# Expense report\nUse when the user asks for an expense report.\n\n1. Gather receipts");
  await dlg.getByRole("button", { name: "Import skill" }).click();
  await expect.poll(async () => (await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.filter((w) => !w.managed).length).toBe(2);
  // Import: a folder (SKILL.md + a helper file)
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fz2-")), "Packing list");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "SKILL.md"), "---\nname: Packing list\ndescription: Use when packing for a trip.\n---\n1. Check the weather\n");
  fs.writeFileSync(path.join(folder, "template.md"), "- passport\n");
  await dlg.locator("input[type=file]").setInputFiles(folder);
  await expect.poll(async () => (await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.filter((w) => !w.managed).length).toBe(3);
  // Import: URL (unreachable → an inline error, no crash)
  await dlg.getByRole("button", { name: "Import" }).click();
  await win.getByRole("menuitem", { name: "From URL…" }).click();
  await dlg.getByRole("textbox", { name: "URL" }).fill("http://127.0.0.1:9/nothing.md");
  await dlg.getByRole("button", { name: "Import skill" }).click();
  // The skills manager's OWN error, not the app-wide announcement bug 46 now puts on the surface
  // that is on top (`call()` reports this same unreachable-URL rejection into it by default).
  await expect(surfaceAlerts(dlg)).toBeVisible({ timeout: 15_000 });
  await dlg.getByRole("button", { name: "Cancel" }).click().catch(() => {});
  // Per-Bot switch round-trips through the host.
  const sw = dlg.getByRole("switch", { name: "Morning brief for Piper" });
  await sw.click();
  const id = await botId(api, "Piper");
  const skillId = (await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.find((w) => w.name === "Morning brief")!.id;
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await win.keyboard.press("Escape");
  await composer(win, "Piper").fill("/");
  await expect(win.getByRole("listbox", { name: "Skills" }).getByText("Morning brief")).toHaveCount(0);
  await composer(win, "Piper").fill("");
  // Delete (confirm dialog accepted)
  await openPrivateSkills(win); // Phase 5: the Marketplace footer opens the full Marketplace
  win.once("dialog", (d) => void d.accept());
  await dlg.getByRole("button", { name: "Delete Morning brief" }).click();
  await expect(dlg.getByText("Morning brief", { exact: true })).toBeHidden();
  expect((await api<{ workflows: SkillView[] }>("getWorkflows")).workflows.map((w) => w.id)).not.toContain(skillId);
  void id;
  await win.keyboard.press("Escape");
  await done(c);
});

test("composer: + menu, attach, paste, drop, / picker, reply chip; abuse", async () => {
  const c = await launch("fz2-composer");
  const { win, api } = c;
  await createBot(win, "Piper");
  await say(win, "Piper", "save skill: Weekly report", "Saved skill");
  // + menu: every item
  await win.getByRole("button", { name: "Attach file" }).click();
  const items = await win.getByRole("menuitem").allTextContents();
  await win.keyboard.press("Escape");
  for (const label of items) {
    await win.getByRole("button", { name: "Attach file" }).click();
    const it = win.getByRole("menuitem", { name: label });
    if (await it.isDisabled()) { await win.keyboard.press("Escape"); continue; }
    if (/Attach files/.test(label)) {
      const chooser = win.waitForEvent("filechooser");
      await it.click();
      await (await chooser).setFiles(path.join(FIX, "notes.md"));
      await expect(win.getByText("notes.md").first()).toBeVisible();
    } else {
      await it.click();
      await win.keyboard.press("Escape");
    }
  }
  // paste a file, drop a file
  for (const ev of ["paste", "drop"] as const) {
    await composer(win, "Piper").focus(); // paste attaches only while the composer has focus
    await win.evaluate((kind) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], `${kind}.txt`, { type: "text/plain" }));
      // Bug 39 (2): the drop is dispatched ON THE CHAT SURFACE, not on `window`. Commit 4b4427d
      // scoped the drop handler to `e.target.closest("main.main")` on purpose — a drop on the
      // sidebar, a modal or an overlay scrim must not attach the file to whichever chat happens to
      // be mounted behind it — and a `window.dispatchEvent` has `window` as its target, which no
      // real drop ever does. Dispatching where a user drops keeps the listener's `window` binding
      // under test (the event still has to bubble there) AND adds the scoping claim the old
      // unscoped dispatch could not make. Paste stays on `window`: its own gate is `activeElement`.
      const target = kind === "paste" ? window : document.querySelector("main.main")!;
      const e = kind === "paste" ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }) : new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
    }, ev);
    await expect(win.getByText(`${ev}.txt`).first()).toBeVisible();
  }
  // …and a drop OUTSIDE the chat surface attaches nothing — the other half of 4b4427d's scoping, and the
  // half a `window` dispatch could never have told apart from the first. A bare `toHaveCount(0)` would
  // pass instantly and prove nothing, so a second drop INSIDE the chat surface is dispatched in the same
  // tick as the barrier: once ITS chip is up, the sidebar drop has had strictly longer than the drop that
  // did work, and an absent chip is a real absence rather than a race with the render.
  await win.evaluate(() => {
    const drop = (name: string) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], name, { type: "text/plain" }));
      return new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    };
    document.querySelector("nav.sidebar")!.dispatchEvent(drop("sidebar-drop.txt"));
    document.querySelector("main.main")!.dispatchEvent(drop("after-sidebar.txt"));
  });
  await expect(win.getByText("after-sidebar.txt").first()).toBeVisible();
  await expect(win.getByText("sidebar-drop.txt")).toHaveCount(0);
  await say(win, "Piper", "ok, the files", "On it.");
  const id = await botId(api, "Piper");
  // …and it never reached the engine either, not merely the chips row.
  expect((await tail(api, id)).filter((e) => e.kind === "user-attachment").map((e) => (e as { name: string }).name).sort()).toEqual(["after-sidebar.txt", "drop.txt", "notes.md", "paste.txt"]);
  // "/" picker: keyboard nav, Enter picks a chip, the chip's ✕ removes it, Escape closes
  const box = composer(win, "Piper");
  await box.fill("/weekly"); // Phase 4 installs a managed teach skill; filter to the one this journey picks
  const lb = win.getByRole("listbox", { name: "Skills" });
  await expect(lb).toBeVisible();
  await win.keyboard.press("ArrowDown");
  await win.keyboard.press("ArrowUp");
  await win.keyboard.press("Enter");
  // Bug 39 (2), surfaced once the drop above stopped killing this journey at step 3: the chip shows
  // the skill's NAME, not its slug — commit 4b4427d, "Skill chips show the picker's name, not the
  // slug" (the id is "weekly-report"; the skill saved on line 196 is called "Weekly report"). The
  // chip's own text is asserted too, so a regression back to the slug fails on the claim itself and
  // not only on a label this line happens to spell.
  await expect(win.getByRole("button", { name: "Remove skill Weekly report" })).toBeVisible();
  await expect(win.locator(".chips-row .chip", { hasText: "/Weekly report" })).toBeVisible();
  await win.getByRole("button", { name: "Remove skill Weekly report" }).click();
  await box.fill("/nothing-matches-this");
  await win.keyboard.press("Escape");
  await box.fill("");
  // reply chip + cancel, then reply for real
  const bubble = win.locator(".msg.bot:has(.msg-actions)").last();
  await bubble.hover();
  await bubble.getByRole("button", { name: "Reply" }).click();
  await win.getByRole("button", { name: "Cancel reply" }).click();
  await expect(win.getByText("Replying to")).toBeHidden();
  await bubble.hover();
  await bubble.getByRole("button", { name: "Reply" }).click();
  await say(win, "Piper", "replying now", "On it.");
  const replyEntry = (await tail(api, id)).filter((e) => e.kind === "message").at(-1) as { replyToId?: string };
  expect(replyEntry.replyToId).toBeTruthy();
  // abuse: triple Enter on one message sends it once; giant text
  await box.fill("only once please");
  await box.press("Enter"); await box.press("Enter"); await box.press("Enter");
  await expect.poll(async () => (await tail(api, id)).filter((e) => e.kind === "message" && e.content === "only once please").length).toBe(1);
  await say(win, "Piper", "y".repeat(5000));
  await done(c);
});

test("message hover actions, reactions, widgets and every card kind", async () => {
  const c = await launch("fz2-cards");
  const { win, api } = c;
  await createBot(win, "Piper");
  await say(win, "Piper", "run: ls /workspace", /Done: ls/);
  const id = await botId(api, "Piper");
  const bubble = win.locator(".msg.bot:has(.msg-actions)").last();
  // every quick emoji, then toggle one off. Each reaction lands asynchronously (host round trip) and the first one
  // adds a reactions row that moves the bubble's top 26px; wait for it to render before the next hover, or the
  // next hover → React → React <emoji> chain races that layout shift (the full-suite "React click timeout" flake).
  for (const [i, e] of ["👍", "❤️", "😂", "🎉", "👀", "✅"].entries()) {
    await bubble.hover();
    await bubble.getByRole("button", { name: "React", exact: true }).click();
    await bubble.getByRole("button", { name: `React ${e}` }).click();
    await expect(bubble.locator(".reaction")).toHaveCount(i + 1);
  }
  await expect(bubble.locator(".reaction")).toHaveCount(6);
  await bubble.getByRole("button", { name: /👍 1/ }).click();
  await expect(bubble.locator(".reaction")).toHaveCount(5);
  // more menu: every item
  await bubble.hover();
  await bubble.getByRole("button", { name: "More message actions" }).click();
  const more = await win.getByRole("menuitem").allTextContents();
  await win.keyboard.press("Escape");
  for (const m of more) {
    await bubble.hover();
    await bubble.getByRole("button", { name: "More message actions" }).click();
    await win.getByRole("menuitem", { name: m, exact: true }).click();
  }
  // widget: triple-click an option answers once
  await say(win, "Piper", "ask: Which flight?|7 AM|6 PM");
  const opt = win.getByRole("button", { name: "6 PM" });
  await opt.click({ clickCount: 3 });
  await expect(win.getByRole("log", { name: "Conversation transcript" }).getByText("Got it: 6 PM.")).toBeVisible();
  // cards
  const cardCount = async () => (await tail(api, id)).filter((e) => e.kind === "send-message" && e.message.type === "card").length;
  const card = async (k: string, n: number) => { await say(win, "Piper", `card: ${k}`); await expect.poll(cardCount).toBe(n); };
  await card("table", 1);
  await expect(win.locator(".table-card")).toBeVisible();
  await card("link", 2);
  await expect(win.locator(".link-card")).toBeVisible();
  await card("form", 3);
  const form = win.locator("form.form-card");
  await form.locator("input").first().fill("Denver");
  await form.locator("textarea").fill("aisle please");
  await form.locator("select").selectOption("Window");
  await form.getByRole("button", { name: "Send" }).dblclick(); // abuse: double submit answers once
  await expect.poll(async () => (await tail(api, id)).filter((e) => e.kind === "send-message" && e.message.type === "card" && e.message.card.kind === "form").map((e) => (e as { status?: string }).status)[0]).toBe("answered");
  await card("email", 4);
  await win.getByRole("button", { name: "Discard" }).click();
  await done(c);
});

test("file previews for each kind", async () => {
  const c = await launch("fz2-previews");
  c.errors.expect(SANDBOXED_PREVIEW_SCRIPT, "the HTML preview is a sandbox=\"\" iframe: the file's own <script> MUST be refused, and this journey is the only one that opens one");
  const { win } = c;
  await createBot(win, "Piper");
  // An unsupported type is refused at upload with an inline error, not sent.
  await attach(win, path.join(FIX, "blob.bin"));
  await expect(win.getByText("That file type isn't supported.").first()).toBeVisible();
  await win.getByRole("button", { name: /Remove.*blob\.bin/ }).click().catch(() => {});
  const files = ["notes.md", "log.txt", "table.csv", "page.html", "dot.png", "report.pdf", "beep.wav", "sheet.xlsx"];
  for (const f of files) {
    await attach(win, path.join(FIX, f));
    await expect(win.getByText(f).first()).toBeVisible();
    // `.host-out/uploads/`, not `uploads/` — commit b4ad7fd moved attachment staging there (bug 39 (4)).
    // This journey was GREEN against the stale path for the wrong reason: the Bot's SendMessage found
    // no file and sent nothing, so `Open <f>`.last() resolved to the USER's own attachment card and the
    // Bot's FileCard — the thing "file previews" is named after — was never rendered once. The locator
    // is scoped to the Bot's card (`UserAttachment` renders its button as `.file-card.user`; `FileCard`
    // does not carry `.user`), so the journey can never again pass by previewing the file the user sent.
    await say(win, "Piper", `send back: .host-out/uploads/${f}`);
    const open = win.locator(".file-card:not(.user)").getByRole("button", { name: `Open ${f}` }).last();
    await expect(open).toBeVisible();
    await expect(win.locator(".file-card:not(.user)").getByRole("button", { name: `Save ${f}` }).last()).toBeVisible();
    if (await open.isDisabled()) continue; // non-previewable kinds are disabled, not dead
    await open.click();
    const dlg = win.getByRole("dialog", { name: f });
    await expect(dlg).toBeVisible();
    await win.waitForTimeout(600);
    // Scoped to the PREVIEW's own alerts: an unrelated app-wide announcement riding on this surface
    // (bug 46) must not read as "this preview failed", and a real preview error still must.
    await expect(surfaceAlerts(dlg)).toHaveCount(0);
    if (f === "dot.png") expect(await dlg.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
    if (f === "sheet.xlsx") await expect(dlg.getByText("Tomato")).toBeVisible();
    if (f === "table.csv") await expect(dlg.getByText("tomato")).toBeVisible();
    await dlg.getByRole("button", { name: "Save" }).click(); // save dialog cancelled (stubbed)
    await win.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
  }
  await expect(win.locator(".file-card:not(.user)").getByRole("button", { name: "Open sheet.xlsx" }).last()).toBeEnabled();
  await done(c);
});

test("sidebar context menu (every item), Hidden Bots, Advanced controls on and off, notification click-through", async () => {
  const c = await launch("fz2-menu");
  const { app, win, api } = c;
  await createBot(win, "Piper");
  await createBot(win, "Quill");
  const row = () => win.getByRole("link", { name: /Piper/ }).first();
  await row().click({ button: "right" });
  const labels = await win.getByRole("menuitem").allTextContents();
  await win.keyboard.press("Escape");
  for (const l of labels.filter((x) => !/Delete|Hide/.test(x))) {
    await row().click({ button: "right" });
    const it = win.getByRole("menuitem", { name: l });
    if (await it.isDisabled()) { await win.keyboard.press("Escape"); continue; }
    await it.click();
    await win.keyboard.press("Escape");
  }
  const names = (await api<{ agents: BotSummary[] }>("listAgents")).agents.map((a) => a.profile.name);
  expect(names.filter((n) => n.startsWith("Piper")).length).toBe(2); // Duplicate made a copy
  // Hide → Hidden Bots → Unhide
  await row().click({ button: "right" });
  await win.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await win.getByRole("button", { name: "Hidden Bots" }).click();
  await win.getByRole("button", { name: /^Unhide Piper/ }).first().click();
  await win.keyboard.press("Escape");
  await expect(row()).toBeVisible();
  // Delete via the menu (confirm accepted)
  const pipers = async () => (await api<{ agents: BotSummary[] }>("listAgents")).agents.filter((a) => a.profile.name.startsWith("Piper")).length;
  await expect(win.getByRole("link", { name: /Piper/ })).toHaveCount(2);
  win.once("dialog", (d) => void d.accept());
  await win.getByRole("link", { name: /Piper/ }).last().click({ button: "right" });
  await win.getByRole("menuitem", { name: "Delete Bot" }).click();
  await expect.poll(pipers).toBe(1);
  await expect(win.getByRole("link", { name: /Piper/ })).toHaveCount(1);
  // Advanced controls: off → no section; on → meter + buttons; per-turn recall switch round-trips.
  await win.keyboard.press("Meta+Comma");
  const adv = win.getByRole("switch", { name: "Show advanced controls" });
  await adv.click();
  await expect.poll(async () => (await api<{ advancedEnabled: boolean }>("getHostSettings")).advancedEnabled).toBe(true);
  const recall = win.getByRole("switch", { name: "Per-turn memory recall" });
  await recall.click();
  await recall.click();
  await win.keyboard.press("Escape");
  await row().click();
  await win.getByRole("button", { name: "Bot settings" }).click().catch(() => {});
  const section = win.getByRole("region", { name: "Advanced" }).or(win.locator("section[aria-label=Advanced]"));
  await expect(section.getByRole("button", { name: "Compact now" })).toBeVisible();
  await section.getByRole("button", { name: "Compact now" }).click();
  await section.getByRole("button", { name: "New session" }).click();
  await win.keyboard.press("Meta+Comma");
  await adv.click();
  await win.keyboard.press("Escape");
  await expect(win.getByRole("button", { name: "Compact now" })).toHaveCount(0);
  // Notification click-through: main forwards "open-bot" exactly as notify.ts does on a click.
  const quill = (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === "Quill")!.id;
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows()[0]!.webContents.send("open-bot", id); }, quill);
  await expect(composer(win, "Quill")).toBeVisible();
  // Lifecycle abuse: resize small, then back.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 680));
  await win.keyboard.press("Meta+k");
  await win.keyboard.press("Escape");
  await done(c);
});

// ---------------------------------------------------------------------------------------------
// Bug 40 — the hover toolbar is a hit target, and it must only ever be a hit target for its own
// message's toolbar buttons. This is behavioural and at real geometry on purpose: every CSS rule
// involved is individually correct, and the defect lives in the interaction between three of them
// (`.msg-actions` top offset, `.transcript`'s gap, and the `pointer-events` flip on hover). A CSS
// assertion cannot see a stolen click; only a hit test in a real engine can.
//
// Two things are asserted, because the audit found two different victims:
//   (1) the NEIGHBOUR — with a message hovered, no point inside the message ABOVE it may resolve to
//       the hovered message's toolbar. `top: -14px` against an 8px gap put a 94 x 6px band of every
//       message's toolbar on top of the previous message, and `.msg:hover` armed it.
//   (2) the message's OWN controls — the toolbar floated 20px down into its own message, so the
//       CENTRE of a tall first child landed underneath it. That is what times out the "file previews"
//       journey: `Open notes.md`'s centre (y 711.86) sat 0.75px inside its own bar's box
//       (y 678.61-712.61, x 1042-1136), and Playwright reported `.msg-actions` intercepting.
// ---------------------------------------------------------------------------------------------
test("the hover toolbar never covers a neighbouring message or its own message's controls", async () => {
  const c = await launch("fz2-toolbar-hit");
  const { win } = c;
  await createBot(win, "Piper");
  await say(win, "Piper", "first one", /first one/);
  // A file card: a tall control whose centre is low enough to fall under its own message's toolbar.
  await attach(win, path.join(FIX, "notes.md"));
  await say(win, "Piper", "send back: .host-out/uploads/notes.md"); // b4ad7fd's staging dir; see "file previews" above
  // The USER's own attachment card, named rather than picked with `.last()`. It is the card bug 40
  // measured — `Open notes.md`'s centre 0.75px inside its own message's `.msg-actions` box — and only
  // a user message HAS a hover toolbar, so it is the only file card check (2) below can be about.
  // (`.last()` used to land here by accident: with the pre-b4ad7fd `uploads/` path the Bot's
  // SendMessage found no file and its FileCard was never rendered at all.)
  const open = win.locator(".msg.user").getByRole("button", { name: "Open notes.md" }).last();
  await expect(open).toBeVisible();
  // A reaction chip: the app's only control that sits ON a message's bottom edge, which is the pixel
  // row the next message's toolbar was covering.
  const reacted = win.locator(".msg.bot:has(.msg-actions)").first();
  await reacted.hover();
  await reacted.getByRole("button", { name: "React", exact: true }).click();
  await reacted.getByRole("button", { name: "React 👍" }).click();
  await expect(reacted.locator(".reaction")).toHaveCount(1);
  await say(win, "Piper", "one below the reacted one", /one below/);

  // (1) neighbours. Hover each message in turn with the real mouse, then hit-test the bottom edge of
  //     the message above it. Playwright's hover is what arms the bar, exactly as a user's is.
  const pairs = await win.locator(".transcript > .msg").count();
  expect(pairs, "need adjacent messages to test between").toBeGreaterThan(2);
  const stolen: string[] = [];
  for (let i = 1; i < pairs; i++) {
    const lower = win.locator(".transcript > .msg").nth(i);
    const b = (await lower.boundingBox())!;
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    stolen.push(...await win.evaluate((n) => {
      const msgs = [...document.querySelectorAll(".transcript > .msg")];
      const above = msgs[n - 1]!.getBoundingClientRect();
      // A Bot's file-card message carries no hover toolbar, so it has nothing to steal a click with.
      const bar = msgs[n]!.querySelector(".msg-actions");
      if (!bar) return [];
      const hits: string[] = [];
      for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        for (const dy of [1, 3, 5]) {
          const el = document.elementFromPoint(above.left + above.width * fx, above.bottom - dy);
          if (el && bar.contains(el)) hits.push(`msg[${n}]'s toolbar covers msg[${n - 1}] at x+${Math.round(above.width * fx)}, ${dy}px above its bottom`);
        }
      }
      return hits;
    }, i));
  }
  expect(stolen, "a message's toolbar may not present a hit target over the message above it").toEqual([]);

  // (2) its own message. Hover the message the file card belongs to, then check the card's centre —
  //     the point Playwright (and a user) aims at — still resolves to the card.
  const ob = (await open.boundingBox())!;
  await win.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  const atCentre = await win.evaluate(() => {
    // The user's own card, to match `open` above: only a user message has a toolbar to be covered by.
    const btns = [...document.querySelectorAll('.msg.user button[aria-label="Open notes.md"]')];
    const btn = btns[btns.length - 1]!;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onCard: !!(el && btn.contains(el)), hit: el ? `${el.tagName}.${String(el.className)}` : null };
  });
  expect(atCentre.onCard, `the file card's own centre must belong to the card, not to ${atCentre.hit}`).toBe(true);
  await open.click({ timeout: 10_000 });
  await expect(win.getByRole("dialog", { name: "notes.md" })).toBeVisible();
  await win.keyboard.press("Escape");

  // (3) a control on a message's very bottom edge takes a real click while the message below it is
  //     hovered. Honest note: this one PASSED before the fix, and (1) is the assertion that caught
  //     the defect. The stolen band was only ever as wide as the toolbar (94px), and the toolbar was
  //     pinned to the same side as its own bubble — so in a one-to-one conversation, where user and
  //     Bot messages alternate sides, every stolen band landed on the empty half of the message
  //     above. Consecutive same-side messages (a group's member posts) had no such luck. This stays
  //     because it is the shape a user reports, and because the next person to move the toolbar will
  //     not know which pairs happen to alternate.
  const chip = reacted.locator(".reaction").first();
  const idx = await win.evaluate(() => [...document.querySelectorAll(".transcript > .msg")].indexOf(document.querySelector(".msg.bot:has(.msg-actions)")!));
  expect(idx, "the reacted message must have a message below it").toBeGreaterThanOrEqual(0);
  const below = win.locator(".transcript > .msg").nth(idx + 1);
  const bb = (await below.boundingBox())!;
  await win.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  const cb = (await chip.boundingBox())!;
  // Mid-width, one pixel up from the bottom: the chip is an 11px-radius pill, so its bottom CORNERS
  // are outside the button's hit area by the radius and land on `.reactions` instead — a point that
  // proves nothing about who owns the chip.
  const [cx, cy] = [cb.x + cb.width / 2, cb.y + cb.height - 1];
  await win.mouse.move(cx, cy);
  const under = await win.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { own: !!el?.classList.contains("reaction"), what: el ? `${el.tagName}.${String(el.className)}` : "nothing" };
  }, [cx, cy]);
  expect(under.own, `the chip's own bottom edge must belong to the chip, not to ${under.what}`).toBe(true);
  await win.mouse.down();
  await win.mouse.up();
  await expect(reacted.locator(".reaction"), "the click on the chip's bottom edge must reach the chip").toHaveCount(0);
  await done(c);
});

// Keep the fixtures honest: every file the preview test uses exists.
test.beforeAll(() => { for (const f of fs.readdirSync(FIX)) expect(fs.statSync(path.join(FIX, f)).size).toBeGreaterThan(0); });
