// @vitest-environment jsdom
// Hand-testing round, the per-Bot settings panel: secrets, the advanced switches, follow-ups and
// routines. Each test here was written RED against the shipped component before the fix landed.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvancedSettingsCard } from "../../src/renderer/components/AdvancedSettingsCard";
import { FollowupsToggle } from "../../src/renderer/components/FollowupsToggle";
import { RoutineDetail } from "../../src/renderer/components/RoutineDetail";
import { RoutinesSection } from "../../src/renderer/components/RoutinesSection";
import { SecretsSection } from "../../src/renderer/components/SecretsSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { COPY, bot, installBridge, routine, settings } from "./settings-fixtures";

let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useUi.setState({ ...initialState(), bots: { a: bot }, settings: settings() });
});
afterEach(cleanup);

describe("Bot settings panel", () => {
  it("SecretsSection shows the failure instead of an empty list", async () => {
    h.secrets.list.mockRejectedValueOnce(new Error("the box is restarting"));
    render(<SecretsSection botId="a" />);
    expect(await screen.findByText("the box is restarting")).toBeTruthy();
  });

  it("SecretsSection shows a loading line rather than pretending there are no secrets", () => {
    h.secrets.list.mockReturnValueOnce(new Promise(() => []));
    render(<SecretsSection botId="a" />);
    expect(screen.getByText(COPY.loading)).toBeTruthy();
  });

  it("a failed Advanced switch write explains itself instead of doing nothing", async () => {
    h.gateway = () => new Error("the box is restarting");
    render(<AdvancedSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Show advanced controls" }));
    await waitFor(() => expect(useUi.getState().actionError).toBe("the box is restarting"));
  });

  it("FollowupsToggle follows the live advanced flag, like the Advanced card beside it", async () => {
    useUi.setState({ settings: settings({ advancedEnabled: true }) });
    render(<FollowupsToggle botId="a" />);
    expect(await screen.findByRole("switch", { name: "Proactive follow-ups" })).toBeTruthy();
    act(() => { useUi.setState({ settings: settings({ advancedEnabled: false }) }); });
    expect(screen.queryByRole("switch", { name: "Proactive follow-ups" })).toBeNull();
  });

  it("RoutinesSection shows a failed load with a Retry instead of a bare heading", async () => {
    h.gateway = () => new Error("the box is restarting");
    render(<RoutinesSection botId="a" />);
    expect(await screen.findByText("the box is restarting")).toBeTruthy();
    h.gateway = () => ({ routines: [routine()] });
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByText("Morning inbox sweep")).toBeTruthy();
  });

  it("an emptied routine field snaps back to what the routine actually says", async () => {
    useUi.setState({ routines: { a: [routine()] }, panel: "routine", routineId: "morning-inbox-sweep" });
    render(<RoutineDetail botId="a" routineId="morning-inbox-sweep" onBack={() => {}} />);
    const name = screen.getByLabelText("Routine name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.blur(name);
    await waitFor(() => expect(name.value).toBe("Morning inbox sweep"));
    expect(h.calls.filter(([c]) => c === "updateAgentAutomation")).toEqual([]);
  });

  it("a routine field shows the value the host normalised it to", async () => {
    useUi.setState({ routines: { a: [routine()] }, panel: "routine", routineId: "morning-inbox-sweep" });
    h.gateway = () => ({ routine: routine({ description: "Every day at 9:00 AM", scheduleRaw: "CRON_TZ=America/New_York 0 9 * * *" }) });
    render(<RoutineDetail botId="a" routineId="morning-inbox-sweep" onBack={() => {}} />);
    const when = screen.getByLabelText("When to run") as HTMLInputElement;
    fireEvent.change(when, { target: { value: "every day at 9" } });
    fireEvent.blur(when);
    await waitFor(() => expect(when.value).toBe("Every day at 9:00 AM"));
  });
});
