// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageView } from "@synapse/shared";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { useUsage } from "../../src/renderer/usage/store";

/** Background model calls (memory extraction, episodes, dreaming, …) are recorded now; the view splits the week
 *  by kind of work and says plainly when older figures were rebuilt from the running totals stored before the fix. */
const view: UsageView = {
  source: "metering", budgetPct: null, level: "L0", limitedUntil: null, weekStart: 0,
  rows: [{ botId: "a", name: "Chief of Staff", model: "claude-sonnet-5", turns: 8, tokens: 5_000_000, costUsd: 3.74 }],
  efficiency: { dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 },
  byPurpose: [
    { group: "conversations", costUsd: 3.7429, calls: 8, tokens: 5_000_000 },
    { group: "memory", costUsd: 0.0123, calls: 14, tokens: 42_000 },
  ],
  costHistory: { repaired: 8, estimated: 1, before: Date.UTC(2026, 8, 21, 17, 40) },
};

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: view })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  useUsage.setState({ view });
});
afterEach(cleanup);

describe("Usage view: spend by kind of work", () => {
  it("separates Conversations from Background memory", () => {
    render(<UsageSection />);
    const table = screen.getByRole("table", { name: "This week by kind of work" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Kind"),
      expect.stringMatching(/Conversations.*8.*\$3\.74/),
      expect.stringMatching(/Background memory.*14.*\$0\.01/),
    ]);
  });

  it("says plainly that older figures were rebuilt, and how many are estimates", () => {
    render(<UsageSection />);
    const note = screen.getByText(/were rebuilt from running totals/);
    expect(note.textContent).toMatch(/1 entry is an estimate\./);
    expect(note.className).toContain("muted");
  });

  it("shows neither when the host sends no breakdown (an older host)", () => {
    useUsage.setState({ view: { ...view, byPurpose: undefined, costHistory: null } });
    render(<UsageSection />);
    expect(screen.queryByRole("table", { name: "This week by kind of work" })).toBeNull();
    expect(screen.queryByText(/rebuilt from running totals/)).toBeNull();
  });
});
