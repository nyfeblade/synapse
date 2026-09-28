import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { sidebarRow } from "./fuzz-helpers";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createBot(win: Page, name: string): Promise<void> {
  await win.getByRole("button", { name: "New chat" }).click();
  await win.getByLabel("To:").fill(name);
  await win.getByRole("option", { name: `Create "${name}" Bot` }).click();
  await expect(win.getByRole("link", { name: new RegExp(name) })).toBeVisible();
}

test("group chat with a kept pass row, a peer exchange with a wake-origin row, and a routine from chat", async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, "..")], env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-phase4-${Date.now()}` } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, "phase4 journey");
  await completeOnboarding(win); // Phase 5: a fresh FUZZ profile opens on onboarding
  await expect(win.getByRole("button", { name: "New chat" })).toBeEnabled({ timeout: 30_000 });
  // Scope message-content checks to the transcript: the sidebar row also mirrors the latest text (GRP-15).
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  for (const n of ["Planner", "Scout", "Ledger"]) await createBot(win, n);

  // GRP-01 / N3: Create group chat, pick three Bots, generated name
  await win.getByRole("button", { name: "New chat" }).click();
  await win.keyboard.press("Meta+2"); // "Create group chat ⌘2" switches the recipient list to multi-pick
  const picker = win.getByRole("listbox", { name: "Recipients" });
  for (const n of ["Planner", "Scout", "Ledger"]) await picker.getByRole("option", { name: new RegExp(`^${n}`) }).click();
  await win.getByRole("button", { name: "Create group" }).click();
  await expect(win.getByRole("link", { name: /Planner, Scout & Ledger/ })).toBeVisible();
  await expect(win.getByPlaceholder("Message Planner, Scout & Ledger")).toBeVisible();
  await expect(win.getByRole("complementary", { name: "Conversation details" })).toContainText("Members");

  // GRP-03/04/05/13: @everyone → one member posts, the others pass → one aggregated muted row
  const groupComposer = win.getByPlaceholder("Message Planner, Scout & Ledger");
  await groupComposer.fill("@everyone plan a cheap weekend upstate");
  await groupComposer.press("Enter");
  await expect(transcript.getByText("Here's a first take: plan a cheap weekend upstate")).toBeVisible();
  await expect(transcript.getByText(/Scout and Ledger passed/)).toBeVisible();
  await expect(transcript.getByText("· nothing new to add")).toBeVisible();
  await expect(win.getByRole("link", { name: /Planner, Scout & Ledger/ })).toContainText("Planner: Here's a first take"); // GRP-15

  // B2B-01/02 + CHAT-23: Planner asks Scout; Scout answers with a result; Planner wakes once and replies
  // The group row sorts first (most recent) and also starts with "Planner", so exclude it; the details panel
  // lists a "Planner" member link too, so scope to the sidebar. `sidebarRow()` does both.
  // The hazard this line used to carry is gone (bug 43): `^` is still load-bearing — it is the only thing
  // excluding "Planner, Scout & Ledger", whose status line can itself contain "Planner:" — but a row's
  // accessible name no longer begins with its marker's label, so the anchor does not stop resolving the
  // day Planner needs attention. The rule now lives in one helper instead of two spellings.
  await sidebarRow(win, "Planner").click();
  const composer = win.getByPlaceholder("Message Planner", { exact: true });
  await composer.fill("ask Scout: find three cabins near Hudson");
  await composer.press("Enter");
  await expect(transcript.getByText(/\d+ messages? with/).first()).toBeVisible();
  // Two real 5 s coalesce windows (LIMITS.coalesceWindowMs: request to Scout, then result to Planner) run before the
  // wake, so the default 5 s expect timeout can never see it. Coalescing stays real (anti-ack / token efficiency).
  await expect(transcript.getByText("Message from")).toBeVisible({ timeout: 20_000 });
  await expect(transcript.getByText("Scout says: done — find three cabins near Hudson")).toBeVisible({ timeout: 20_000 });

  // RTN-02/03/05 + C4: a routine created from chat, shown in plain English with the raw expression as a tooltip
  await composer.fill("routine: Morning sweep | every day at 8am | Sweep the inbox and summarize it");
  await composer.press("Enter");
  await expect(transcript.getByText(/Created Routine · Morning sweep/)).toBeVisible();
  const panel = win.getByRole("complementary", { name: "Conversation details" });
  await expect(panel.getByText("Morning sweep")).toBeVisible();
  const when = panel.getByText("Every day at 8:00 AM");
  await expect(when).toBeVisible();
  await expect(when).toHaveAttribute("title", /^CRON_TZ=\S+ 0 8 \* \* \*$/);

  // RTN-03/18: detail, Test run (real work), run history, Active toggle
  await panel.getByRole("button", { name: /Morning sweep/ }).click();
  await expect(panel.getByText("Test run does real work.")).toBeVisible();
  await panel.getByRole("button", { name: "Test run" }).click();
  await expect(transcript.getByText("Routine ran: Morning sweep")).toBeVisible();
  await expect(panel.locator("ul.runs li").first()).toBeVisible();
  await panel.getByRole("switch", { name: "Active" }).click();
  await panel.getByRole("button", { name: "Back to details" }).click();
  await expect(panel.getByText("Paused")).toBeVisible();

  // CHAT-16/17: a widget answered with one click (no user bubble)
  await composer.fill("choose: Hudson or Beacon");
  await composer.press("Enter");
  await win.getByRole("group", { name: "Which one?" }).getByRole("button", { name: "Beacon" }).click();
  await expect(transcript.getByText("You picked beacon.")).toBeVisible();
  await app.close();
});
