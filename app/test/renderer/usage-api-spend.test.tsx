// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDashboardView, UsageView } from "@synapse/shared";
import { UsageDashboard } from "../../src/renderer/components/settings/UsageDashboard";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useDashboard } from "../../src/renderer/usage/dashboard-store";
import { BILLING_URLS, useUsage } from "../../src/renderer/usage/store";

/** synapse-public: API spend in dollars (Today / This week / This month) always; no Claude plan usage anywhere. */
const HOUR = 3_600_000;
const t0 = Date.UTC(2026, 8, 14, 4);
const dash = (o: Partial<UsageDashboardView> = {}): UsageDashboardView => ({
  range: "week", botId: null, start: t0, end: t0 + 7 * 24 * HOUR,
  spend: { today: 1.25, week: 4.5, month: 17, bots: [{ botId: "a", name: "Courier", today: 1.25, week: 4.5, month: 17 }] },
  totals: { inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 1, tokens: 4, usd: 4.5, runs: 3 },
  series: [{ start: t0, usd: 1, tokens: 1 }], bots: [], tasks: [], top: [], comparison: null,
  budgets: { config: { account: null, bots: {} }, status: [], taskAlerts: [] },
  ...o,
});
const usage = (o: Partial<UsageView> = {}): UsageView => ({
  source: "metering", budgetUsd: null, budgetPct: null,
  level: "L0", limitedUntil: null, weekStart: 0, rows: [], efficiency: { dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 }, ...o,
});

let answer = dash();
const native: [string, unknown][] = [];
beforeEach(() => {
  native.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string) => ({ ok: true, result: cmd === "getUsageDashboard" ? answer : cmd === "getUsage" ? useUsage.getState().view : answer.budgets })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
  useUi.setState(initialState());
  useDashboard.setState({ range: "week", botId: null, view: null, error: null });
});
afterEach(cleanup);

describe("the usage dashboard: API spend only", () => {
  it("API spend today / this week / this month, per Bot; no plan windows, no \"not billed on your plan\"", async () => {
    answer = dash();
    render(<UsageDashboard />);
    const card = await screen.findByLabelText("API spend", { selector: ".dash-kpis" });
    expect(card.textContent).toContain("Today");
    expect(card.textContent).toContain("$1.25");
    expect(card.textContent).toContain("This week");
    expect(card.textContent).toContain("This month");
    expect(card.textContent).toContain("$17.00");
    expect(screen.queryByLabelText("Plan limits")).toBeNull();
    expect(document.body.textContent).not.toMatch(/your plan/i);
  });
});

describe("Usage and billing: no Claude plan", () => {
  it("no plan usage bar, no Manage plan, no claude.ai links; Billing opens the Anthropic Console", async () => {
    useUsage.setState({ view: usage() });
    render(<UsageSection />);
    expect(screen.queryByRole("progressbar", { name: "Weekly usage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage usage" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/on Claude|your plan/i);
    fireEvent.click(screen.getByRole("button", { name: "Billing" }));
    await waitFor(() => expect(native).toContainEqual(["openExternal", { url: BILLING_URLS.consoleBilling }]));
    expect(Object.values(BILLING_URLS).some((u) => u.includes("claude.ai"))).toBe(false);
  });
});
