// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRC } from "@synapse/shared";
import { useComputer } from "../../src/renderer/computer-state";
import { ComputerGlyph } from "../../src/renderer/components/ComputerGlyph";
import { ScreenPreview } from "../../src/renderer/components/ScreenPreview";

const dialed = vi.hoisted(() => [] as string[]);
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: (_el: HTMLElement, url: string) => (dialed.push(url), { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect() {}, focus() {}, sendKey() {}, clipboardPasteFrom() {}, addEventListener() {}, removeEventListener() {} }) }));
const display = (botId: string, index: number) => ({ botId, index, display: `:${index}`, cdpPort: 9220 + index, running: false, generation: 0 });

describe("right-panel preview (S14, CMP-06)", () => {
  beforeEach(() => { (window as unknown as { synapse: unknown }).synapse = { vncUrl: (b: string) => `ws://127.0.0.1:1/vnc/${b}?t=x` }; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("is an enabled 'Open computer' button with the '<Bot>'s screen' caption that opens the computer view", () => {
    render(<ScreenPreview botId="b" name="Scout" />);
    const btn = screen.getByRole("button", { name: "Open computer" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByText("Scout's screen")).toBeTruthy();
    fireEvent.click(btn);
    expect(useComputer.getState().open).toEqual({ botId: "b" });
  });

  it("a Bot without a screen on the shared computer never dials VNC; it connects once the host gives it one (fuzz: 4th Bot → 404 → proxy 502)", () => {
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [display("a", 2)], waiting: [] } }));
    render(<ScreenPreview botId="nobox" name="Pixel" />);
    expect(dialed.filter((u) => u.includes("/vnc/nobox"))).toEqual([]);
    expect(screen.getByText("Pixel's screen")).toBeTruthy(); // the placeholder page still shows
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [display("a", 2), display("nobox", 3)], waiting: [] } }));
    expect(dialed.filter((u) => u.includes("/vnc/nobox"))).toEqual(["ws://127.0.0.1:1/vnc/nobox?t=x"]);
  });

  it("shows 'Waiting for a screen' when the host says this Bot is waiting for one (controller ruling 1)", () => {
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [], waiting: ["nobox"] } }));
    render(<ScreenPreview botId="nobox" name="Pixel" />);
    expect(screen.getByText(STRC.waitingForScreen)).toBeTruthy();
  });

  it("the header glyph is purple for 5 s after computer activity", () => {
    render(<ComputerGlyph botId="b" />);
    const g = screen.getByRole("button", { name: "Computer activity" });
    expect(g.className).not.toContain("active");
    act(() => useComputer.getState().apply({ channel: "computer-action", payload: { botId: "b", index: 2, kind: "click", x: 1, y: 1, at: 1, source: "computer" } }));
    expect(g.className).toContain("active");
    act(() => { vi.advanceTimersByTime(5100); });
    expect(g.className).not.toContain("active");
  });
});
