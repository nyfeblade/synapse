// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR_AUTH, STR_COST } from "@synapse/shared";
import { KeyPrompts } from "../../src/renderer/components/KeyPrompts";

const KEY = "sk-ant-api03-" + "K".repeat(80) + "kp01";
let prompt = { show: true, suggestedUsd: 95 };
let boxKey = true;
let macHas = false;
const calls: [string, unknown][] = [];
let macFails = false;
const saveKey = vi.fn(async () => {
  if (macFails) return { apiKey: { masked: "sk-ant-…kp01", savedAt: 1 }, boxPublicKey: "PK", macSaved: false, macError: "This Mac's permission key can't be trusted." };
  macHas = true;
  return { apiKey: { masked: "sk-ant-…kp01", savedAt: 1 }, boxPublicKey: "PK", macSaved: true };
});
beforeEach(() => {
  calls.length = 0;
  prompt = { show: true, suggestedUsd: 95 };
  boxKey = true;
  macHas = false;
  macFails = false;
  try { localStorage.clear(); } catch { /* none */ }
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      if (c === "getBudgetPrompt") return { ok: true, result: prompt };
      if (c === "getAuth") return { ok: true, result: { apiKey: boxKey ? { masked: "sk-ant-…kp01", savedAt: 1 } : null, boxPublicKey: "PK" } };
      if (c === "dismissBudgetPrompt") { prompt = { ...prompt, show: false }; return { ok: true, result: {} }; }
      return { ok: true, result: {} };
    }),
    auth: { saveKey, testKey: vi.fn(), removeKey: vi.fn(), hasMacKey: vi.fn(async () => macHas) },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("one-time prompts once the box has an API key (the only sign-in; security review, minors 4 and 5)", () => {
  it("the auth view has no sign-in mode: both prompts apply whenever the box has a key", async () => {
    render(<KeyPrompts />);
    expect(await screen.findByLabelText(STR_COST.monthlyBudget)).toBeTruthy();
    expect(await screen.findByLabelText(STR_AUTH.macKeyTitle)).toBeTruthy();
    expect(calls.map((c) => c[0])).toContain("getBudgetPrompt");
  });

  it("a monthly budget pre-filled from the last 30 days; Save sets the account's monthly budget (ask at the limit) and ends the prompt", async () => {
    macHas = true;
    render(<KeyPrompts />);
    const input = await screen.findByLabelText(STR_COST.monthlyBudget);
    expect((input as HTMLInputElement).value).toBe("95");
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: STR_COST.save }));
    await waitFor(() => expect(screen.queryByLabelText(STR_COST.monthlyBudget)).toBeNull());
    // Review fix 2: merged into the account policy on the host, never a whole-policy replace from here.
    expect(calls).toContainEqual(["setMonthlyBudget", { usd: 120 }]);
    expect(calls.map((c) => c[0])).not.toContain("setBudget");
    expect(calls.map((c) => c[0])).toContain("dismissBudgetPrompt");
  });

  it("Not now ends the budget prompt without setting a budget", async () => {
    macHas = true;
    render(<KeyPrompts />);
    await screen.findByLabelText(STR_COST.monthlyBudget);
    fireEvent.click(screen.getByRole("button", { name: STR_COST.notNow }));
    await waitFor(() => expect(screen.queryByLabelText(STR_COST.monthlyBudget)).toBeNull());
    expect(calls.map((c) => c[0])).not.toContain("setBudget");
  });

  it("the box has a key but this Mac doesn't: asks once to save it here; saving hides it", async () => {
    prompt = { show: false, suggestedUsd: 5 };
    render(<KeyPrompts />);
    const input = await screen.findByLabelText(STR_AUTH.macKeyTitle);
    expect((input as HTMLInputElement).type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.save }));
    await waitFor(() => expect(screen.queryByLabelText(STR_AUTH.macKeyTitle)).toBeNull());
    expect(saveKey).toHaveBeenCalledWith(KEY);
  });

  it("no prompt when the Mac already has its copy, when there's no key on the box, or after Not now", async () => {
    prompt = { show: false, suggestedUsd: 5 };
    macHas = true;
    const a = render(<KeyPrompts />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText(STR_AUTH.macKeyTitle)).toBeNull();
    a.unmount();
    macHas = false;
    boxKey = false;
    const b = render(<KeyPrompts />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText(STR_AUTH.macKeyTitle)).toBeNull();
    b.unmount();
    boxKey = true;
    render(<KeyPrompts />);
    await screen.findByLabelText(STR_AUTH.macKeyTitle);
    fireEvent.click(screen.getByRole("button", { name: STR_COST.notNow }));
    cleanup();
    render(<KeyPrompts />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText(STR_AUTH.macKeyTitle)).toBeNull();
  });

  it("review fix 4: the Mac copy couldn't be saved: says so and keeps asking", async () => {
    prompt = { show: false, suggestedUsd: 5 };
    macFails = true;
    render(<KeyPrompts />);
    const input = await screen.findByLabelText(STR_AUTH.macKeyTitle);
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.save }));
    expect((await screen.findByRole("alert")).textContent).toContain("permission key");
    expect(screen.getByLabelText(STR_AUTH.macKeyTitle)).toBeTruthy();
  });
});
