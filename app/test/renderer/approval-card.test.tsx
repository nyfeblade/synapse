// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCardView } from "@synapse/shared";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const base: ApprovalCardView = {
  approvalId: "ap1", requestId: "req_1", surface: "mcp", title: "Your Bot would like to use a connected service",
  reason: "Delete 3 events from your Google Calendar on Friday afternoon.", summary: "Use Google Calendar tool delete_events with {…}",
  locationLine: "Runs on Bots' computer", details: 'google_calendar.delete_events({"calendar":"primary"})', command: 'google_calendar.delete_events({"calendar":"primary"})',
  items: [], hasProposedRule: true, status: "pending", cause: null, ruleAddedText: null, createdAt: 1, settledAt: null,
  verdict: { reason: "Deletes events.", tier: 3, matchedRuleIds: [], floorCategory: "F4", stage: "model" },
};
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: { status: "approved" } }; }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }) };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner" } } as never } });
});
afterEach(cleanup);

describe("ApprovalCard (APR-09, APR-19, APR-20)", () => {
  it("pending: title, reason, location, open details and the three buttons", async () => {
    render(<ApprovalCard botId="a" approval={base} />);
    const card = screen.getByRole("region", { name: "Approval needed" });
    expect(card.textContent).toContain("Your Bot would like to use a connected service");
    expect(card.textContent).toContain("Runs on Bots' computer");
    expect(card.querySelector("details")?.hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await vi.waitFor(() => expect(calls[0]).toEqual(["resolveAutoReviewApproval", { id: "a", approvalId: "ap1", choice: "always" }]));
  });

  it("settled: header by outcome, status pill, rule text, full request sheet and Settings link", () => {
    render(<ApprovalCard botId="a" approval={{ ...base, status: "always", ruleAddedText: "Added to your Auto-review rules as always allowed: “Use the …”", settledAt: 2 }} />);
    const card = screen.getByRole("region", { name: "Approved action" });
    expect(card.textContent).toContain("Action approved");
    expect(card.textContent).toContain("Always allowed");
    expect(card.textContent).toContain("Added to your Auto-review rules as always allowed");
    fireEvent.click(screen.getByRole("button", { name: "View the full request ›" }));
    const sheet = screen.getByRole("dialog", { name: "Full request" });
    expect(sheet.textContent).toContain("F4");
    expect(sheet.textContent).toContain("req_1");
    // bug 198 (fix round 1, finding 8): the command is a code card now, wrapped (not horizontally
    // scrolled) inside its own `.sheet-command` box — never a bare, unstyled `<pre>`.
    expect(sheet.querySelector(".sheet-command .code-card")).not.toBeNull();
    expect(sheet.querySelector(".code-card-pre")?.textContent).toContain("google_calendar.delete_events");
    expect(sheet.querySelector("pre.mono.sheet-command")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsFocus: "auto-review" });
  });

  it("expired and batched variants", () => {
    const { rerender } = render(<ApprovalCard botId="a" approval={{ ...base, status: "expired", cause: "ttl" }} />);
    expect(screen.getByRole("region", { name: "Expired approval" }).textContent).toContain("Approval expired");
    rerender(<ApprovalCard botId="a" approval={{ ...base, title: "Planner wants to send 5 emails", items: [1, 2, 3, 4, 5].map((i) => ({ toolUseId: `t${i}`, summary: `Re: thread ${i}`, status: "pending" as const })) }} />);
    const card = screen.getByRole("region", { name: "Approval needed" });
    expect(card.textContent).toContain("Planner wants to send 5 emails");
    expect(card.textContent).toContain("Re: thread 2");
    expect(card.textContent).not.toContain("Re: thread 3");
    fireEvent.click(screen.getByRole("button", { name: "and 3 more" }));
    expect(card.textContent).toContain("Re: thread 5");
  });

  // Gate H-1: with no rule to add, Always allow would silently become Allow once, so it isn't offered.
  it("hides Always allow when the reviewer has no rule to propose (hasProposedRule false)", () => {
    render(<ApprovalCard botId="a" approval={{ ...base, hasProposedRule: false }} />);
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
