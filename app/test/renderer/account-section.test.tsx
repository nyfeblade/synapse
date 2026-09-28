// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR_AUTH, type AuthView, type KeyCheckView } from "@synapse/shared";
import { AccountPanel } from "../../src/renderer/components/settings/AccountSection";

const KEY = "sk-ant-api03-" + "R".repeat(80) + "abcd";
let view: AuthView;
const NOT_CHECKED: KeyCheckView = { checkedAt: null, checking: false, works: null, problem: null, model: null, models: [], longContext: null, webSearch: null };
let checked: KeyCheckView;
let lastCheck: KeyCheckView;
const calls: [string, unknown][] = [];
const saveKey = vi.fn();
const testKey = vi.fn();
beforeEach(() => {
  calls.length = 0;
  view = { apiKey: null, boxPublicKey: "PK" };
  lastCheck = NOT_CHECKED;
  checked = { checkedAt: 2, checking: false, works: true, problem: null, model: "claude-haiku-4-5-20251001", models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"], longContext: true, webSearch: true };
  saveKey.mockReset().mockImplementation(async () => { view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } }; return view; });
  testKey.mockReset().mockResolvedValue({ ok: false, reached: true, kind: "invalid-key", status: 401, title: STR_AUTH.keyRejected, detail: STR_AUTH.keyRejectedDetail });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      if (c === "clearApiKey") view = { ...view, apiKey: null };
      if (c === "testAuthConnection") return { ok: true, result: { ok: true, reached: true, kind: "ok", status: 200, title: STR_AUTH.ok, detail: "" } };
      if (c === "checkApiKey") return { ok: true, result: (a as { refresh?: boolean }).refresh ? (lastCheck = checked) : lastCheck };
      return { ok: true, result: view };
    }),
    auth: { saveKey, testKey, removeKey: vi.fn(async () => { calls.push(["clearApiKey", {}]); view = { ...view, apiKey: null }; return view; }), hasMacKey: vi.fn(async () => true) },
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: {} }; }), on: () => () => {} },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
});
afterEach(cleanup);
/** The key field is always there (the only sign-in): just wait for the panel. */
const pickApiKey = async () => { await screen.findByLabelText(STR_AUTH.keyLabel); };

describe("Settings → Account: the Anthropic API key is the only sign-in", () => {
  it("shows only the API key field: no Claude subscription choice, no mode switch", async () => {
    render(<AccountPanel />);
    expect(await screen.findByLabelText(STR_AUTH.keyLabel)).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.body.textContent).not.toMatch(/subscription|Claude Code login|Connect Claude/i);
    expect(screen.getByText(STR_AUTH.noKey)).toBeTruthy();
  });

  it("saving a key goes through the sealed IPC path, then shows it masked and clears the field", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    const input = await screen.findByLabelText(STR_AUTH.keyLabel);
    expect((input as HTMLInputElement).type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect(await screen.findByText(STR_AUTH.savedKey("sk-ant-…abcd"))).toBeTruthy();
    expect(saveKey).toHaveBeenCalledWith(KEY);
    expect(calls.some(([c]) => c === "setApiKey")).toBe(false); // never the plaintext over the gateway bridge
    expect((screen.getByLabelText(STR_AUTH.keyLabel) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(KEY.slice(13, 40));
    expect(calls.some(([c]) => c === "setAuthMode")).toBe(false); // there is no mode to switch
  });

  it("a malformed key is refused before it leaves the page", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: "sk-ant-oat01-" + "x".repeat(50) } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect(await screen.findByText(STR_AUTH.badKeyFormat)).toBeTruthy();
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("Test connection with a typed key: \"Reached Anthropic ✓ — key rejected\"", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.testConnection }));
    expect(await screen.findByText(STR_AUTH.keyRejected)).toBeTruthy();
    expect(testKey).toHaveBeenCalledWith(KEY);
  });

  it("bug 281: with a saved key, Check runs the key check on the host (not an unmetered Test connection)", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    render(<AccountPanel />);
    await pickApiKey();
    expect(screen.queryByRole("button", { name: STR_AUTH.testConnection })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.check }));
    const result = await screen.findByRole("status");
    await vi.waitFor(() => expect(result.textContent).toContain(STR_AUTH.keyWorks));
    expect(calls).toContainEqual(["checkApiKey", { refresh: true }]);
    expect(calls.some(([c]) => c === "testAuthConnection")).toBe(false);
    const row = (label: string) => screen.getByText(label).closest("div")!.textContent;
    expect(row(STR_AUTH.rowModels)).toContain("Sonnet 5, Haiku 4.5");
    expect(row(STR_AUTH.rowLongContext)).toContain(STR_AUTH.available);
    expect(row(STR_AUTH.rowWebSearch)).toContain(STR_AUTH.on);
  });

  it("bug 281: the last check is shown when the panel opens", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    lastCheck = { ...checked, works: false, problem: { kind: "billing", title: STR_AUTH.billing, detail: STR_AUTH.billingDetail, status: 400 }, models: [], longContext: null, webSearch: false };
    render(<AccountPanel />);
    const result = await screen.findByRole("status");
    expect(result.textContent).toContain(STR_AUTH.billing);
    expect(result.textContent).toContain(STR_AUTH.billingDetail);
    expect(result.textContent).not.toContain(STR_AUTH.keyWorks);
    const row = (label: string) => screen.getByText(label).closest("div")!.textContent;
    expect(row(STR_AUTH.rowModels)).toContain(STR_AUTH.none);
    expect(row(STR_AUTH.rowLongContext)).toContain(STR_AUTH.unknown);
    expect(row(STR_AUTH.rowWebSearch)).toContain(STR_AUTH.off);
    expect(calls).toContainEqual(["checkApiKey", {}]);
  });

  it("bug 281: nothing checked yet shows no result", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    render(<AccountPanel />);
    await screen.findByRole("button", { name: STR_AUTH.check });
    await vi.waitFor(() => expect(calls).toContainEqual(["checkApiKey", {}]));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("bug 281: typing a replacement key offers Test connection for it", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.testConnection }));
    expect(await screen.findByText(STR_AUTH.keyRejected)).toBeTruthy();
    expect(testKey).toHaveBeenCalledWith(KEY);
  });

  it("removing the key leaves no sign-in: the panel asks for a key again (nothing falls back)", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    render(<AccountPanel />);
    expect(await screen.findByText(STR_AUTH.appliesNext)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.removeKey }));
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("clearApiKey"));
    expect(await screen.findByText(STR_AUTH.noKey)).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("review fix 4: a key saved on the box but not on this Mac says so", async () => {
    saveKey.mockImplementation(async () => { view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } }; return { ...view, macSaved: false, macError: "This Mac's permission key can't be trusted." }; });
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(STR_AUTH.macKeyNotSaved);
    expect(alert.textContent).toContain("permission key");
  });

  it("the API-key choice has Save, Test and a link to create a key in the Anthropic Console", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    expect(screen.getByRole("button", { name: STR_AUTH.saveKey })).toBeTruthy();
    expect(screen.getByRole("button", { name: STR_AUTH.testConnection })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: STR_AUTH.createKey }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: "https://console.anthropic.com/settings/keys" }]));
  });
});
