// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STRC } from "@synapse/shared";
import { initialComputer, loadDisplays, useComputer } from "../../src/renderer/computer-state";
import { screenAbsence } from "../../src/renderer/screen-absence";
import { ComputerView } from "../../src/renderer/components/ComputerView";
import { ScreenPreview } from "../../src/renderer/components/ScreenPreview";
import { useUi } from "../../src/renderer/store";

/**
 * Bug 36 — a blank screen area must say WHICH of three things happened.
 *
 * `displays[botId]` being absent had exactly one rendering: nothing. Three different situations
 * produced it, and a user looking at the empty rectangle (and therefore anyone reading their bug
 * report — see bug 3) could not tell them apart:
 *
 *   1. the getDisplays fetch FAILED (host down, box stopped, gateway unreachable),
 *   2. the host answered and reports NO display for this Bot,
 *   3. the Bot is past MAX_SCREENS and is waiting for a seat — normal, by design.
 *
 * Case 3 is the healthy, common one and must not read as a failure. Case 1 is the only one with an
 * action, so it is the only one that gets a Retry. Each of the three carries a DISTINCT headline,
 * because the headline is what a user quotes back.
 */

const rfb = { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect: vi.fn(), focus: vi.fn(), sendKey: vi.fn(), clipboardPasteFrom: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: () => rfb }));

const display = (botId: string, index: number) => ({ botId, index, display: `:${index}`, cdpPort: 9220 + index, running: true, generation: 1 });

/** window.synapse with a getDisplays that can be made to fail. */
function installBridge(getDisplays: () => unknown) {
  const calls: string[] = [];
  (window as unknown as { synapse: unknown }).synapse = {
    vncUrl: (b: string) => `ws://127.0.0.1:1/vnc/${b}?t=x`,
    call: async (cmd: string) => {
      calls.push(cmd);
      if (cmd !== "getDisplays") return { ok: true, result: {} };
      try {
        return { ok: true, result: getDisplays() };
      } catch (e) {
        return { ok: false, error: { code: "GATEWAY_ERROR", message: (e as Error).message } };
      }
    },
  };
  return calls;
}

beforeEach(() => {
  useComputer.setState(initialComputer());
  useUi.setState({
    bots: { b: { id: "b", profile: { name: "Scout", avatarShape: "pebble", avatarColor: "#3472d9" } } } as never,
    transcripts: { b: [] } as never,
  });
  installBridge(() => ({ displays: [], waiting: [] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("screenAbsence — the three reasons, told apart (bug 36)", () => {
  const base = { displays: {}, waiting: [] as string[], displaysLoad: "ready" as const, displaysError: null };

  it("a Bot that HAS a display is not absent at all", () => {
    expect(screenAbsence({ ...base, displays: { b: display("b", 2) } }, "b")).toBeNull();
  });

  it("the fetch failed → unreachable, and it carries the host's reason", () => {
    expect(screenAbsence({ ...base, displaysLoad: "failed", displaysError: "connect ECONNREFUSED" }, "b"))
      .toEqual({ kind: "unreachable", error: "connect ECONNREFUSED" });
  });

  it("the host answered and this Bot is waiting for a seat → waiting, not a failure", () => {
    expect(screenAbsence({ ...base, waiting: ["b"] }, "b")).toEqual({ kind: "waiting" });
  });

  it("the host answered and simply has no display for this Bot → none", () => {
    expect(screenAbsence(base, "b")).toEqual({ kind: "none" });
  });

  it("nothing has been asked yet → loading, which is not an answer and must not claim one", () => {
    expect(screenAbsence({ ...base, displaysLoad: "loading" }, "b")).toEqual({ kind: "loading" });
  });

  it("a stale display plus a failed refresh still counts as having a screen (the pool reports its own dial)", () => {
    expect(screenAbsence({ ...base, displays: { b: display("b", 2) }, displaysLoad: "failed", displaysError: "x" }, "b")).toBeNull();
  });

  it("the three reasons have three different headlines — a user's quote identifies one", () => {
    const heads = [STRC.screenUnreachable, STRC.waitingForScreen, STRC.noScreen];
    expect(new Set(heads).size).toBe(3);
  });
});

describe("computer-state records a failed getDisplays instead of swallowing it", () => {
  it("a successful load marks displays ready and clears the error", async () => {
    installBridge(() => ({ displays: [display("b", 2)], waiting: [] }));
    await act(async () => { await loadDisplays(); });
    expect(useComputer.getState().displaysLoad).toBe("ready");
    expect(useComputer.getState().displaysError).toBeNull();
    expect(useComputer.getState().displays.b).toBeTruthy();
  });

  it("a failed load is recorded with its reason — it is NOT indistinguishable from an empty answer", async () => {
    installBridge(() => { throw new Error("Could not reach the computer"); });
    await act(async () => { await loadDisplays(); });
    expect(useComputer.getState().displaysLoad).toBe("failed");
    expect(useComputer.getState().displaysError).toContain("Could not reach the computer");
  });

  it("a later `displays` SSE event heals a failed load (the channel is the live path)", async () => {
    installBridge(() => { throw new Error("down"); });
    await act(async () => { await loadDisplays(); });
    expect(useComputer.getState().displaysLoad).toBe("failed");
    act(() => useComputer.getState().apply({ channel: "displays", payload: { displays: [display("b", 2)], waiting: [] } }));
    expect(useComputer.getState().displaysLoad).toBe("ready");
    expect(useComputer.getState().displaysError).toBeNull();
  });
});

describe("the sidebar thumbnail says why it is blank", () => {
  it("case 1 — the fetch failed: the reason and a Retry, in the place the screen would be", async () => {
    installBridge(() => { throw new Error("Could not reach the computer"); });
    await act(async () => { await loadDisplays(); });
    render(<ScreenPreview botId="b" name="Scout" />);
    expect(screen.getByText(STRC.screenUnreachable)).toBeTruthy();
    expect(screen.getByRole("button", { name: STR.retry })).toBeTruthy();
  });

  it("case 1 — Retry actually re-asks the host, and the thumbnail recovers", async () => {
    let up = false;
    const calls = installBridge(() => { if (!up) throw new Error("down"); return { displays: [display("b", 2)], waiting: [] }; });
    await act(async () => { await loadDisplays(); });
    render(<ScreenPreview botId="b" name="Scout" />);
    up = true;
    calls.length = 0;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.retry })); });
    expect(calls).toContain("getDisplays");
    await waitFor(() => expect(screen.queryByText(STRC.screenUnreachable)).toBeNull());
  });

  it("case 2 — the host has no display for this Bot: ordinary copy, and NO Retry (nothing to retry)", async () => {
    installBridge(() => ({ displays: [display("other", 2)], waiting: [] }));
    await act(async () => { await loadDisplays(); });
    render(<ScreenPreview botId="b" name="Scout" />);
    expect(screen.getByText(STRC.noScreen)).toBeTruthy();
    expect(screen.queryByText(STRC.screenUnreachable)).toBeNull();
    expect(screen.queryByRole("button", { name: STR.retry })).toBeNull();
  });

  it("case 3 — past MAX_SCREENS: 'Waiting for a screen', and it must not read as an error", async () => {
    installBridge(() => ({ displays: [], waiting: ["b"] }));
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ScreenPreview botId="b" name="Scout" />);
    expect(screen.getByText(STRC.waitingForScreen)).toBeTruthy();
    expect(screen.queryByText(STRC.screenUnreachable)).toBeNull();
    expect(screen.queryByRole("button", { name: STR.retry })).toBeNull();
    expect(container.querySelector(".screen-absence.error")).toBeNull();
  });

  it("before the first answer, the thumbnail claims nothing — no reason is shown while loading", () => {
    render(<ScreenPreview botId="b" name="Scout" />);
    for (const s of [STRC.screenUnreachable, STRC.noScreen, STRC.waitingForScreen]) expect(screen.queryByText(s)).toBeNull();
  });
});

describe("the full computer view says why the stage is blank", () => {
  beforeEach(() => useComputer.setState({ open: { botId: "b" } }));

  it("case 1 — the fetch failed: the reason and a Retry on the stage", async () => {
    installBridge(() => { throw new Error("Could not reach the computer"); });
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ComputerView />);
    const stage = container.querySelector(".cv-stage")!;
    expect(stage.textContent).toContain(STRC.screenUnreachable);
    expect(screen.getByRole("button", { name: STR.retry })).toBeTruthy();
  });

  it("case 2 — no display for this Bot: ordinary copy naming the Bot, no Retry", async () => {
    installBridge(() => ({ displays: [], waiting: [] }));
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ComputerView />);
    const stage = container.querySelector(".cv-stage")!;
    expect(stage.textContent).toContain(STRC.noScreen);
    expect(stage.textContent).toContain(STRC.noScreenHelp("Scout"));
    expect(screen.queryByRole("button", { name: STR.retry })).toBeNull();
  });

  it("case 3 — past MAX_SCREENS: waiting, with the reason spelled out and no error styling", async () => {
    installBridge(() => ({ displays: [], waiting: ["b"] }));
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ComputerView />);
    const stage = container.querySelector(".cv-stage")!;
    expect(stage.textContent).toContain(STRC.waitingForScreen);
    expect(stage.textContent).toContain(STRC.waitingForScreenHelp);
    expect(container.querySelector(".screen-absence.error")).toBeNull();
  });

  it("a Bot WITH a screen is not told it has no screen", async () => {
    installBridge(() => ({ displays: [display("b", 2)], waiting: [] }));
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ComputerView />);
    expect(container.querySelector(".cv-canvas")).toBeTruthy();
    // Connecting/dial-failed is bug 38 (the VNC session), not an absence of a seat.
    expect(container.textContent).not.toContain(STRC.noScreen);
    expect(container.textContent).not.toContain(STRC.waitingForScreen);
    expect(container.textContent).not.toContain(STRC.screenUnreachable);
  });

  it("the note is announced, so it is not a silent rectangle for a screen-reader either", async () => {
    installBridge(() => ({ displays: [], waiting: [] }));
    await act(async () => { await loadDisplays(); });
    const { container } = render(<ComputerView />);
    expect(container.querySelector(".cv-stage [role='status']")).toBeTruthy();
  });
});
