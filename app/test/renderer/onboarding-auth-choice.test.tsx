// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, STR_AUTH, type AuthView } from "@synapse/shared";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";

const KEY = "sk-ant-api03-" + "O".repeat(80) + "wxyz";
let view: AuthView;
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  view = { apiKey: null, boxPublicKey: "PK" };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      if (c === "getOnboarding") return { ok: true, result: { hasSeenOnboarding: false, tokenConfigured: false } };
      return { ok: true, result: view };
    }),
    auth: { saveKey: vi.fn(async () => { view = { ...view, apiKey: { masked: "sk-ant-…wxyz", savedAt: 1 } }; return view; }), testKey: vi.fn() },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("first run: the Anthropic API key is the only sign-in", () => {
  it("asks for the API key; no subscription choice and no Connect Claude step", async () => {
    render(<Onboarding onDone={() => {}} initialStep="setup" />);
    expect(await screen.findByText(STR_AUTH.firstRunTitle)).toBeTruthy();
    expect(await screen.findByLabelText(STR_AUTH.keyLabel)).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/subscription|Connect Claude/i);
  });

  it("save the key and the tour starts", async () => {
    render(<Onboarding onDone={() => {}} initialStep="setup" />);
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect(await screen.findByRole("heading", { name: STR5.meetApp })).toBeTruthy();
    expect(calls.some(([c]) => c === "setAuthMode")).toBe(false);
  });
});
