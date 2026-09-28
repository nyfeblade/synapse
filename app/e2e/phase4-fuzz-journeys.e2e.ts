import { expect, type Page } from "@playwright/test";
import { STR, type BotSummary, type RoutineView, type TranscriptEntry } from "@synapse/shared";
import { createBot, launch, noHorizontalOverflow, restartLocalHost, type Api } from "./fuzz-helpers";
import { test } from "./page-errors";

// Task 50 fuzz pass, Layer 2: Phase 4 journeys and abuse cases (traceability S15, M3, M7, A5, A7, A14, N3,
// G1–G10, C6) against the throwaway FUZZ profile. Every step asserts host state through the gateway.
// "slowly" in a routine prompt or a group post makes the FUZZ brain hold that run / member turn for 4 s.

const routinesOf = async (api: Api, botId: string) => (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id: botId })).routines;
const agents = async (api: Api) => (await api<{ agents: BotSummary[] }>("listAgents")).agents;
const botId = async (api: Api, name: string) => (await agents(api)).find((a) => a.profile.name === name && !a.group)!.id;
const tail = async (api: Api, id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id, limit: 200 })).entries;
const sendTexts = (entries: TranscriptEntry[]) =>
  entries.flatMap((e) => (e.kind === "send-message" && (e.message as { type?: string }).type !== "widget" ? [String((e.message as { content?: string }).content ?? "")] : []));

async function makeRoutine(win: Page, name: string, prompt: string): Promise<void> {
  const composer = win.getByPlaceholder("Message Planner", { exact: true });
  await composer.fill(`routine: ${name} | every day at 8am | ${prompt}`);
  await composer.press("Enter");
  await expect(win.getByRole("log", { name: "Conversation transcript" }).getByText(new RegExp(`Created Routine · ${name}`))).toBeVisible({ timeout: 10_000 });
}

test("S15/M7/A14 routines abuse: triple Test run, delete mid-run, 20 Active toggles, 300-char name, 1024×680, themes", async () => {
  const { app, win, api } = await launch("fuzz-p4-routines");
  await createBot(win, "Planner");
  const planner = await botId(api, "Planner");
  const panel = win.getByRole("complementary", { name: "Conversation details" });
  const transcript = win.getByRole("log", { name: "Conversation transcript" });

  // Triple-click Test run on a slow routine: one run while in flight (the extra clicks are dropped as duplicate_in_flight).
  await makeRoutine(win, "Sweep", "Sweep the inbox slowly");
  await panel.getByRole("button", { name: /^Sweep,/ }).click();
  await panel.getByRole("button", { name: STR.testRun }).click({ clickCount: 3, delay: 40 });
  await expect(async () => {
    const [r] = await routinesOf(api, planner);
    expect(r!.runs.map((x) => x.status)).toEqual(["running"]);
  }).toPass({ timeout: 3000 });
  await expect(transcript.getByText("Routine ran: Sweep")).toHaveCount(1, { timeout: 10_000 });
  await expect(async () => expect((await routinesOf(api, planner))[0]!.runs.map((x) => x.status)).toEqual(["ok"])).toPass({ timeout: 5000 });
  const alert = panel.getByRole("alert");
  if (await alert.count()) expect(await alert.textContent()).toBe(STR.runAlreadyRunning); // words, not the raw drop code

  // Delete the routine while its run is going: it stays deleted after the run finishes, and nothing crashes.
  await panel.getByRole("button", { name: STR.testRun }).click();
  await expect(async () => expect((await routinesOf(api, planner))[0]!.runs[0]!.status).toBe("running")).toPass({ timeout: 3000 });
  await panel.getByRole("button", { name: STR.deleteRoutine }).click();
  await expect(async () => expect(await routinesOf(api, planner)).toEqual([])).toPass({ timeout: 3000 });
  await expect(transcript.getByText("Routine ran: Sweep")).toHaveCount(2, { timeout: 10_000 });
  expect(await routinesOf(api, planner)).toEqual([]);
  await expect(panel.getByRole("button", { name: /^Sweep,/ })).toHaveCount(0);

  // Toggle Active 20 times quickly: the UI switch and the host agree once it settles.
  await makeRoutine(win, "Toggle", "Say hi");
  await panel.getByRole("button", { name: /^Toggle,/ }).click();
  const sw = panel.getByRole("switch", { name: STR.active });
  for (let i = 0; i < 20; i++) await sw.click({ delay: 0 });
  await expect(async () => {
    const [r] = await routinesOf(api, planner);
    expect(String(r!.enabled)).toBe(await sw.getAttribute("aria-checked"));
  }).toPass({ timeout: 5000 });
  await expect(async () => expect((await routinesOf(api, planner))[0]!.enabled).toBe(true)).toPass({ timeout: 5000 }); // 20 clicks = unchanged

  // Paste a 300-char name: the field cuts it to 80 and the host saves 80.
  const nameField = panel.getByRole("textbox", { name: "Routine name" });
  await nameField.fill("N".repeat(300));
  expect((await nameField.inputValue()).length).toBe(80);
  await nameField.blur();
  await expect(async () => expect((await routinesOf(api, planner))[0]!.name).toBe("N".repeat(80))).toPass({ timeout: 5000 });

  // Environment: the declared minimum window and both themes, with the routine detail open.
  await win.setViewportSize({ width: 1024, height: 680 });
  for (const scheme of ["dark", "light"] as const) {
    await win.emulateMedia({ colorScheme: scheme });
    await win.waitForTimeout(150);
    expect(await noHorizontalOverflow(win)).toBe(true);
  }
  await app.close();
});

test("N3/G1–G10 groups abuse: same members twice, 5,000-char emoji/RTL post, member change mid-turn, host killed mid-turn", async () => {
  const { app, win, api } = await launch("fuzz-p4-groups");
  for (const n of ["Planner", "Scout", "Ledger"]) await createBot(win, n);
  const [planner, scout, ledger] = await Promise.all(["Planner", "Scout", "Ledger"].map((n) => botId(api, n)));
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  const sidebar = win.getByRole("navigation", { name: "Bots" });

  // Create group with the same members twice: the group is reused.
  for (let i = 0; i < 2; i++) {
    await win.getByRole("button", { name: "New chat", exact: true }).click();
    await win.keyboard.press("Meta+2");
    const picker = win.getByRole("listbox", { name: "Recipients" });
    for (const n of ["Planner", "Scout", "Ledger"]) await picker.getByRole("option", { name: new RegExp(`^${n}`) }).click();
    await win.getByRole("button", { name: "Create group" }).click();
    await expect(win.getByPlaceholder("Message Planner, Scout & Ledger")).toBeVisible();
  }
  await expect(sidebar.getByRole("link", { name: /Planner, Scout & Ledger/ })).toHaveCount(1);
  expect((await agents(api)).filter((a) => a.group)).toHaveLength(1);
  const reuse = await api<{ id: string; reused: boolean }>("createGroup", { memberIds: [ledger, planner, scout] });
  expect(reuse.reused).toBe(true);
  const group = reuse.id;

  // A 5,000-char post with emoji and RTL text lands whole in the host transcript.
  const composer = win.getByPlaceholder("Message Planner, Scout & Ledger");
  const big = `${"שלום עולם 👋🏽 ".repeat(250)}`.slice(0, 4990) + " END";
  await composer.fill(big);
  await composer.press("Enter");
  await expect(async () => {
    const user = (await tail(api, group)).filter((e) => e.kind === "message" && e.role === "user");
    expect(user.map((e) => (e as { content: string }).content)).toContain(big);
  }).toPass({ timeout: 5000 });
  await expect(async () => expect((await tail(api, group)).some((e) => e.kind === "event")).toBe(true)).toPass({ timeout: 15_000 }); // room turn done

  // Remove a member while a room turn runs: the room epoch cancels it, so the slow turn never posts.
  await composer.fill("@everyone slowly compare two cabins");
  await composer.press("Enter");
  await win.waitForTimeout(800);
  await api("setGroupMembers", { id: group, memberIds: [planner, scout] });
  await win.waitForTimeout(6000);
  expect(sendTexts(await tail(api, group)).filter((t) => t.includes("slowly compare two cabins"))).toEqual([]);
  // Add the member back through the UI.
  const panel = win.getByRole("complementary", { name: "Conversation details" });
  await panel.getByRole("button", { name: STR.addMember }).click();
  await win.getByRole("menuitem", { name: "Ledger" }).click();
  await expect(async () => expect((await agents(api)).find((a) => a.id === group)!.group!.memberIds).toHaveLength(3)).toPass({ timeout: 5000 });

  // Kill the local host during a room turn: the app reconnects to the restarted host, the group survives, and a new post works.
  await composer.fill("@everyone slowly pick a date");
  await composer.press("Enter");
  await win.waitForTimeout(800);
  await restartLocalHost(app, win);
  expect((await agents(api)).find((a) => a.id === group)?.group?.memberIds).toHaveLength(3);
  await sidebar.getByRole("link", { name: /Planner, Scout & Ledger/ }).click();
  await win.getByPlaceholder("Message Planner, Scout & Ledger").fill("@Scout after the restart");
  await win.getByPlaceholder("Message Planner, Scout & Ledger").press("Enter");
  await expect(transcript.getByText("Here's a first take: after the restart")).toBeVisible({ timeout: 15_000 });

  await win.setViewportSize({ width: 1024, height: 680 });
  for (const scheme of ["dark", "light"] as const) {
    await win.emulateMedia({ colorScheme: scheme });
    await win.waitForTimeout(150);
    expect(await noHorizontalOverflow(win)).toBe(true);
  }
  await app.close();
});

test("C6/A5 widget answered twice is rejected; host killed mid-routine-run records the interruption", async () => {
  const { app, win, api } = await launch("fuzz-p4-widget");
  await createBot(win, "Planner");
  const planner = await botId(api, "Planner");
  const transcript = win.getByRole("log", { name: "Conversation transcript" });
  const composer = win.getByPlaceholder("Message Planner", { exact: true });

  // Answer a widget twice: the first answer wins, the UI disables the options, and a second answer is rejected by the host.
  await composer.fill("choose: Hudson or Beacon");
  await composer.press("Enter");
  const card = win.getByRole("group", { name: "Which one?" });
  await card.getByRole("button", { name: "Beacon" }).click();
  await expect(transcript.getByText("You picked beacon.")).toBeVisible({ timeout: 10_000 });
  expect(await card.getByRole("button", { name: "Hudson" }).isDisabled()).toBe(true);
  const widget = (await tail(api, planner)).find((e) => e.kind === "send-message" && (e.message as { type?: string }).type === "widget")!;
  const second = await api<{ status: string }>("respondToWidget", { id: planner, entryId: widget.id, value: "hudson" }).then((r) => r.status, (e: Error) => `rejected: ${e.message}`);
  expect(second).toBe("rejected: WIDGET_CLOSED: This question was already answered.");
  await win.waitForTimeout(1500);
  await expect(transcript.getByText("You picked hudson.")).toHaveCount(0);

  // Kill the local host during a routine run: after the restart the run reads as interrupted, in the host and in the UI.
  await makeRoutine(win, "Nightly", "Summarize the day slowly");
  const panel = win.getByRole("complementary", { name: "Conversation details" });
  await panel.getByRole("button", { name: /^Nightly,/ }).click();
  await panel.getByRole("button", { name: STR.testRun }).click();
  await expect(async () => expect((await routinesOf(api, planner))[0]!.runs[0]!.status).toBe("running")).toPass({ timeout: 3000 });
  await restartLocalHost(app, win);
  await expect(async () => {
    const run = (await routinesOf(api, planner))[0]!.runs[0]!;
    expect(run.status).toBe("error");
    expect(run.detail).toBe(STR.runInterrupted);
  }).toPass({ timeout: 10_000 });
  // The open routine detail must refresh after the reconnect instead of showing "Running" forever.
  await expect(panel.getByText(STR.runInterrupted)).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator("ul.runs li.running")).toHaveCount(0);
  await app.close();
});
