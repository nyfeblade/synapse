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
  source: "metering", budgetUsd: null, budgetPct: null,
  level: "L0", limitedUntil: null, weekStart: 0,
  rows: [{ botId: "a", name: "Courier", model: "claude-sonnet-5", turns: 142, tokens: 3_100_000, costUsd: 9.4 }, { botId: "b", name: "Ledger", model: "claude-opus-5", turns: 38, tokens: 2_400_000, costUsd: 21.1 }],
  efficiency: { dropped: 112, wakesAvoided: 14, burstsCoalesced: 2, loopsEnded: 0 },
};
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: { ...view, budgetUsd: (args as { usd?: number }).usd ?? null } }; }),
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
    render(<UsageSection />);
    expect(screen.getByText("API spend")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Courier");
    expect(rows[1]!.textContent).toContain("Sonnet 5");
    expect(rows[1]!.textContent).toContain("3.1M");
    expect(rows[1]!.textContent).toContain("$9.40");
    expect(screen.getByText("Messages dropped").parentElement!.textContent).toContain("112");
    expect(screen.getByText("by the anti-ack gate")).toBeTruthy();
  });

  it("no Claude plan line or plan usage bar (the API key is the only sign-in)", () => {
    render(<UsageSection />);
    expect(screen.queryByText(/plan$/, { selector: "span" })).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "Weekly usage" })).toBeNull();
  });

  it("sets a fixed weekly budget; Billing opens the Anthropic Console", async () => {
    render(<UsageSection />);
    fireEvent.change(screen.getByRole("combobox", { name: "Weekly budget: None" }), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText(STR5.budgetAmount), { target: { value: "25" } });
    fireEvent.blur(screen.getByLabelText(STR5.budgetAmount));
    await vi.waitFor(() => expect(calls).toContainEqual(["setWeeklyBudget", { usd: 25 }]));
    fireEvent.click(screen.getByRole("button", { name: "Billing" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://console.anthropic.com/settings/billing" }]));
  });

  // UI polish pass (critique 5.6): the usage figure lives on the account row, not as a menu item.
  it("account menu holds actions only — no Weekly usage row repeating the account line", () => {
    const labels = accountMenuItems().filter((i) => "label" in i).map((i) => i.label);
    expect(labels.some((l) => /Weekly usage/.test(l))).toBe(false);
    expect(labels).toContain("Settings");
  });

  // Fix round 1, finding 1: mode/amount must not freeze at their first-mount value — the view
  // starts null (load() and the "usage" SSE channel fill it in asynchronously), so a later
  // budgetUsd change (an async load resolving, or a channel push) must re-sync the dropdown
  // and amount field while UsageSection stays mounted, the same way GeneralSection.tsx's
  // timezone <select> binds straight to the store instead of mirroring it into local state.
  it("re-syncs the budget dropdown and amount when the view's budgetUsd changes after mount", () => {
    useUsage.setState({ view: { ...view, budgetUsd: null } });
    render(<UsageSection />);
    expect(screen.getByRole("combobox", { name: "Weekly budget: None" })).toBeTruthy();
    expect(screen.queryByLabelText(STR5.budgetAmount)).toBeNull();

    // Simulate an async load() resolving, or a later "usage" channel push, with a
    // server-side fixed budget already set — UsageSection stays mounted throughout.
    act(() => { useUsage.setState({ view: { ...view, budgetUsd: 40 } }); });

    expect(screen.getByRole("combobox", { name: "Weekly budget: Fixed" })).toBeTruthy();
    expect((screen.getByLabelText(STR5.budgetAmount) as HTMLInputElement).value).toBe("40");

    // And a later push back to no budget must also re-sync (not stay stuck on "fixed").
    act(() => { useUsage.setState({ view: { ...view, budgetUsd: null } }); });
    expect(screen.getByRole("combobox", { name: "Weekly budget: None" })).toBeTruthy();
    expect(screen.queryByLabelText(STR5.budgetAmount)).toBeNull();
  });

  // Fix round 1, finding 2: a failing setWeeklyBudget gateway call must not become a silent
  // unhandled rejection — it must surface the same way deleteBot/setPinned/bot-actions.ts
  // already do (store.ts sets `actionError`, rendered by Sidebar.tsx as a role="alert" banner).
  it("surfaces a visible error and doesn't crash when setWeeklyBudget fails", async () => {
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (cmd: string) => {
        if (cmd === "setWeeklyBudget") return { ok: false, error: { code: "GATEWAY_ERROR", message: "Could not reach the computer" } };
        return { ok: true, result: view };
      }),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
    };
    render(<Sidebar />);
    render(<UsageSection />);
    fireEvent.change(screen.getByRole("combobox", { name: "Weekly budget: None" }), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText(STR5.budgetAmount), { target: { value: "25" } });
    fireEvent.blur(screen.getByLabelText(STR5.budgetAmount));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });
});
