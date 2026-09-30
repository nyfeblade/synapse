// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDashboardView } from "@synapse/shared";
import { UsageDashboard } from "../../src/renderer/components/settings/UsageDashboard";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { barLayout, niceCeil } from "../../src/renderer/usage/chart";
import { openUsageFor, useDashboard } from "../../src/renderer/usage/dashboard-store";
import { REFERENCE_NAME } from "../../../scripts/public-scan";

const HOUR = 3_600_000;
const t0 = Date.UTC(2026, 8, 14, 4);
const view = (o: Partial<UsageDashboardView> = {}): UsageDashboardView => ({
  range: "week", botId: null, start: t0, end: t0 + 7 * 24 * HOUR,
  spend: { today: 0, week: 0, month: 0, bots: [] },
  totals: { inputTokens: 1200, cacheReadTokens: 800_000, cacheWriteTokens: 90_000, outputTokens: 30_000, tokens: 921_200, usd: 4.25, runs: 57 },
  series: Array.from({ length: 7 }, (_, i) => ({ start: t0 + i * 24 * HOUR, usd: i === 2 ? 3 : 0.2, tokens: 1000 })),
  bots: [{ botId: "a", name: "Courier", inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 1, tokens: 4, usd: 4.25, runs: 57 }],
  tasks: [{ key: "routine:Morning brief", label: "Morning brief", kind: "routine", runs: 7, usd: 2.1, tokens: 500 }, { key: "group:conversations", label: "Conversations", kind: "conversation", runs: 50, usd: 2.15, tokens: 400 }],
  top: [{ requestId: "r1", botId: "a", name: "Courier", label: "Morning brief", startedAt: t0 + 50 * HOUR, usd: 0.91, tokens: 99_000, link: { chatId: "a", entryId: "a_s9_1" } }],
  comparison: { monthUsd: 4.25, lowUsd: 9.1, midUsd: 11.4, highUsd: 14.2, ratioMid: 2.68, basis: "An estimate, not a measurement: modeled workloads." },
  budgets: { config: { account: null, bots: {} }, status: [], taskAlerts: [{ botId: "a", name: "Courier", limitUsd: 2, spentUsd: 0.5, since: t0 }] },
  ...o,
});

const calls: [string, unknown][] = [];
let answer: UsageDashboardView = view();
beforeEach(() => {
  calls.length = 0;
  answer = view();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "getUsageDashboard") return { ok: true, result: answer };
      return { ok: true, result: answer.budgets };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Courier" } } } as never });
  useDashboard.setState({ range: "week", botId: null, view: null, error: null });
});
afterEach(cleanup);

describe("chart geometry", () => {
  it("rounds the axis up to a readable number", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(0.37)).toBe(0.4);
    expect(niceCeil(3)).toBe(4);
    expect(niceCeil(7.2)).toBe(10);
    expect(niceCeil(1234)).toBe(2000);
  });
  it("lays bars out left to right, tallest at the axis max, zero as zero", () => {
    const l = barLayout([0, 1, 3], 300, 100);
    expect(l.max).toBe(4);
    expect(l.bars.map((b) => Math.round(b.h))).toEqual([0, 25, 75]);
    expect(l.bars[1]!.x).toBeGreaterThan(l.bars[0]!.x);
    expect(l.bars.every((b) => b.y + b.h === 100)).toBe(true);
  });
});

describe("Usage dashboard", () => {
  it("shows spend in dollars (API key billing), with no Claude plan windows", async () => {
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.queryByText(/not billed on your plan/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Spend over time" })).toBeTruthy();
    expect(screen.queryByText("5-hour window")).toBeNull();
    expect(screen.queryByLabelText("Plan limits")).toBeNull();
    expect(screen.getByRole("img", { name: /Spend per day/ })).toBeTruthy();
    for (const part of ["Input", "Cache read", "Cache write", "Output"]) expect(screen.getAllByText(part).length).toBeGreaterThan(0);
  });

  it("switches range and Bot, asking the host each time", async () => {
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    await waitFor(() => expect(calls).toContainEqual(["getUsageDashboard", { range: "month", botId: null }]));
    fireEvent.change(screen.getByRole("combobox", { name: "Bot" }), { target: { value: "a" } });
    await waitFor(() => expect(calls).toContainEqual(["getUsageDashboard", { range: "month", botId: "a" }]));
  });

  it("groups by task and links the most expensive runs to their chat message", async () => {
    const jumpTo = vi.fn(async () => {});
    useUi.setState({ jumpTo } as never);
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.getAllByText("Morning brief").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Open the message: Courier, Morning brief/ }));
    expect(jumpTo).toHaveBeenCalledWith("a", "a_s9_1");
  });

  it("shows the comparison as a labelled estimate, only on the month view", async () => {
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.queryByText(/hosted agent/)).toBeNull();
    answer = view({ range: "month" });
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    await screen.findByText(/A typical hosted agent's overhead would have been about \$11\.40/);
    // The UI never names another product (bug 118).
    expect(document.body.textContent).not.toMatch(REFERENCE_NAME);
    expect(screen.getByText(/estimate/i, { selector: ".dash-compare-basis" })).toBeTruthy();
  });

  it("new-user walk finding 7: the account budget is one monthly $ field; the rest waits for advanced controls", async () => {
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.queryByLabelText("Daily limit")).toBeNull();
    expect(screen.queryByLabelText("Warn at (%)")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Account budget \(all Bots\)|Applies to chats/);
    fireEvent.change(screen.getByLabelText("Monthly budget"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(calls).toContainEqual(["setBudget", { botId: null, policy: { limits: [{ period: "month", unit: "usd", limit: 120 }], warnPct: 80, onLimit: "ask" } }]));
  });

  it("new-user walk finding 7: a per-Bot budget is an advanced control", async () => {
    useDashboard.setState({ botId: "a" });
    answer = view({ botId: "a" });
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.queryByRole("button", { name: "Save budget" })).toBeNull();
  });

  it("saves a Bot's daily budget with its warning and 100% action", async () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never });
    useDashboard.setState({ botId: "a" });
    answer = view({ botId: "a" });
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    fireEvent.change(screen.getByLabelText("Daily limit"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Warn at (%)"), { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("At the limit"), { target: { value: "pause" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(calls).toContainEqual(["setBudget", { botId: "a", policy: { limits: [{ period: "day", unit: "usd", limit: 5 }], warnPct: 75, onLimit: "pause" } }]));
  });

  it("lists a task alert and clears it", async () => {
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.getByText(/Courier: tell me before \$2\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear alert for Courier" }));
    await waitFor(() => expect(calls).toContainEqual(["clearTaskAlert", { botId: "a" }]));
  });

  it("shows an error, not a crash, against a host without the dashboard", async () => {
    answer = { plan: null } as never;
    render(<UsageDashboard />);
    await screen.findByText(/no usage dashboard yet/);
  });

  it("opens from a Bot's header already filtered to that Bot", async () => {
    await act(async () => { openUsageFor("a"); });
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useDashboard.getState().botId).toBe("a");
    await waitFor(() => expect(calls).toContainEqual(["getUsageDashboard", { range: "week", botId: "a" }]));
  });
});

describe("review of new-user walk finding 7: hidden limits still show, and Remove says what it removes", () => {
  const budgets = (config: UsageDashboardView["budgets"]["config"]) => view({ budgets: { config, status: [], taskAlerts: [] } });

  it("a daily account limit and a per-Bot budget show as plain rows without advanced controls", async () => {
    answer = budgets({ account: { limits: [{ period: "day", unit: "usd", limit: 5 }, { period: "month", unit: "usd", limit: 100 }], warnPct: 80, onLimit: "ask" }, bots: { a: { limits: [{ period: "month", unit: "usd", limit: 3 }], warnPct: 80, onLimit: "ask" } } });
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.getByText("Daily limit").parentElement!.textContent).toContain("$5.00");
    expect(document.body.textContent).toContain("Courier: $3.00 a month");
  });

  it("Remove monthly budget removes only the monthly limit", async () => {
    answer = budgets({ account: { limits: [{ period: "day", unit: "usd", limit: 5 }, { period: "month", unit: "usd", limit: 100 }], warnPct: 70, onLimit: "pause" }, bots: {} });
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    fireEvent.click(screen.getByRole("button", { name: "Remove monthly budget" }));
    await waitFor(() => expect(calls).toContainEqual(["setBudget", { botId: null, policy: { limits: [{ period: "day", unit: "usd", limit: 5 }], warnPct: 70, onLimit: "pause" } }]));
  });

  it("a monthly limit in tokens is shown as tokens, not as dollars in the $ field", async () => {
    answer = budgets({ account: { limits: [{ period: "month", unit: "tokens", limit: 2_000_000 }], warnPct: 80, onLimit: "ask" }, bots: {} });
    render(<UsageDashboard />);
    await screen.findAllByText("$4.25");
    expect(screen.getByText("Monthly limit").parentElement!.textContent).toContain("2.0M tokens");
    expect((screen.getByLabelText("Monthly budget") as HTMLInputElement).value).toBe("");
  });
});
