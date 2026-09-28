// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRS, type RoutineView, type StandupCard as Card, type StandupView } from "@synapse/shared";
import { SchedulesSection } from "../../src/renderer/components/settings/SchedulesSection";
import { settingsSections } from "../../src/renderer/components/settings/sections";
import { StandupCard } from "../../src/renderer/standup/StandupCard";
import { useStandup } from "../../src/renderer/standup/store";

const card: Card = {
  id: "c1", createdAt: Date.now(), scheduledFor: Date.now(), caughtUp: true, idle: ["Ivy"], usage: { modelCalls: 2, inputTokens: 330, outputTokens: 60 },
  lines: [
    { botId: "b1", name: "Courier", did: "Filed 12 invoices", blocked: "nothing", needs: "nothing" },
    { botId: "b2", name: "Scout", did: "Drafted 3 replies", blocked: "your approval", needs: "an approval to send" },
  ],
};
const routine = (over: Partial<RoutineView> = {}): RoutineView => ({
  botId: "b1", id: "inbox", name: "Inbox digest", prompt: "p", enabled: true, triggerKind: "schedule", schedule: "0 8 * * 1-5", scheduleRaw: null,
  description: "At 8:00 AM, Monday through Friday", nextRunAt: null, lastRunAt: null, createdAt: 0, runs: [], webhook: null, trigger: null, listenerConnected: null,
  quietHours: "22:00-07:00", ...over,
});

const calls: { cmd: string; args: unknown }[] = [];
let view: StandupView;
beforeEach(() => {
  calls.length = 0;
  view = { settings: { enabled: false, time: "09:00", weekdaysOnly: true, spoken: false }, latest: card, nextAt: null };
  useStandup.setState({ view: null, error: null, running: false });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "getStandup") return { ok: true, result: view };
      if (cmd === "setStandupSettings") { view = { ...view, settings: { ...view.settings, ...(args as object) } }; return { ok: true, result: view }; }
      if (cmd === "listAllAutomations") return { ok: true, result: { routines: [routine(), routine({ botId: "b2", id: "prep", name: "Meeting prep", triggerKind: "calendar", schedule: null, description: "10 minutes before a calendar event", quietHours: null })] } };
      if (cmd === "setAgentAutomationEnabled") return { ok: true, result: { routine: routine({ enabled: false }) } };
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {},
  };
});
afterEach(cleanup);

describe("Team standup card", () => {
  it("shows one line per Bot, what it is blocked on and needs, the idle Bots, and a caught-up tag", () => {
    render(<StandupCard card={card} />);
    expect(screen.getByText("Team standup")).toBeTruthy();
    expect(screen.getByText("Filed 12 invoices")).toBeTruthy();
    expect(screen.getByText("Blocked on: your approval")).toBeTruthy();
    expect(screen.getByText("Needs from you: an approval to send")).toBeTruthy();
    expect(screen.queryByText(/Blocked on: nothing/)).toBeNull();
    expect(screen.getByText("Idle: Ivy")).toBeTruthy();
    expect(screen.getByText(/caught up/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("a failed standup says it failed instead of \"Every Bot was idle\", and Run now runs it again (bug 115)", () => {
    render(<StandupCard card={{ ...card, lines: [], idle: [], error: STRS.standupFailed }} />);
    expect(screen.getByRole("alert").textContent).toBe(STRS.standupFailed);
    expect(screen.queryByText(STRS.standupAllIdle)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: STRS.standupRunNow }));
    expect(calls.some((c) => c.cmd === "runStandupNow")).toBe(true);
  });
});

describe("Settings → Schedules", () => {
  it("is a settings section", () => {
    expect(settingsSections().find((s) => s.id === "schedules")?.label).toBe("Schedules");
  });

  it("lists every Bot's schedules with quiet hours and a pause switch, and turns the standup on", async () => {
    render(<SchedulesSection />);
    expect(await screen.findByText("Inbox digest")).toBeTruthy();
    expect(screen.getByText("Meeting prep")).toBeTruthy();
    expect(screen.getByText(/Quiet hours 22:00-07:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Inbox digest: active" }));
    expect(calls.some((c) => c.cmd === "setAgentAutomationEnabled" && (c.args as { enabled: boolean }).enabled === false)).toBe(true);
    const sw = await screen.findByRole("switch", { name: "Daily standup" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await screen.findByLabelText("Time");
    expect(calls.some((c) => c.cmd === "setStandupSettings" && (c.args as { enabled: boolean }).enabled === true)).toBe(true);
    expect(screen.getByText("Team standup")).toBeTruthy();
  });
});
