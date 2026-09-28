// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRC } from "@synapse/shared";
import { useComputer } from "../../src/renderer/computer-state";
import { ScreenPreview } from "../../src/renderer/components/ScreenPreview";

const dialed = vi.hoisted(() => [] as string[]);
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: (_el: HTMLElement, url: string) => (dialed.push(url), { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect() {}, focus() {}, sendKey() {}, clipboardPasteFrom() {}, addEventListener() {}, removeEventListener() {} }) }));
const display = (botId: string, index: number) => ({ botId, index, display: `:${index}`, cdpPort: 9220 + index, running: false, generation: 0 });

describe("Screen preview says what is actually going on (fix-ui-botadmin)", () => {
  beforeEach(() => { dialed.length = 0; (window as unknown as { synapse: unknown }).synapse = { vncUrl: (b: string) => `ws://127.0.0.1:1/vnc/${b}?t=x` }; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("a Bot with no screen says so instead of showing a fake document", () => {
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [], waiting: [] } }));
    const { container } = render(<ScreenPreview botId="noscreen" name="Pixel" />);
    // The copy moved into STRC and shortened for bug 36 ("No screen for this Bot" → STRC.noScreen),
    // because it is now one of three headlines a user has to be able to tell apart. The claim is the
    // same and is checked harder: it says so, it is NOT the fake document, and — new — it does not
    // read as a failure, because a Bot with no screen is the ordinary case.
    expect(screen.getByRole("status").textContent).toBe(STRC.noScreen);
    expect(container.querySelector(".screen-page")).toBeNull();
    expect(container.querySelector(".screen-absence.error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a preview that never connects offers Retry, which dials again", () => {
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [display("slow", 1)], waiting: [] } }));
    const { container } = render(<ScreenPreview botId="slow" name="Scout" />);
    expect(container.querySelector(".screen-page")).toBeTruthy(); // connecting: the placeholder page
    act(() => { vi.advanceTimersByTime(16_000); });
    expect(screen.getByRole("status").textContent).toBe("Preview unavailable");
    expect(container.querySelector(".screen-page")).toBeNull();
    expect(dialed).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(dialed).toHaveLength(2);
    expect(container.querySelector(".screen-page")).toBeTruthy();
  });

  it("still says 'Waiting for a screen' while the host is finding one", () => {
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [], waiting: ["queued"] } }));
    render(<ScreenPreview botId="queued" name="Pixel" />);
    expect(screen.getByRole("status").textContent).toBe(STRC.waitingForScreen);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
