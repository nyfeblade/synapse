// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendMeterView, Tray } from "@synapse/shared";
import { SpendMeter } from "../../src/renderer/components/SpendMeter";
import { Trays } from "../../src/renderer/components/Trays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useDashboard } from "../../src/renderer/usage/dashboard-store";
import { useSpendMeter } from "../../src/renderer/usage/meter-store";

// 5.7: the header's spend meter and the "Stopped: … kept failing at …" tray.
const meter = (o: Partial<SpendMeterView> = {}): SpendMeterView => ({ mode: "today", todayUsd: 1.24, monthUsd: 38.5, budgetUsd: null, budgetPct: null, warn: false, turns: {}, ...o });
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: cmd === "getUsageDashboard" ? null : {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  useUi.setState(initialState());
  useDashboard.setState({ range: "week", botId: "someone", view: null, error: null });
  useSpendMeter.setState({ view: null });
});
afterEach(cleanup);

describe("the header spend meter", () => {
  it("is a quiet number: today's spend, neutral until near the budget", () => {
    useSpendMeter.setState({ view: meter() });
    render(<SpendMeter botId="a" />);
    const b = screen.getByRole("button", { name: "Today $1.24" });
    expect(b.textContent).toBe("Today$1.24");
    expect(b.className).not.toContain("warn");
    act(() => useSpendMeter.setState({ view: meter({ warn: true, budgetPct: 85, budgetUsd: 45 }) }));
    expect(screen.getByRole("button").className).toContain("warn");
  });

  it("shows this month's figure when set to Month, and nothing when Off", () => {
    useSpendMeter.setState({ view: meter({ mode: "month" }) });
    const { container } = render(<SpendMeter botId="a" />);
    expect(screen.getByRole("button", { name: "Month $38.50" })).toBeTruthy();
    act(() => useSpendMeter.setState({ view: meter({ mode: "off" }) }));
    expect(container.innerHTML).toBe("");
  });

  it("adds this turn so far while this chat's Bot is working (another Bot's turn isn't shown here)", () => {
    useSpendMeter.setState({ view: meter({ turns: { a: 0.08, other: 0.5 } }) });
    render(<SpendMeter botId="a" />);
    expect(screen.getByRole("button", { name: "Today $1.24, This turn $0.08" })).toBeTruthy();
  });

  it("opens Usage (all Bots) when clicked", () => {
    useSpendMeter.setState({ view: meter() });
    render(<SpendMeter botId="a" />);
    fireEvent.click(screen.getByRole("button"));
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useDashboard.getState().botId).toBeNull();
  });
});

describe("the stopped-on-repeated-failure tray", () => {
  it("Continue and Stop reach the host with their action", () => {
    const tray: Tray = {
      id: "t1", botId: "a", title: "Stopped: Piper kept failing at npm install", detail: "4 tries · $0.09 spent", requestId: null, dedupeKey: "a:loop", count: 1, createdAt: 0,
      buttons: [{ label: "Continue", action: "loop-continue" }, { label: "Stop", action: "loop-stop" }],
    };
    useUi.setState({ trays: [tray] });
    render(<Trays botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls.filter(([c]) => c === "dismissTray").map(([, a]) => a)).toEqual([{ trayId: "t1", action: "loop-continue" }, { trayId: "t1", action: "loop-stop" }]);
  });
});
