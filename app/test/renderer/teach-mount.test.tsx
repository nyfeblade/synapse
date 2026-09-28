// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, type TeachStatus } from "@synapse/shared";
import { useComputer } from "../../src/renderer/computer-state";
import { ComputerView } from "../../src/renderer/components/ComputerView";
import { ScreenPreview } from "../../src/renderer/components/ScreenPreview";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: () => ({ viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect() {}, focus() {}, sendKey() {}, clipboardPasteFrom() {}, addEventListener() {}, removeEventListener() {} }) }));

// Phase 4 Task 46 step 5, finished at integration: TeachPill and RecordingFrame live in the real Phase 3 screens.
const rec = (p: Partial<TeachStatus> = {}): TeachStatus => ({ state: "RECORDING", botId: "b", sessionId: "teach-1", sessionDir: "/w/t", startedAtMs: Date.now(), elapsedMs: 0, goal: "File an expense", ...p });

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = { vncUrl: () => "ws://x", call: async () => ({ ok: true, result: {} }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }) };
  useUi.setState({ ...initialState(), bots: { b: { id: "b", group: null, profile: { name: "Scout", avatarShape: "pebble", avatarColor: "#3472d9" } } } as never, transcripts: { b: [] } as never });
  useComputer.setState({ open: { botId: "b" }, displays: { b: { botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 } } });
});
afterEach(cleanup);

describe("Teach a task in the Phase 3 screens (TCH-01, TCH-02)", () => {
  it("the full-screen computer title bar has a working Teach a task pill", () => {
    render(<ComputerView />);
    const pill = screen.getByRole("button", { name: STR.teachTask }) as HTMLButtonElement;
    expect(pill.disabled).toBe(false);
    fireEvent.click(pill);
    expect(useUi.getState().teachSetupFor).toBe("b");
  });

  it("the full-screen computer view shows the red recording frame over the screen while this Bot records", () => {
    const { rerender } = render(<ComputerView />);
    expect(screen.queryByTestId("teach-frame")).toBeNull();
    useUi.setState({ teach: rec() });
    rerender(<ComputerView />);
    const viewport = screen.getByRole("application", { name: STR.screenCaption("Scout") });
    expect(within(viewport).getByTestId("teach-frame")).toBeTruthy();
  });

  it("the right-panel screen preview offers the pill and shows the frame while recording", () => {
    useUi.setState({ teach: rec() });
    render(<ScreenPreview botId="b" name="Scout" />);
    expect(screen.getByRole("button", { name: STR.teachTask })).toBeTruthy();
    const thumb = screen.getByRole("button", { name: "Open computer" });
    expect(within(thumb).getByTestId("teach-frame")).toBeTruthy();
  });
});
