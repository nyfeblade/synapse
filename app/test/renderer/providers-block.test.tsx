// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CONSENT_VERSION, STR_PROVIDER_UI, providerConsentText, type ProvidersView } from "@synapse/shared";
import { ProvidersBlock } from "../../src/renderer/components/settings/ProvidersBlock";

const KEY = "sk-proj-0123456789abcdefWXYZ";
let view: ProvidersView;
const calls: [string, unknown][] = [];
const saveKey = vi.fn();
const testKey = vi.fn();
const row = (id: "openai" | "ollama", label: string, local: boolean) => ({ id, label, local, key: null, consented: false, consentText: providerConsentText(id), consentVersion: PROVIDER_CONSENT_VERSION });
beforeEach(() => {
  calls.length = 0;
  view = { boxPublicKey: "PK", providers: [row("openai", "OpenAI", false), row("ollama", "Ollama", true)] };
  saveKey.mockReset().mockImplementation(async (p: string) => { view = { ...view, providers: view.providers.map((r) => (r.id === p ? { ...r, key: { masked: "sk-…WXYZ", savedAt: 1 } } : r)) }; return view; });
  testKey.mockReset().mockResolvedValue({ ok: true, kind: "ok", title: STR_PROVIDER_UI.keyOk, detail: "" });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: { provider?: string }) => {
      calls.push([c, a]);
      if (c === "consentProvider") view = { ...view, providers: view.providers.map((r) => (r.id === a.provider ? { ...r, consented: true } : r)) };
      if (c === "clearProviderKey") view = { ...view, providers: view.providers.map((r) => (r.id === a.provider ? { ...r, key: null } : r)) };
      return { ok: true, result: view };
    }),
    providers: { saveKey, testKey },
    onEvent: () => () => {}, onConnection: () => () => {},
  };
});
afterEach(cleanup);

describe("Settings → Account: model providers", () => {
  it("asks for consent first; only then offers the key field, which saves through the sealed IPC path", async () => {
    render(<ProvidersBlock />);
    const openai = await screen.findByLabelText("OpenAI");
    expect(screen.queryByLabelText(STR_PROVIDER_UI.keyLabel("openai"))).toBeNull();
    fireEvent.click(openai.querySelector("button")!);
    const sheet = await screen.findByRole("region", { name: STR_PROVIDER_UI.consentTitle("openai") });
    expect(sheet.textContent).toContain("Bots on OpenAI send OpenAI their conversation");
    fireEvent.click(within(sheet).getByRole("button", { name: STR_PROVIDER_UI.consentAllow }));
    const input = await screen.findByLabelText(STR_PROVIDER_UI.keyLabel("openai"));
    expect(calls).toContainEqual(["consentProvider", { provider: "openai", textVersion: PROVIDER_CONSENT_VERSION }]);
    expect((input as HTMLInputElement).type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_PROVIDER_UI.save }));
    await waitFor(() => expect(screen.getByText("sk-…WXYZ")).toBeTruthy());
    expect(saveKey).toHaveBeenCalledWith("openai", KEY);
    expect(calls.some(([, a]) => JSON.stringify(a).includes(KEY))).toBe(false); // the key never goes over the plain gateway call
    fireEvent.click(screen.getByRole("button", { name: STR_PROVIDER_UI.test }));
    expect(await screen.findByText(STR_PROVIDER_UI.keyOk)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR_PROVIDER_UI.remove }));
    await waitFor(() => expect(calls).toContainEqual(["clearProviderKey", { provider: "openai" }]));
  });

  it("a model on this Mac needs consent and no key; Cancel leaves it off", async () => {
    render(<ProvidersBlock />);
    const ollama = await screen.findByLabelText("Ollama");
    expect(ollama.textContent).toContain(STR_PROVIDER_UI.local);
    fireEvent.click(ollama.querySelector("button")!);
    expect((await screen.findByRole("region", { name: STR_PROVIDER_UI.consentTitle("ollama") })).textContent).toContain("stay on this Mac");
    fireEvent.click(screen.getByRole("button", { name: STR_PROVIDER_UI.consentCancel }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(calls.filter(([c]) => c === "consentProvider")).toEqual([]);
    expect(screen.queryByLabelText(STR_PROVIDER_UI.keyLabel("ollama"))).toBeNull();
  });
});
