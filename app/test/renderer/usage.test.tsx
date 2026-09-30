// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, type UsageView } from "@synapse/shared";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { accountMenuItems } from "../../src/renderer/components/account-menu";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { formatTokens, useUsage } from "../../src/renderer/usage/store";

const view: UsageView = {
  source: "metering", budgetPct: null,
  level: "L0", limitedUntil: null, weekStart: 0,
  rows: [{ botId: "a", name: "Courier", model: "claude-sonnet-5", turns: 142, tokens: 3_100_000, costUsd: 9.4 }, { botId: "b", name: "Ledger", model: "claude-opus-5", turns: 38, tokens: 2_400_000, costUsd: 21.1 }],
  efficiency: { dropped: 112, wakesAvoided: 14, burstsCoalesced: 2, loopsEnded: 0 },
};
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); void args; return { ok: true, result: view }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (name: string, args: unknown) => { calls.push([`native:${name}`, args]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
  useUsage.setState({ view });
  useUi.setState(initialState());
});
afterEach(cleanup);

describe("Usage & Billing (Usage.dc.html)", () => {
  it("formats tokens like the board", () => {
    expect(formatTokens(3_100_000)).toBe("3.1M");
    expect(formatTokens(940_000)).toBe("940K");
    expect(formatTokens(812)).toBe("812");
  });

  it("shows API spend, table and tiles", () => {
    useUi.setState({ settings: { ...(useUi.getState().settings ?? {}), advancedEnabled: true } as never }); // new-user walk finding 8: advanced controls
    render(<UsageSection />);
    expect(screen.getByText("API spend")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Courier");
    expect(rows[1]!.textContent).toContain("Sonnet 5");
    expect(rows[1]!.textContent).toContain("3.1M");
    expect(rows[1]!.textContent).toContain("$9.40");
    expect(screen.getByText("Messages dropped").parentElement!.textContent).toContain("112");
    expect(screen.queryByText("by the anti-ack gate")).toBeNull(); // new-user walk finding 8: no plumbing subtitles
  });

  it("no Claude plan line or plan usage bar (the API key is the only sign-in)", () => {
    render(<UsageSection />);
    expect(screen.queryByText(/plan$/, { selector: "span" })).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "Weekly usage" })).toBeNull();
  });

  it("new-user walk finding 7: no second (weekly) budget here; Billing opens the Anthropic Console", async () => {
    render(<UsageSection />);
    expect(screen.queryByRole("combobox", { name: /Weekly budget/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Weekly budget/);
    fireEvent.click(screen.getByRole("button", { name: "Billing" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://console.anthropic.com/settings/billing" }]));
  });

  // UI polish pass (critique 5.6): the usage figure lives on the account row, not as a menu item.
  it("account menu holds actions only — no Weekly usage row repeating the account line", () => {
    const labels = accountMenuItems().filter((i) => "label" in i).map((i) => i.label);
    expect(labels.some((l) => /Weekly usage/.test(l))).toBe(false);
    expect(labels).toContain("Settings");
  });

});
