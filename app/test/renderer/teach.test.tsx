// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, type TeachStatus } from "@synapse/shared";
import { RecordingFrame, TeachBanner } from "../../src/renderer/components/TeachBanner";
import { TeachPill } from "../../src/renderer/components/TeachPill";
import { applyEvent, initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const calls: [string, unknown][] = [];
const rec = (p: Partial<TeachStatus>): TeachStatus => ({ state: "RECORDING", botId: "a", sessionId: "teach-1", sessionDir: "/w/t", startedAtMs: Date.now(), elapsedMs: 0, goal: "File an expense", ...p });

beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: { status: rec({}) } }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({
    ...initialState(),
    bots: { a: { id: "a", profile: { name: "Scout" }, group: null } as never, g: { id: "g", profile: { name: "Room" }, group: { memberIds: ["a", "b"] } } as never },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Teach a task UI (TCH-01, TCH-02)", () => {
  it("the pill opens the setup banner; Start sends the goal", async () => {
    render(<><TeachPill botId="a" /><TeachBanner botId="a" /></>);
    fireEvent.click(screen.getByRole("button", { name: STR.teachTask }));
    expect(screen.getByText(STR.teachBanner)).toBeTruthy();
    expect(screen.getByText(STR.teachNoSecrets)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start recording" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("The result you want"), { target: { value: "File an expense" } });
    await act(async () => { fireEvent.click(start); });
    expect(calls).toContainEqual(["startTeachRecording", { id: "a", goal: "File an expense" }]);
  });

  it("is disabled in a group chat and while another Bot records", () => {
    const { rerender } = render(<TeachPill botId="g" />);
    expect((screen.getByRole("button", { name: STR.teachTask }) as HTMLButtonElement).disabled).toBe(true);
    useUi.setState({ teach: rec({ botId: "other" }) });
    rerender(<TeachPill botId="a" />);
    expect((screen.getByRole("button", { name: STR.teachTask }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the recording bar with a ticking timer, the watching line and the red frame; Stop & save and Discard call the host", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T17:12:00Z"));
    useUi.setState((s) => applyEvent(s, { channel: "teach-recording", payload: rec({ startedAtMs: Date.now() }) }));
    render(<><TeachBanner botId="a" /><RecordingFrame botId="a" /></>);
    expect(screen.getByText(STR.teachRec(0))).toBeTruthy();
    expect(screen.getByText(STR.teachWatching("Scout"))).toBeTruthy();
    expect(screen.getByTestId("teach-frame")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(screen.getByText("● REC 1:05")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.teachStopSave })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.teachDiscard })); });
    expect(calls.map((c) => c[0])).toEqual(["stopTeachRecording", "discardTeachRecording"]);
  });

  it("when event capture failed, the bar stops claiming the Bot is learning and says what to do (bug 47's warn)", () => {
    useUi.setState({ teach: rec({ videoOnly: true }) });
    render(<TeachBanner botId="a" />);
    expect(screen.queryByText(STR.teachWatching("Scout")), "a recording that captures only video is not 'watching and taking notes'").toBeNull();
    expect(screen.getByText(STR.teachVideoOnly)).toBeTruthy();
    // The note names its actions, and both are right there on the bar.
    expect(STR.teachVideoOnly).toContain(STR.teachDiscard);
    expect(STR.teachVideoOnly).toContain(STR.teachStopSave);
    expect(screen.getByRole("button", { name: STR.teachDiscard })).toBeTruthy();
    expect(screen.getByRole("button", { name: STR.teachStopSave })).toBeTruthy();
    act(() => { useUi.setState({ teach: rec({ state: "PAUSED", videoOnly: true }) }); });
    expect(screen.getByText(STR.teachVideoOnly), "pausing does not make the missing events come back").toBeTruthy();
  });

  it("a recording whose events are being captured shows no video-only note (must not fire)", () => {
    useUi.setState({ teach: rec({}) });
    render(<TeachBanner botId="a" />);
    expect(screen.getByText(STR.teachWatching("Scout"))).toBeTruthy();
    expect(screen.queryByText(STR.teachVideoOnly)).toBeNull();
  });

  it("hides the bar and frame when not recording", () => {
    useUi.setState({ teach: rec({ state: "ANALYZING" }) });
    render(<><TeachBanner botId="a" /><RecordingFrame botId="a" /></>);
    expect(screen.queryByText(/REC/)).toBeNull();
    expect(screen.queryByTestId("teach-frame")).toBeNull();
  });

  it("a paused recording shows a frozen timer and Continue, not a red frame still capturing", async () => {
    useUi.setState({ teach: rec({ state: "PAUSED", startedAtMs: Date.now() - 65_000, elapsedMs: 65_000 }) });
    render(<><TeachBanner botId="a" /><TeachPill botId="a" /><RecordingFrame botId="a" /></>);
    expect(screen.getByText(STR.teachPaused(65_000))).toBeTruthy();
    expect(screen.getByRole("button", { name: STR.teachContinue })).toBeTruthy();
    expect(screen.getByRole("button", { name: STR.teachStopSave })).toBeTruthy();
    expect(screen.queryByTestId("teach-frame")).toBeNull();
    expect((screen.getByRole("button", { name: STR.teachTask }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.teachContinue })); });
    expect(calls).toContainEqual(["resumeTeachRecording", { id: "a" }]);
  });
});
