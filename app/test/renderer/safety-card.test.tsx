// @vitest-environment jsdom
// Safety v2: a card names the rule that raised it, with Always allow this, Make this a rule… and Loosen this rule….
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCardView } from "@synapse/shared";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: { status: "always" } }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Scout" }, group: null } as never } });
});
afterEach(cleanup);

const card = (over: Partial<ApprovalCardView> = {}): ApprovalCardView => ({
  approvalId: "ap1", requestId: "r", surface: "mcp", title: "Your Bot would like to use a connected service", reason: "This sends an email from your account.",
  summary: "Send an email to bob@acme.example", locationLine: null, details: null, command: null, items: [], hasProposedRule: true, status: "pending",
  cause: null, verdict: null, ruleAddedText: null, createdAt: 0, settledAt: null,
  trigger: { kind: "rule", label: "Sends", ruleId: "preset-sends", source: "preset" }, suggestedRule: "Always allow sends to bob@acme.example", ...over,
});

describe("a card names its rule", () => {
  it("shows the rule, and Always allow this answers the card", async () => {
    render(<ApprovalCard botId="a" approval={card()} />);
    expect(screen.getByText("Sends").closest(".card-rule")?.textContent).toBe("RuleSends");
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await vi.waitFor(() => expect(calls).toEqual([["resolveAutoReviewApproval", { id: "a", approvalId: "ap1", choice: "always" }]]));
  });

  it("Make this a rule… opens Rules with the suggested rule; Loosen this rule… opens the rule", () => {
    render(<ApprovalCard botId="a" approval={card()} />);
    fireEvent.click(screen.getByRole("button", { name: "Make this a rule…" }));
    expect(useUi.getState().settingsFocus).toBe(`auto-review/add:${encodeURIComponent("Always allow sends to bob@acme.example")}`);
    fireEvent.click(screen.getByRole("button", { name: "Loosen this rule…" }));
    expect(useUi.getState().settingsFocus).toBe("auto-review/rule:preset-sends");
  });

  it("a reviewer card shows no rule line and no Loosen", () => {
    render(<ApprovalCard botId="a" approval={card({ trigger: { kind: "reason", label: "Looks risky" }, suggestedRule: null })} />);
    expect(document.querySelector(".card-rule")).toBeNull();
    expect(screen.queryByRole("button", { name: "Loosen this rule…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Make this a rule…" })).toBeTruthy();
  });
});
