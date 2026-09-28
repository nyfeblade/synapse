// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/components/Composer";
import { useComposer } from "../../src/renderer/composer-store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge } from "./fake-bridge";

const ASK = "Piper is at $5.10 of its $5.00 daily budget (API-equivalent). The next step is estimated at about $0.12. Continue?";

describe("Composer: a budget that asks first (cost-dashboard)", () => {
  let calls: [string, unknown][];
  let approved: boolean;
  beforeEach(() => {
    const b = installFakeBridge();
    calls = b.calls;
    approved = false;
    const inner = window.synapse.call;
    window.synapse.call = vi.fn(async (cmd: string, args: unknown) => {
      if (cmd === "sendPrompt" && !approved) { calls.push([cmd, args]); return { ok: false, error: { code: "BUDGET_ASK", message: ASK } }; }
      if (cmd === "approveBudget") approved = true;
      return inner(cmd as never, args as never);
    }) as never;
    useComposer.setState({ byBot: {} });
    useUi.setState({ ...initialState(), actionError: null } as never);
    try { localStorage.clear(); } catch { /* storage unavailable */ }
  });
  afterEach(cleanup);

  it("shows an approval card with the estimate, keeps the message, and sends it on Continue", async () => {
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "draft the whole report" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const card = await screen.findByRole("group", { name: "Budget check" });
    expect(card.textContent).toContain("estimated at about $0.12");
    expect((box as HTMLTextAreaElement).value).toBe("draft the whole report");
    expect(useUi.getState().actionError).toBeFalsy(); // the card is the message: no second banner
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls).toContainEqual(["approveBudget", { botId: "b" }]));
    await waitFor(() => expect(calls.filter(([c]) => c === "sendPrompt")).toHaveLength(2));
    expect(calls.filter(([c]) => c === "sendPrompt")[1]![1]).toMatchObject({ text: "draft the whole report" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Budget check" })).toBeNull());
  });

  it("Not now dismisses the card and keeps the draft", async () => {
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "later" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("group", { name: "Budget check" });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Budget check" })).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe("later");
    expect(calls.filter(([c]) => c === "approveBudget")).toHaveLength(0);
  });
});
