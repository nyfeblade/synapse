// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR_AUTH, type AuthView, type KeyCheckView } from "@synapse/shared";
import { AccountPanel } from "../../src/renderer/components/settings/AccountSection";

const KEY = "sk-ant-api03-" + "R".repeat(80) + "abcd";
const WRONG = "sk-ant-api03-wrong" + "R".repeat(80);
let view: AuthView;
const NOT_CHECKED: KeyCheckView = { checkedAt: null, checking: false, works: null, problem: null, model: null, models: [], longContext: null, webSearch: null };
let checked: KeyCheckView;
let lastCheck: KeyCheckView;
const calls: [string, unknown][] = [];
const saveKey = vi.fn();
const testKey = vi.fn();
let pinChanged = false;
let trustYes = true;
beforeEach(() => {
  calls.length = 0;
  pinChanged = false;
  trustYes = true;
  view = { apiKey: null, boxPublicKey: "PK" };
  lastCheck = NOT_CHECKED;
  checked = { checkedAt: 2, checking: false, works: true, problem: null, model: "claude-haiku-4-5-20251001", models: ["claude-sonnet-5", "claude-haiku-4-5-20251001"], longContext: true, webSearch: true };
  saveKey.mockReset().mockImplementation(async () => { view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } }; return view; });
  testKey.mockReset().mockImplementation(async (k: string) => (k === WRONG ? { ok: false, reached: true, kind: "invalid-key", status: 401, title: STR_AUTH.keyRejected, detail: STR_AUTH.keyRejectedDetail } : { ok: true, reached: true, kind: "ok", status: 200, title: STR_AUTH.ok, detail: "" }));
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: unknown) => {
      calls.push([c, a]);
      if (c === "clearApiKey") view = { ...view, apiKey: null };
      if (c === "testAuthConnection") return { ok: true, result: { ok: true, reached: true, kind: "ok", status: 200, title: STR_AUTH.ok, detail: "" } };
      if (c === "checkApiKey") return { ok: true, result: (a as { refresh?: boolean }).refresh ? (lastCheck = checked) : lastCheck };
      return { ok: true, result: view };
    }),
    auth: { saveKey, testKey, removeKey: vi.fn(async () => { calls.push(["clearApiKey", {}]); view = { ...view, apiKey: null }; return view; }), hasMacKey: vi.fn(async () => true), pinChanged: vi.fn(async () => pinChanged), trustComputer: vi.fn(async () => { calls.push(["trust", {}]); if (!trustYes) return { trusted: false }; pinChanged = false; return { trusted: true }; }) },
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

  it("Test connection with a typed key: \"Key rejected\"", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: WRONG } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.testConnection }));
    expect(await screen.findByText(STR_AUTH.keyRejected)).toBeTruthy();
    expect(testKey).toHaveBeenCalledWith(WRONG);
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
    fireEvent.change(await screen.findByLabelText(STR_AUTH.keyLabel), { target: { value: WRONG } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.testConnection }));
    expect(await screen.findByText(STR_AUTH.keyRejected)).toBeTruthy();
    expect(testKey).toHaveBeenCalledWith(WRONG);
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

  // A rejected sign-in must never do nothing: every failure is a plain line where the user is looking, and the
  // button is usable again.
  const typeKey = async () => {
    await pickApiKey();
    fireEvent.change(screen.getByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
  };

  it("Save refused by the host: the reason shows, without Electron's IPC wrapper, and Save works again", async () => {
    saveKey.mockRejectedValue(new Error("Error invoking remote method 'auth:save-key': Error: Synapse is running in another account on this Mac and is using this account's connection. Quit Synapse there, then retry."));
    render(<AccountPanel />);
    await typeKey();
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Synapse is running in another account on this Mac/);
    expect((screen.getByRole("button", { name: STR_AUTH.saveKey }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save that is slow shows a plain line, but keeps Save and Remove off until main's call settles", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    let finish!: (v: unknown) => void;
    saveKey.mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<AccountPanel timeoutMs={40} />);
    await typeKey();
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.replaceKey }));
    expect((await screen.findByRole("alert")).textContent).toBe(STR.hostTimeout);
    // A late Save could still land: nothing else may be pressed until it does (a Remove would be undone).
    expect((screen.getByRole("button", { name: STR_AUTH.replaceKey }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: STR_AUTH.removeKey }) as HTMLButtonElement).disabled).toBe(true);
    finish({ apiKey: { masked: "sk-ant-…wxyz", savedAt: 2 }, boxPublicKey: "PK", macSaved: true });
    expect(await screen.findByText(STR_AUTH.savedKey("sk-ant-…wxyz"))).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: STR_AUTH.removeKey }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save that answers without a saved key says it wasn't saved (never a silent no-op)", async () => {
    saveKey.mockResolvedValue({ apiKey: null, boxPublicKey: "PK", macSaved: false });
    const onReady = vi.fn();
    render(<AccountPanel onReady={onReady} />);
    await typeKey();
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect((await screen.findByRole("alert")).textContent).toBe(STR_AUTH.keyNotSaved);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("Test connection that fails to reach the host shows why", async () => {
    testKey.mockRejectedValue(new Error("Error invoking remote method 'auth:test-key': Error: The Bots' computer didn't answer. Try again."));
    render(<AccountPanel />);
    await typeKey();
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.testConnection }));
    expect((await screen.findByRole("alert")).textContent).toBe(STR.hostNoAnswer);
  });

  it("Check that fails shows why, and Check works again", async () => {
    view = { ...view, apiKey: { masked: "sk-ant-…abcd", savedAt: 1 } };
    const base = (window as unknown as { synapse: { call: (c: string, a: unknown) => Promise<unknown> } }).synapse.call;
    (window as unknown as { synapse: { call: unknown } }).synapse.call = async (c: string, a: unknown) =>
      c === "checkApiKey" && (a as { refresh?: boolean }).refresh ? { ok: false, error: { code: "NETWORK", message: STR.hostNoAnswer } } : base(c, a);
    render(<AccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.check }));
    expect((await screen.findByRole("alert")).textContent).toBe(STR.hostNoAnswer);
    expect((screen.getByRole("button", { name: STR_AUTH.check }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a panel whose first load never answers says so instead of Loading… forever", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = () => new Promise(() => {});
    render(<AccountPanel timeoutMs={40} />);
    expect((await screen.findByRole("alert")).textContent).toBe(STR.hostTimeout);
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

describe("new-user walk finding 2: a changed Bots' computer is trusted right here, not in a section that doesn't exist", () => {
  it("a save refused for a changed identity offers Trust this computer; trusting never sends the key — Save does, again", async () => {
    saveKey.mockImplementationOnce(async () => { throw new Error(`Error invoking remote method 'auth:save-key': Error: ${STR_AUTH.pinMismatch}`); });
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(screen.getByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    const trust = await screen.findByRole("button", { name: STR_AUTH.trustComputer });
    expect(document.body.textContent).not.toMatch(/Settings → Updates/);
    fireEvent.click(trust);
    expect(await screen.findByText(STR_AUTH.trusted)).toBeTruthy();
    expect(calls.map((c) => c[0])).toContain("trust");
    expect(saveKey).toHaveBeenCalledTimes(1); // review: no chained save
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    await screen.findByText(STR_AUTH.savedKey("sk-ant-…abcd"));
    expect(saveKey).toHaveBeenCalledTimes(2);
  });

  it("Cancel in the main-process dialog leaves the Trust button and saves nothing", async () => {
    trustYes = false;
    pinChanged = true;
    render(<AccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.trustComputer }));
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toContain("trust"));
    expect(screen.getByRole("button", { name: STR_AUTH.trustComputer })).toBeTruthy();
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("opening the panel with a changed identity shows the Trust button straight away", async () => {
    pinChanged = true;
    render(<AccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.trustComputer }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: STR_AUTH.trustComputer })).toBeNull());
    expect(calls.map((c) => c[0])).toContain("trust");
  });
});

describe("new-user walk finding 9: a rejected key says so plainly, and Save checks the key first", () => {
  it("the rejected line has no check mark", () => {
    expect(STR_AUTH.keyRejected).not.toMatch(/✓/);
    expect(STR_AUTH.ok).not.toMatch(/✓/);
  });

  it("Save refuses a key Anthropic rejects, before it is saved", async () => {
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(screen.getByLabelText(STR_AUTH.keyLabel), { target: { value: WRONG } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    expect((await screen.findByRole("alert")).textContent).toContain(STR_AUTH.keyRejected);
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("Save goes ahead when Anthropic can't be reached (a check that can't answer never blocks)", async () => {
    testKey.mockResolvedValue({ ok: false, reached: false, kind: "network", status: null, title: STR_AUTH.network, detail: "" });
    render(<AccountPanel />);
    await pickApiKey();
    fireEvent.change(screen.getByLabelText(STR_AUTH.keyLabel), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: STR_AUTH.saveKey }));
    await vi.waitFor(() => expect(saveKey).toHaveBeenCalled());
  });
});
