import { expect } from "@playwright/test";
import { STR, type BotSummary, type RoutineView } from "@synapse/shared";
import { createBot, launch, type Api } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * Bug 44(a) in the running app: "a routine the host declines to arm goes on being listed as Active."
 *
 * WRITTEN BUT NOT EXECUTED. The coordinator stopped e2e runs on this machine while this branch was
 * being built (real Electron windows and keychain prompts on the user's screen), so this spec has
 * never been run. Everything it asserts is covered at the host level by
 * `host/test/routines/routine-health.test.ts`, including one case that boots the real host through
 * `createHostApp` and drives it over the gateway; this spec is the same claim seen from the app.
 *
 * Two of the three states cannot be reached from here and are deliberately not attempted:
 *   - an unparseable SCHEDULE has to arrive by a Bot writing `automation.json` itself, since the
 *     save path normalizes schedules and refuses the rest (covered in the host test by writing the
 *     file under the running host's data root);
 *   - bug 47's sidecar needs a real recording with a screen, which this profile has no way to give.
 */

const routinesOf = async (api: Api, id: string) => (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id })).routines;
const botId = async (api: Api, name: string) => (await api<{ agents: BotSummary[] }>("listAgents")).agents.find((a) => a.profile.name === name && !a.group)!.id;

test("bug 44a: an email routine the host cannot subscribe says so on its own row", async () => {
  const { app, win, api } = await launch("fuzz-routine-health");
  await createBot(win, "Planner");
  const planner = await botId(api, "Planner");

  // A filter the subscriber could never parse is refused at the door, in words, instead of being
  // saved as a routine listed as Active for ever.
  await expect(api("createAgentAutomation", { id: planner, name: "Starred mail", prompt: "Summarize it.", trigger: { email: { account: "work", query: "is:starred" } } }))
    .rejects.toThrow(/BAD_ROUTINE/);
  expect(await routinesOf(api, planner)).toEqual([]);

  // A filter it CAN parse, for a mailbox that is not set up: this one is recoverable — adding the
  // mailbox arms it — so it stays Active and its own run history says it is not watching yet.
  await api("createAgentAutomation", { id: planner, name: "Invoices", prompt: "File them.", trigger: { email: { account: "work", query: "from:billing" } } });
  await expect(async () => {
    const [r] = await routinesOf(api, planner);
    expect(r!.enabled).toBe(true);
    expect(r!.runs[0]?.detail ?? "").toContain(STR.routineNoMailbox("work"));
  }).toPass({ timeout: 5000 });

  // And the user can read it: the routine's row in the details panel shows the failed entry.
  const panel = win.getByRole("complementary", { name: "Conversation details" });
  await panel.getByRole("button", { name: /^Invoices,/ }).click();
  await expect(panel.getByText(new RegExp(STR.routineNoMailbox("work").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeVisible({ timeout: 5000 });
  await expect(panel.getByRole("switch", { name: STR.active })).toHaveAttribute("aria-checked", "true");

  await app.close();
});
