// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFERED_PROVIDERS, PROVIDER_CONSENT_VERSION, STR5, STR_AUTH, STR_KEY_STEP, STR_PROVIDER_UI, providerConsentText, providerLabel,
  type ProviderTestResult, type ProvidersView, type SafetyReviewerView,
} from "@synapse/shared";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { SafetyReviewerBlock } from "../../src/renderer/components/settings/SafetyReviewerBlock";

/**
 * Any-key setup (Wave 2): the first-run key step offers every provider, Anthropic first and chosen. Another provider's
 * consent shows at the step and must be accepted; Save key tests the key before it saves it; the step finishes when
 * the host says a key is set up. The fakes stand in for the host: a key with "wrong" in it is rejected.
 */
const ok: ProviderTestResult = { ok: true, kind: "ok", title: STR_PROVIDER_UI.keyOk, detail: "" };
const rejected: ProviderTestResult = { ok: false, kind: "invalid-key", title: "Key rejected", detail: "OpenAI rejected the key." };
const unreachable: ProviderTestResult = { ok: false, kind: "unreachable", title: "Bot failed to respond", detail: "Can't reach LM Studio on this Mac. Is its server running?" };
let view: ProvidersView;
let working: Set<string>;
let anthropic: boolean;
const calls: [string, unknown][] = [];
const saveKey = vi.fn();
const testKey = vi.fn();
beforeEach(() => {
  calls.length = 0;
  working = new Set();
  anthropic = false;
  view = { boxPublicKey: "PK", providers: OFFERED_PROVIDERS.map((id) => ({ id, label: providerLabel(id), local: id === "ollama" || id === "lmstudio", key: null, consented: false, consentText: providerConsentText(id), consentVersion: PROVIDER_CONSENT_VERSION })) };
  const typed = new Map<string, string>();
  testKey.mockReset().mockImplementation(async (p: string, k: string) => {
    if (p === "lmstudio") return unreachable;
    if (/wrong/.test(k)) return rejected;
    if (k) typed.set(p, k); else working.add(p);
    return ok;
  });
  saveKey.mockReset().mockImplementation(async (p: string, k: string) => {
    if (typed.get(p) === k) working.add(p);
    view = { ...view, providers: view.providers.map((r) => (r.id === p ? { ...r, key: { masked: "sk-…WXYZ", savedAt: 1 } } : r)) };
    return view;
  });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: { provider?: string }) => {
      calls.push([c, a]);
      if (c === "getOnboarding") return { ok: true, result: { hasSeenOnboarding: false, tokenConfigured: anthropic || working.size > 0 } };
      if (c === "getAuth") return { ok: true, result: { apiKey: null, boxPublicKey: "PK" } };
      if (c === "consentProvider") view = { ...view, providers: view.providers.map((r) => (r.id === a.provider ? { ...r, consented: true } : r)) };
      if (c === "getProviders" || c === "consentProvider") return { ok: true, result: view };
      return { ok: true, result: {} };
    }),
    providers: { saveKey, testKey },
    auth: { saveKey: vi.fn(async () => { anthropic = true; return { apiKey: { masked: "sk-ant-…wxyz", savedAt: 1 }, boxPublicKey: "PK" }; }), testKey: vi.fn(async () => null) },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
});
afterEach(cleanup);

const choose = async (name: string) => fireEvent.click(await screen.findByRole("radio", { name }));
const allow = async (p: Parameters<typeof STR_PROVIDER_UI.consentTitle>[0]) => {
  const sheet = await screen.findByRole("region", { name: STR_PROVIDER_UI.consentTitle(p) });
  expect(sheet.textContent).toContain(providerConsentText(p));
  expect(within(sheet).queryByRole("button", { name: STR_PROVIDER_UI.consentCancel })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: STR_PROVIDER_UI.consentAllow }));
};

describe("the first-run key step: any provider", () => {
  it("offers Anthropic (chosen), OpenAI, OpenRouter, Gemini, Mistral, DeepSeek and On this Mac; Anthropic's panel is the one it always was", async () => {
    render(<Onboarding onDone={() => {}} initialStep="setup" />);
    const group = await screen.findByRole("radiogroup", { name: STR_KEY_STEP.provider });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Anthropic", "OpenAI", "OpenRouter", "Gemini", "Mistral", "DeepSeek", "On this Mac"]);
    expect(within(group).getByRole("radio", { name: "Anthropic" }).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByLabelText(STR_AUTH.keyLabel)).toBeTruthy();
    expect(screen.getByRole("link", { name: STR_AUTH.createKey })).toBeTruthy();
  });

  for (const p of ["openai", "openrouter", "gemini", "mistral", "deepseek"] as const) {
    it(`${providerLabel(p)}: the consent first, then a key that works finishes the step`, async () => {
      render(<Onboarding onDone={() => {}} initialStep="setup" />);
      await choose(providerLabel(p));
      expect(screen.queryByLabelText(STR_PROVIDER_UI.keyLabel(p))).toBeNull(); // nothing before consent
      await allow(p);
      expect(calls).toContainEqual(["consentProvider", { provider: p, textVersion: PROVIDER_CONSENT_VERSION }]);
      fireEvent.change(await screen.findByLabelText(STR_PROVIDER_UI.keyLabel(p)), { target: { value: `sk-${p}-0123456789abcdefWXYZ` } });
      fireEvent.click(screen.getByRole("button", { name: STR_KEY_STEP.saveKey }));
      expect(await screen.findByRole("heading", { name: STR5.meetApp })).toBeTruthy();
      expect(testKey).toHaveBeenCalledWith(p, `sk-${p}-0123456789abcdefWXYZ`);
      expect(saveKey).toHaveBeenCalledWith(p, `sk-${p}-0123456789abcdefWXYZ`);
      expect(calls.some(([, a]) => JSON.stringify(a).includes("0123456789abcdef"))).toBe(false); // the key only goes over the sealed path
    });
  }

  it("a key that doesn't work is not saved, says why, and the step stays", async () => {
    render(<Onboarding onDone={() => {}} initialStep="setup" />);
    await choose("OpenAI");
    await allow("openai");
    fireEvent.change(await screen.findByLabelText(STR_PROVIDER_UI.keyLabel("openai")), { target: { value: "sk-wrong-0123456789abcdefWXYZ" } });
    fireEvent.click(screen.getByRole("button", { name: STR_KEY_STEP.saveKey }));
    expect((await screen.findByRole("status")).textContent).toContain(rejected.title);
    expect(saveKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: STR5.meetApp })).toBeNull();
  });

  it("On this Mac: Ollama answers and the step is done; LM Studio not running says so", async () => {
    render(<Onboarding onDone={() => {}} initialStep="setup" />);
    await choose(STR_KEY_STEP.onThisMac);
    const apps = await screen.findByRole("radiogroup", { name: STR_KEY_STEP.localApp });
    expect(within(apps).getByRole("radio", { name: "Ollama" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(apps).getByRole("radio", { name: "LM Studio" }));
    await allow("lmstudio");
    fireEvent.click(await screen.findByRole("button", { name: STR_PROVIDER_UI.testLocal }));
    expect((await screen.findByRole("status")).textContent).toContain("Can't reach LM Studio");
    fireEvent.click(within(apps).getByRole("radio", { name: "Ollama" }));
    await allow("ollama");
    fireEvent.click(await screen.findByRole("button", { name: STR_PROVIDER_UI.testLocal }));
    expect(await screen.findByRole("heading", { name: STR5.meetApp })).toBeTruthy();
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("the Bot step says when there's no model on this Mac yet", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (c: string) => {
      if (c === "getOnboarding") return { ok: true, result: { hasSeenOnboarding: false, tokenConfigured: true, anthropicKey: false, provider: "ollama", newBotModel: null } };
      if (c === "listStarterTemplates") return { ok: true, result: { starters: [] } };
      return { ok: true, result: {} };
    });
    render(<Onboarding onDone={() => {}} initialStep="new-bot" />);
    expect((await screen.findByText(STR_KEY_STEP.noLocalModels)).getAttribute("role")).toBe("status");
  });
});

describe("Settings → Auto-review with no Anthropic key", () => {
  it("says plainly that safety review asks until its model passes the check", async () => {
    const v: SafetyReviewerView = { ref: "openai:gpt-6-luna", onClaude: false, qualified: false, checkedAt: null, reasons: [], state: "not-checked", choices: [{ ref: null, label: "Default" }, { ref: "openai:gpt-6-luna", label: "GPT-6 Luna · OpenAI" }], chosen: null, job: null };
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async () => ({ ok: true, result: v }));
    render(<SafetyReviewerBlock />);
    expect(await screen.findByText(STR_KEY_STEP.reviewerAsks)).toBeTruthy();
  });

  it("says nothing once the model qualified", async () => {
    const v: SafetyReviewerView = { ref: "openai:gpt-6-luna", onClaude: false, qualified: true, checkedAt: 1, reasons: [], state: "qualified", choices: [{ ref: null, label: "Default" }], chosen: null, job: null };
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async () => ({ ok: true, result: v }));
    render(<SafetyReviewerBlock />);
    await waitFor(() => expect(screen.getByText(STR_PROVIDER_UI.safetyQualified)).toBeTruthy());
    expect(screen.queryByText(STR_KEY_STEP.reviewerAsks)).toBeNull();
  });
});

describe("Claude-only features with no Anthropic key", () => {
  it("the model picker's What works says coding agents and computer helpers need an Anthropic key", async () => {
    const { ModelPickerList } = await import("../../src/renderer/components/ModelPicker");
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async () => ({ ok: true, result: { model: "openai:gpt-6.1-sol", usdPer100: null, turns: 0 } }));
    const view = { groups: [{ provider: "openai" as const, label: "OpenAI", models: [{ ref: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", badges: ["supported" as const], contextWindow: 1_050_000,
      whatWorks: [{ label: "Tools and replies", state: "yes" as const }, { label: "Coding agents", state: "needs-key" as const }, { label: "Computer helpers", state: "needs-key" as const }] }] }] };
    render(<ModelPickerList view={view} current="openai:gpt-6.1-sol" botId="b1" onPick={() => {}} />);
    const details = await screen.findByRole("region", { name: "GPT-6.1 Sol: what works" });
    expect(within(details).getAllByText(STR_KEY_STEP.needsAnthropicKey)).toHaveLength(2);
  });
});
